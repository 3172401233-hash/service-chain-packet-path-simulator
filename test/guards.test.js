import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DROP } from "../src/index.js";
import { buildTopology, dropOf, exchange } from "./helpers.js";

describe("两侧健康检查不一致", () => {
  it("LB 认为后端健康但网关认为不健康时，在转发前丢弃并报告冲突来源", async () => {
    const { simulator } = buildTopology({
      lbMode: "static",
      healthObservations: [
        { backendId: "svc-a", source: "lb", healthy: true },
        { backendId: "svc-a", source: "nat", healthy: false },
        { backendId: "svc-b", source: "lb", healthy: true },
      ],
    });
    const result = await simulator.simulate(exchange());
    assert.equal(result.dropped, true);
    assert.equal(dropOf(result).reason, DROP.HEALTH_INCONSISTENT);
    assert.ok(dropOf(result).detail.includes("lb=healthy"));
    assert.ok(dropOf(result).detail.includes("nat=unhealthy"));
  });

  it("所有观察方都认为不健康时，报无健康后端而非不一致", async () => {
    const { simulator } = buildTopology({
      lbMode: "static",
      healthObservations: [
        { backendId: "svc-a", source: "lb", healthy: false },
        { backendId: "svc-a", source: "nat", healthy: false },
        { backendId: "svc-b", source: "lb", healthy: false },
      ],
    });
    const result = await simulator.simulate(exchange());
    assert.equal(dropOf(result).reason, DROP.LB_NO_HEALTHY_BACKEND);
  });
});

describe("原路返回缺失", () => {
  it("回程路由跳过有状态 NAT 节点直达客户端时，判非对称路径丢弃", async () => {
    const { simulator } = buildTopology({ lbMode: "static" });
    const result = await simulator.simulate(
      exchange({
        responseOverrides: {
          "service-a": "client",
        },
      }),
    );
    assert.equal(result.dropped, true);
    assert.equal(dropOf(result).reason, DROP.ASYMMETRIC_PATH);
  });

  it("正常对称回程不触发任何丢弃", async () => {
    const { simulator } = buildTopology({ lbMode: "static" });
    const result = await simulator.simulate(exchange());
    assert.equal(result.dropped, false);
    const requestStateful = result.results[0].request
      .filter((hop) => hop.changes.some((change) => change.type === "snat" || change.type === "dnat"))
      .map((hop) => hop.nodeId);
    assert.ok(requestStateful.includes("lb"));
    assert.ok(requestStateful.includes("nat"));
  });
});

describe("连接跟踪缺失", () => {
  it("连接跟踪表查找不存在的连接键时抛 CONNTRACK_MISSING", async () => {
    const { simulator } = buildTopology({ lbMode: "static" });
    const natZone = simulator.tableFor("nat");
    assert.throws(
      () =>
        natZone.lookup(
          { protocol: "tcp", srcIp: "10.1.0.5", srcPort: 8080, dstIp: "10.2.0.1", dstPort: 30000 },
          0,
        ),
      (error) => error.reason === DROP.CT_MISSING,
    );
  });
});
