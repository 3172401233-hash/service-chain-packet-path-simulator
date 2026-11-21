import { CT_STATE, DROP, MARK } from "../constants.js";
import { SimDrop } from "../errors.js";
import { ipInCidr } from "../tuple.js";
import { nextEphemeralPort } from "./common.js";

function matchNATRule(rule, packet) {
  if (rule.matchSrc && !ipInCidr(packet.tuple.srcIp, rule.matchSrc)) {
    return false;
  }
  if (rule.matchDst && !ipInCidr(packet.tuple.dstIp, rule.matchDst)) {
    return false;
  }
  if (rule.matchPort !== undefined && rule.matchPort !== packet.tuple.dstPort) {
    return false;
  }
  if (rule.protocol && rule.protocol !== packet.tuple.protocol) {
    return false;
  }
  return true;
}

/**
 * NAT 网关按顺序应用 dnatRules / snatRules。
 * 每条命中的规则生成一条 conntrack 表项，回程逐条反向还原。
 */
export function createNATHandler(config, context) {
  const table = context.tableFor(config.id);

  return {
    node: config,
    isStateful: true,
    endpoint: false,
    async request(packet) {
      const changes = [];
      const tupleBeforeAll = { ...packet.tuple };
      const existing = table.get(packet.tuple);
      if (existing) {
        table.lookup(packet.tuple, packet.now);
        table.touch(existing, packet.now, CT_STATE.ESTABLISHED);
        packet.tuple = { ...existing.tupleAfter };
        return { action: "forward", changes, entry: existing };
      }

      const establishedSNAT = table.entries().find(
        (entry) =>
          entry.meta.kind === "snat" &&
          entry.state === CT_STATE.ESTABLISHED &&
          entry.tupleBefore.srcIp === packet.tuple.srcIp &&
          entry.tupleBefore.srcPort === packet.tuple.srcPort,
      );
      if (establishedSNAT) {
        table.lookup({ ...establishedSNAT.tupleAfter }, packet.now);
        packet.tuple.srcIp = establishedSNAT.tupleAfter.srcIp;
        packet.tuple.srcPort = establishedSNAT.tupleAfter.srcPort;
        table.touch(establishedSNAT, packet.now, CT_STATE.ESTABLISHED);
        return { action: "forward", changes, entry: establishedSNAT };
      }

      const applied = [];

      for (const rule of config.dnatRules ?? []) {
        if (!matchNATRule(rule, packet)) {
          continue;
        }
        const before = { ...packet.tuple };
        packet.tuple.dstIp = rule.toIp;
        if (rule.toPort !== undefined) {
          packet.tuple.dstPort = rule.toPort;
        }
        const entry = table.add({
          tupleBefore: before,
          tupleAfter: { ...packet.tuple },
          ttl: config.ttl ?? context.defaultTtl,
          now: packet.now,
          state: packet.flags.syn ? CT_STATE.NEW : CT_STATE.ESTABLISHED,
          meta: { kind: "dnat", ruleId: rule.id },
        });
        applied.push(entry);
        packet.addMark(MARK.DNAT);
        changes.push({ type: "dnat", field: "dstIp", from: before.dstIp, to: packet.tuple.dstIp });
        if (before.dstPort !== packet.tuple.dstPort) {
          changes.push({ type: "dnat", field: "dstPort", from: before.dstPort, to: packet.tuple.dstPort });
        }
      }

      for (const rule of config.snatRules ?? []) {
        if (!matchNATRule(rule, packet)) {
          continue;
        }
        const before = { ...packet.tuple };
        packet.tuple.srcIp = rule.toIp;
        if (rule.toPort === "masquerade") {
          const port = nextEphemeralPort(context.allocations, config.id, context.portRange);
          if (port > context.portRange.end) {
            throw new SimDrop(DROP.PORT_CONFLICT, `${config.id} SNAT 临时端口段已耗尽`);
          }
          packet.tuple.srcPort = port;
        } else if (rule.toPort !== undefined) {
          packet.tuple.srcPort = rule.toPort;
        }
        const entry = table.add({
          tupleBefore: before,
          tupleAfter: { ...packet.tuple },
          ttl: config.ttl ?? context.defaultTtl,
          now: packet.now,
          state: packet.flags.syn ? CT_STATE.NEW : CT_STATE.ESTABLISHED,
          meta: { kind: "snat", ruleId: rule.id },
        });
        applied.push(entry);
        packet.addMark(MARK.SNAT);
        changes.push({ type: "snat", field: "srcIp", from: before.srcIp, to: packet.tuple.srcIp });
        if (before.srcPort !== packet.tuple.srcPort) {
          changes.push({ type: "snat", field: "srcPort", from: before.srcPort, to: packet.tuple.srcPort });
        }
      }

      if (changes.length === 0 && (config.dnatRules?.length || config.snatRules?.length)) {
        throw new SimDrop(DROP.NAT_NO_RULE, `${config.id} 上没有规则命中 ${tupleBeforeAll.dstIp}:${tupleBeforeAll.dstPort}`);
      }
      return { action: "forward", changes, entries: applied };
    },

    async response(packet) {
      const changes = [];
      let entry = table.get(packet.tuple);
      let guard = 0;

      while (entry && guard <= table.entries().length + 1) {
        table.lookup(packet.tuple, packet.now);
        if (entry.meta.kind === "snat") {
          const before = { ...packet.tuple };
          packet.tuple.dstIp = entry.tupleBefore.srcIp;
          packet.tuple.dstPort = entry.tupleBefore.srcPort;
          changes.push({ type: "un-snat", field: "dstIp", from: before.dstIp, to: packet.tuple.dstIp });
          if (before.dstPort !== packet.tuple.dstPort) {
            changes.push({ type: "un-snat", field: "dstPort", from: before.dstPort, to: packet.tuple.dstPort });
          }
        } else {
          const before = { ...packet.tuple };
          packet.tuple.srcIp = entry.tupleBefore.dstIp;
          packet.tuple.srcPort = entry.tupleBefore.dstPort;
          changes.push({ type: "un-dnat", field: "srcIp", from: before.srcIp, to: packet.tuple.srcIp });
          if (before.srcPort !== packet.tuple.srcPort) {
            changes.push({ type: "un-dnat", field: "srcPort", from: before.srcPort, to: packet.tuple.srcPort });
          }
        }
        table.touch(entry, packet.now, CT_STATE.ESTABLISHED);
        entry = table.get(packet.tuple);
        guard += 1;
      }

      if (changes.length === 0) {
        table.lookup(packet.tuple, packet.now);
      }
      return { action: "reverse", changes };
    },
  };
}
