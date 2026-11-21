import { CT_STATE, DROP, MARK } from "../constants.js";
import { SimDrop } from "../errors.js";
import { reverseTuple, tupleKey } from "../tuple.js";

/**
 * 透明代理终结客户端连接，再以代理自身地址向上游发起连接。
 *
 * 元组契约（记 C=客户端、P=代理监听、U=上游）：
 *   客户端侧表 tupleBefore = C->原始目的，tupleAfter = C->P
 *   上游侧表   tupleBefore = P->U，     tupleAfter = P->U
 * 回程先把 U->P 反向成 P->C 形态命中客户端表，再还原成 原始目的->C。
 */
export function createProxyHandler(config, context) {
  const clientTable = context.tableFor(`${config.id}:client`);
  const upstreamTable = context.tableFor(`${config.id}:upstream`);
  let upstreamCursor = 0;

  function chooseUpstream(packet) {
    const healthy = config.upstreams.filter((upstream) => context.health.isHealthy(upstream.id));
    if (healthy.length === 0) {
      throw new SimDrop(DROP.LB_NO_HEALTHY_BACKEND, `${config.id} 无健康上游`);
    }
    healthy.forEach((upstream) => context.health.assertConsistent(upstream.id, config.id));
    const upstream = healthy[upstreamCursor % healthy.length];
    upstreamCursor += 1;
    return upstream;
  }

  function createUpstreamEntry(packet, upstream) {
    const tupleValue = {
      protocol: packet.tuple.protocol,
      srcIp: config.ip,
      srcPort: config.listenPort,
      dstIp: upstream.ip,
      dstPort: upstream.port,
    };
    return upstreamTable.add({
      tupleBefore: tupleValue,
      tupleAfter: { ...tupleValue },
      ttl: config.ttl ?? context.defaultTtl,
      now: packet.now,
      state: packet.flags.syn ? CT_STATE.NEW : CT_STATE.ESTABLISHED,
      meta: {
        kind: "proxy-upstream",
        proxyId: config.id,
        upstreamId: upstream.id,
        reuseCount: 0,
        maxReuse: config.maxReuse ?? 1,
        clientFlows: [],
      },
    });
  }

  function reusableUpstreams() {
    return upstreamTable
      .entries()
      .filter((entry) => entry.state === CT_STATE.ESTABLISHED && entry.meta.reuseCount < entry.meta.maxReuse);
  }

  function saturatedUpstreams() {
    return upstreamTable
      .entries()
      .filter((entry) => entry.state === CT_STATE.ESTABLISHED && entry.meta.reuseCount >= entry.meta.maxReuse);
  }

  function findClientEntryByUpstream(upstreamEntry) {
    for (const entry of clientTable.entries()) {
      if (entry.meta.upstreamKey === upstreamEntry.key) {
        return entry;
      }
    }
    return null;
  }

  return {
    node: config,
    isStateful: true,
    endpoint: false,
    tables: [clientTable, upstreamTable],

    async request(packet) {
      const changes = [];
      const existing = clientTable.get(packet.tuple);
      if (existing) {
        clientTable.lookup(packet.tuple, packet.now);
        const upstreamEntry = upstreamTable.entries().find((item) => item.key === existing.meta.upstreamKey);
        packet.tuple = { ...upstreamEntry.tupleAfter };
        clientTable.touch(existing, packet.now, CT_STATE.ESTABLISHED);
        return { action: "forward", changes, entry: existing, upstreamEntry };
      }

      const policy = config.reusePolicy ?? "after-established";
      const candidate = reusableUpstreams()[0];

      if (candidate && policy === "after-established" && packet.flags.syn) {
        throw new SimDrop(
          DROP.PROXY_EARLY_REUSE,
          `${config.id} 在上游连接 ${candidate.key} 上承载尚未建立的新客户端流 ${tupleKey(packet.tuple)}`,
        );
      }
      if (candidate && candidate.meta.reuseCount >= candidate.meta.maxReuse) {
        throw new SimDrop(DROP.PROXY_REUSE_LIMIT, `${config.id} 上游连接复用次数已达上限 ${candidate.meta.maxReuse}`);
      }
      if (!candidate && saturatedUpstreams().length > 0 && config.reuseMode === "sticky") {
        throw new SimDrop(
          DROP.PROXY_REUSE_LIMIT,
          `${config.id} 所有上游连接复用次数均已达上限，且 sticky 模式不允许新建连接`,
        );
      }

      const tupleBeforeClient = { ...packet.tuple };
      if (candidate && candidate.meta.reuseCount >= candidate.meta.maxReuse) {
        throw new SimDrop(
          DROP.PROXY_REUSE_LIMIT,
          `${config.id} 上游连接 ${candidate.key} 复用次数已达上限 ${candidate.meta.maxReuse}`,
        );
      }
      const upstream = candidate
        ? config.upstreams.find((item) => item.id === candidate.meta.upstreamId)
        : chooseUpstream(packet);
      const upstreamEntry = candidate ?? createUpstreamEntry(packet, upstream);

      const tupleAfterClient = {
        protocol: packet.tuple.protocol,
        srcIp: tupleBeforeClient.srcIp,
        srcPort: tupleBeforeClient.srcPort,
        dstIp: config.ip,
        dstPort: config.listenPort,
      };

      const clientEntry = clientTable.add({
        tupleBefore: tupleBeforeClient,
        tupleAfter: tupleAfterClient,
        ttl: config.ttl ?? context.defaultTtl,
        now: packet.now,
        state: packet.flags.syn ? CT_STATE.NEW : CT_STATE.ESTABLISHED,
        meta: {
          kind: "proxy-client",
          proxyId: config.id,
          upstreamKey: upstreamEntry.key,
          originalDstIp: tupleBeforeClient.dstIp,
          originalDstPort: tupleBeforeClient.dstPort,
        },
      });

      upstreamEntry.meta.reuseCount += 1;
      upstreamEntry.meta.clientFlows.push(clientEntry.key);
      upstreamTable.touch(upstreamEntry, packet.now, CT_STATE.ESTABLISHED);

      packet.tuple = { ...upstreamEntry.tupleAfter };
      packet.target = { id: upstream.id, ip: upstream.ip };
      packet.addMark(MARK.PROXY);
      if (upstreamEntry.meta.reuseCount > 1) {
        packet.addMark(MARK.PROXY_REUSED);
      }

      changes.push({
        type: "proxy-terminate",
        field: "tuple",
        from: { ...tupleBeforeClient },
        to: { ...packet.tuple },
        reuseCount: upstreamEntry.meta.reuseCount,
      });
      return { action: "forward", changes, entry: clientEntry, upstreamEntry };
    },

    async response(packet) {
      const changes = [];
      const upstreamEntry = upstreamTable.lookup(packet.tuple, packet.now);
      const clientEntry = findClientEntryByUpstream(upstreamEntry);
      if (!clientEntry) {
        throw new SimDrop(DROP.CT_MISSING, `${config.id} 上游连接 ${upstreamEntry.key} 无关联客户端流`);
      }
      clientTable.lookup(reverseTuple(clientEntry.tupleAfter), packet.now);

      const beforeUpstream = { ...packet.tuple };
      const intermediate = reverseTuple(clientEntry.tupleAfter);
      packet.tuple = { ...intermediate };
      changes.push({
        type: "proxy-un-upstream",
        field: "tuple",
        from: beforeUpstream,
        to: { ...packet.tuple },
      });
      upstreamTable.touch(upstreamEntry, packet.now, CT_STATE.ESTABLISHED);

      const beforeClient = { ...packet.tuple };
      packet.tuple = {
        protocol: packet.tuple.protocol,
        srcIp: clientEntry.meta.originalDstIp,
        srcPort: clientEntry.meta.originalDstPort,
        dstIp: clientEntry.tupleBefore.srcIp,
        dstPort: clientEntry.tupleBefore.srcPort,
      };
      changes.push({
        type: "proxy-un-client",
        field: "tuple",
        from: beforeClient,
        to: { ...packet.tuple },
      });
      clientTable.touch(clientEntry, packet.now, CT_STATE.ESTABLISHED);
      return { action: "reverse", changes, entry: clientEntry, upstreamEntry };
    },
  };
}
