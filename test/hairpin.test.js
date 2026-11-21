import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DROP, MARK } from "../src/index.js";
import { buildTopology, dropOf, exchange, findHop, VIP } from "./helpers.js";

describe("hairpin：客户端经 LB 访问同网段 VIP", () => {
  it("LB 同时做 DNAT 与源地址伪装，回程先还原 SNAT 再还原 DNAT", async () => {
    const { simulator } = buildTopology({ hairpin: true, lbMode: "static" });
    const result = await simulator.simulate(exchange());

    assert.equal(result.dropped, false);
    const lbRequest = findHop(result.results[0].request, "lb");
    assert.equal(lbRequest.before.tuple.srcIp, "10.0.0.10");
    assert.equal(lbRequest.after.tuple.srcIp, "10.254.0.1");
    assert.equal(lbRequest.after.tuple.dstIp, "10.1.0.5");
    assert.ok(lbRequest.after.marks.includes(MARK.HAIRPIN));
    assert.ok(lbRequest.after.marks.includes(MARK.DNAT));

    const changes = lbRequest.changes.map((change) => change.type);
    assert.deepEqual(changes, ["dnat", "dnat", "snat", "snat"]);
    assert.ok(changes.filter((type) => type === "snat").length === 2);

    const lbResponse = findHop(result.results[0].response, "lb");
    const responseTypes = lbResponse.changes.map((change) => change.type);
    assert.deepEqual(responseTypes, ["un-snat", "un-snat", "un-dnat", "un-dnat"]);
    assert.equal(lbResponse.after.tuple.srcIp, VIP);
    assert.equal(lbResponse.after.tuple.dstIp, "10.0.0.10");
    assert.equal(lbResponse.after.tuple.dstPort, 40001);
  });

  it("回程缺少经过 LB 的原路返回时丢弃并报告非对称路径", async () => {
    const { simulator } = buildTopology({ hairpin: true, lbMode: "static" });
    const result = await simulator.simulate(
      exchange({
        responseOverrides: {
          nat: "client",
        },
      }),
    );
    assert.equal(result.dropped, true);
    assert.equal(dropOf(result).reason, DROP.ASYMMETRIC_PATH);
    const dropHop = result.results[0].response.find((hop) => hop.drop);
    assert.ok(dropHop.drop.detail.includes("lb"));
  });
});
