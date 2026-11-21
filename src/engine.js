import { CT_STATE, DROP, PHASE } from "./constants.js";
import { ConntrackTable } from "./conntrack.js";
import { SimDrop } from "./errors.js";
import { HealthRegistry } from "./health.js";
import { Packet } from "./packet.js";
import { createClientHandler } from "./nodes/client.js";
import { createLoadBalancerHandler } from "./nodes/loadBalancer.js";
import { createNATHandler } from "./nodes/nat.js";
import { createProxyHandler } from "./nodes/proxy.js";
import { createServiceHandler } from "./nodes/service.js";
import { ipInCidr, tupleKey } from "./tuple.js";

const DEFAULT_PORT_RANGE = Object.freeze({ start: 30000, end: 39999 });

function createHandler(node, context) {
  switch (node.type) {
    case "client":
      return createClientHandler(node);
    case "loadbalancer":
      return createLoadBalancerHandler(node, context);
    case "nat":
      return createNATHandler(node, context);
    case "proxy":
      return createProxyHandler(node, context);
    case "service":
      return createServiceHandler(node);
    default:
      throw new Error(`未知节点类型: ${node.type}`);
  }
}

export class Simulator {
  constructor(config) {
    this.config = config;
    this.health = new HealthRegistry();
    for (const observation of config.healthObservations ?? []) {
      this.health.observe(observation.backendId, observation.source, observation.healthy);
    }
    this.tables = new Map();
    this.allocations = new Map();
    this.portRange = config.portRange ?? DEFAULT_PORT_RANGE;
    this.defaultTtl = config.defaultTtl ?? 30000;
    this.handlers = new Map();
    for (const node of config.nodes) {
      this.handlers.set(node.id, createHandler(node, this));
    }
  }

  tableFor(zone) {
    if (!this.tables.has(zone)) {
      this.tables.set(zone, new ConntrackTable(zone));
    }
    return this.tables.get(zone);
  }

  node(id) {
    const handler = this.handlers.get(id);
    if (!handler) {
      throw new Error(`配置中不存在节点: ${id}`);
    }
    return handler;
  }

  route(handler, phase, packet) {
    const routes = handler.node.routes ?? {};
    const table = phase === PHASE.REQUEST ? routes.request : routes.response;
    if (!table || table.length === 0) {
      return null;
    }
    const destinationIp = packet.tuple.dstIp;
    for (const route of table) {
      if (ipInCidr(destinationIp, route.cidr)) {
        return route.next;
      }
    }
    return null;
  }

  recordHop(trace, { phase, seq, nodeId, packet, before, action, changes, connKey, entry, state, drop }) {
    trace.push({
      phase,
      seq,
      nodeId,
      action,
      before: {
        tuple: before.tuple,
        marks: [...before.marks],
        target: before.target,
        connKey: tupleKey(before.tuple),
      },
      after: {
        tuple: { ...packet.tuple },
        marks: [...packet.marks],
        target: packet.target,
        connKey: tupleKey(packet.tuple),
      },
      changes: changes ?? [],
      connKey: connKey ?? tupleKey(before.tuple),
      entry: entry
        ? {
            id: entry.id,
            zone: entry.zone,
            key: entry.key,
            reverseKey: entry.reverseKey,
            state: state ?? entry.state,
            ttl: entry.ttl,
            expiresAt: entry.expiresAt,
          }
        : null,
      drop: drop ?? null,
    });
  }

  async runPhase(packet, { phase, startNodeId, statefulStack, overrides }) {
    const trace = [];
    const maxHops = this.config.nodes.length * 2 + 4;
    let currentId = startNodeId;
    let seq = 0;
    const visited = new Set();

    while (seq < maxHops) {
      const handler = this.node(currentId);
      const before = packet.snapshot();
      seq += 1;

      if (
        phase === PHASE.RESPONSE &&
        handler.node.type === "client" &&
        statefulStack.length > 0
      ) {
        const drop = {
          reason: DROP.ASYMMETRIC_PATH,
          detail: `响应直达 client，但仍有有状态节点未按原路回退: ${statefulStack.join(", ")}`,
        };
        this.recordHop(trace, { phase, seq, nodeId: currentId, packet, before, action: "drop", drop });
        return { trace, drop, terminatedAt: currentId };
      }

      if (phase === PHASE.RESPONSE && handler.isStateful) {
        const expected = statefulStack[statefulStack.length - 1];
        if (expected !== currentId) {
          const drop = {
            reason: DROP.ASYMMETRIC_PATH,
            detail: `回程到达 ${currentId}，但按原路应先经过有状态节点 ${expected}`,
          };
          this.recordHop(trace, { phase, seq, nodeId: currentId, packet, before, action: "drop", drop });
          return { trace, drop, terminatedAt: currentId };
        }
      }

      try {
        const result =
          phase === PHASE.REQUEST ? await handler.request(packet, this) : await handler.response(packet, this);
        const entry = result.entry ?? null;
        this.recordHop(trace, {
          phase,
          seq,
          nodeId: currentId,
          packet,
          before,
          action: result.action,
          changes: result.changes,
          entry,
        });

        if (phase === PHASE.REQUEST && handler.isStateful) {
          statefulStack.push(currentId);
        }
        if (phase === PHASE.RESPONSE && handler.isStateful) {
          statefulStack.pop();
        }

        const isTerminal =
          (phase === PHASE.REQUEST && handler.node.type === "service") ||
          (phase === PHASE.RESPONSE && handler.node.type === "client");
        if (handler.endpoint && isTerminal) {
          return { trace, drop: null, terminatedAt: currentId };
        }

        const override = phase === PHASE.RESPONSE ? overrides?.[currentId] : null;
        const nextId = override ?? this.route(handler, phase, packet);
        if (!nextId) {
          const drop = { reason: DROP.NO_ROUTE, detail: `${currentId} 无法路由到 ${packet.tuple.dstIp}` };
          this.recordHop(trace, { phase, seq: seq + 1, nodeId: currentId, packet, before: packet.snapshot(), action: "drop", drop });
          return { trace, drop, terminatedAt: currentId };
        }

        const loopKey = `${currentId}->${nextId}:${packet.tuple.dstIp}:${packet.tuple.dstPort}`;
        if (visited.has(loopKey)) {
          const drop = { reason: DROP.LOOP, detail: `链路在 ${currentId} -> ${nextId} 之间成环` };
          this.recordHop(trace, { phase, seq: seq + 1, nodeId: currentId, packet, before: packet.snapshot(), action: "drop", drop });
          return { trace, drop, terminatedAt: currentId };
        }
        visited.add(loopKey);
        currentId = nextId;
      } catch (error) {
        const drop =
          error instanceof SimDrop
            ? { reason: error.reason, detail: error.detail }
            : { reason: DROP.NO_ROUTE, detail: error.message };
        this.recordHop(trace, { phase, seq, nodeId: currentId, packet, before, action: "drop", drop });
        return { trace, drop, terminatedAt: currentId };
      }
    }

    const drop = { reason: DROP.LOOP, detail: `超过最大跳数 ${maxHops}` };
    this.recordHop(trace, { phase, seq: seq + 1, nodeId: currentId, packet, before: packet.snapshot(), action: "drop", drop });
    return { trace, drop, terminatedAt: currentId };
  }

  async simulate(exchanges) {
    const list = Array.isArray(exchanges) ? exchanges : [exchanges];
    const results = [];

    for (const exchange of list) {
      const clientHandler = this.node(exchange.clientNodeId);
      const initialTuple = {
        protocol: exchange.protocol ?? "tcp",
        srcIp: clientHandler.node.ip,
        srcPort: exchange.clientPort,
        dstIp: exchange.dstIp,
        dstPort: exchange.dstPort,
      };
      const packet = Packet.request(initialTuple, {
        marks: exchange.marks ?? [],
        exchangeId: exchange.id ?? results.length + 1,
        flags: exchange.flags ?? { syn: true, ack: false },
        now: exchange.requestAt ?? 0,
      });

      const statefulStack = [];
      const request = await this.runPhase(packet, {
        phase: PHASE.REQUEST,
        startNodeId: exchange.clientNodeId,
        statefulStack,
      });

      let response = null;
      if (!request.drop) {
        const reply = Packet.response(packet, exchange.responseAt ?? (packet.now + (this.config.responseDelay ?? 10)));
        response = await this.runPhase(reply, {
          phase: PHASE.RESPONSE,
          startNodeId: request.terminatedAt,
          statefulStack,
          overrides: exchange.responseOverrides,
        });
      }

      results.push({
        exchangeId: packet.exchangeId,
        request: request.trace,
        response: response?.trace ?? [],
        dropped: Boolean(request.drop ?? response?.drop),
        drop: request.drop ?? response?.drop ?? null,
        finalTuple: response ? { ...response.trace.at(-1).after.tuple } : null,
        statefulStack,
      });
    }

    return {
      results,
      conntrack: this.dumpConntrack(),
      health: this.health.snapshot(),
      dropped: results.some((result) => result.dropped),
    };
  }

  dumpConntrack() {
    const dump = {};
    for (const [zone, table] of this.tables) {
      dump[zone] = table.entries().map((entry) => ({
        key: entry.key,
        reverseKey: entry.reverseKey,
        state: entry.state,
        tupleBefore: entry.tupleBefore,
        tupleAfter: entry.tupleAfter,
        createdAt: entry.createdAt,
        lastUsed: entry.lastUsed,
        expiresAt: entry.expiresAt,
        ttl: entry.ttl,
        meta: entry.meta,
      }));
    }
    return dump;
  }
}

export function simulate(config, exchanges) {
  return new Simulator(config).simulate(exchanges);
}

export { CT_STATE };
