import { CT_STATE, DROP, MARK } from "../constants.js";
import { SimDrop } from "../errors.js";
import { nextEphemeralPort } from "./common.js";

function matchRule(rule, packet) {
  if (rule.vip !== packet.tuple.dstIp) {
    return false;
  }
  if (rule.vipPort !== undefined && rule.vipPort !== packet.tuple.dstPort) {
    return false;
  }
  if (rule.protocol && rule.protocol !== packet.tuple.protocol) {
    return false;
  }
  return true;
}

/**
 * 四层 LB：规则匹配 -> 健康后端选择 -> DNAT。
 * hairpin 模式下同时做源地址伪装，回程在同一节点先反向还原 SNAT 再反向 DNAT。
 */
export function createLoadBalancerHandler(config, context) {
  const table = context.tableFor(config.id);
  const rrCursor = new Map();

  function selectBackend(rule, packet) {
    rule.backends.forEach((backend) => context.health.assertConsistent(backend.id, config.id));
    const healthy = rule.backends.filter((backend) => context.health.isHealthy(backend.id));
    if (healthy.length === 0) {
      throw new SimDrop(DROP.LB_NO_HEALTHY_BACKEND, `${config.id} 规则 ${rule.vip}:${rule.vipPort} 无可用后端`);
    }
    if (rule.mode === "static") {
      return healthy[0];
    }
    const ruleKey = `${rule.vip}:${rule.vipPort}`;
    const index = rrCursor.get(ruleKey) ?? 0;
    const backend = healthy[index % healthy.length];
    rrCursor.set(ruleKey, index + 1);
    return backend;
  }

  return {
    node: config,
    isStateful: true,
    endpoint: false,
    async request(packet) {
      const changes = [];
      const existing = table.get(packet.tuple);
      if (existing) {
        table.lookup(packet.tuple, packet.now);
        const chosenId = existing.meta.backendId;
        if (packet.target && packet.target.id !== chosenId) {
          throw new SimDrop(
            DROP.BACKEND_SWITCH,
            `流已绑定后端 ${chosenId}，当前却被送往 ${packet.target.id}`,
          );
        }
        packet.tuple = { ...existing.tupleAfter };
        packet.target = { id: chosenId, ip: existing.tupleAfter.dstIp };
        table.touch(existing, packet.now, CT_STATE.ESTABLISHED);
        return { action: "forward", changes, entry: existing };
      }

      const rule = config.rules.find((candidate) => matchRule(candidate, packet));
      if (!rule) {
        throw new SimDrop(DROP.LB_NO_RULE, `${config.id} 无匹配 ${packet.tuple.dstIp}:${packet.tuple.dstPort}`);
      }
      const backend = selectBackend(rule, packet);
      const tupleBefore = { ...packet.tuple };
      const tupleAfter = { ...packet.tuple, dstIp: backend.ip };
      if (rule.targetPort !== undefined) {
        tupleAfter.dstPort = rule.targetPort;
      }

      if (config.hairpin) {
        const port = nextEphemeralPort(context.allocations, config.id, context.portRange);
        if (port > context.portRange.end) {
          throw new SimDrop(DROP.PORT_CONFLICT, `${config.id} hairpin 临时端口段已耗尽`);
        }
        tupleAfter.srcIp = config.masqueradeIp ?? config.ip;
        tupleAfter.srcPort = port;
        packet.addMark(MARK.HAIRPIN);
      }

      const entry = table.add({
        tupleBefore,
        tupleAfter,
        ttl: config.ttl ?? context.defaultTtl,
        now: packet.now,
        state: packet.flags.syn ? CT_STATE.NEW : CT_STATE.ESTABLISHED,
        meta: {
          kind: "lb",
          ruleId: rule.id,
          backendId: backend.id,
          hairpin: Boolean(config.hairpin),
          backendIpAtCreate: backend.ip,
        },
      });

      packet.tuple = tupleAfter;
      packet.target = { id: backend.id, ip: backend.ip };
      packet.addMark(MARK.DNAT);
      changes.push({ type: "dnat", field: "dstIp", from: tupleBefore.dstIp, to: backend.ip });
      if (tupleBefore.dstPort !== tupleAfter.dstPort) {
        changes.push({ type: "dnat", field: "dstPort", from: tupleBefore.dstPort, to: tupleAfter.dstPort });
      }
      if (config.hairpin) {
        changes.push({ type: "snat", field: "srcIp", from: tupleBefore.srcIp, to: tupleAfter.srcIp });
        changes.push({ type: "snat", field: "srcPort", from: tupleBefore.srcPort, to: tupleAfter.srcPort });
      }
      return { action: "forward", changes, entry };
    },

    async response(packet) {
      const changes = [];
      const entry = table.lookup(packet.tuple, packet.now);

      const restored = { ...packet.tuple };
      if (entry.meta.hairpin) {
        restored.dstIp = entry.tupleBefore.srcIp;
        restored.dstPort = entry.tupleBefore.srcPort;
        changes.push({ type: "un-snat", field: "dstIp", from: packet.tuple.dstIp, to: restored.dstIp });
        changes.push({ type: "un-snat", field: "dstPort", from: packet.tuple.dstPort, to: restored.dstPort });
      }
      restored.srcIp = entry.tupleBefore.dstIp;
      restored.srcPort = entry.tupleBefore.dstPort;
      changes.push({ type: "un-dnat", field: "srcIp", from: packet.tuple.srcIp, to: restored.srcIp });
      if (packet.tuple.srcPort !== restored.srcPort) {
        changes.push({ type: "un-dnat", field: "srcPort", from: packet.tuple.srcPort, to: restored.srcPort });
      }

      packet.tuple = restored;
      table.touch(entry, packet.now, CT_STATE.ESTABLISHED);
      return { action: "reverse", changes, entry };
    },
  };
}
