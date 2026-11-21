import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DROP, MARK } from "../src/index.js";
import { buildTopology, dropOf, exchange, findHop, VIP } from "./helpers.js";

describe("透明代理：连接终结与上游复用", () => {
  it("代理终结客户端连接并以自身地址向上游发起新连接，回程两次反向还原", async () => {
    const { simulator } = buildTopology({ proxy: true, lbMode: "static" });
    const result = await simulator.simulate(exchange());

    assert.equal(result.dropped, false);
    const proxyRequest = findHop(result.results[0].request, "proxy");
    assert.equal(proxyRequest.before.tuple.dstIp, "10.1.0.5");
    assert.equal(proxyRequest.after.tuple.srcIp, "10.20.0.1");
    assert.equal(proxyRequest.after.tuple.dstIp, "10.1.0.5");
    assert.ok(proxyRequest.after.marks.includes(MARK.PROXY));
    assert.equal(proxyRequest.after.target.id, "svc-a");

    assert.ok(result.conntrack["proxy:client"]);
    assert.ok(result.conntrack["proxy:upstream"]);

    const proxyResponse = result.results[0].response.find((hop) => hop.nodeId === "proxy");
    const types = proxyResponse.changes.map((change) => change.type);
    assert.deepEqual(types, ["proxy-un-upstream", "proxy-un-client"]);
    assert.equal(proxyResponse.after.tuple.dstIp, "10.0.0.10");
    assert.equal(proxyResponse.after.tuple.srcIp, "10.1.0.5");

    const lbResponse = result.results[0].response.find((hop) => hop.nodeId === "lb");
    assert.equal(lbResponse.after.tuple.srcIp, VIP);
    assert.equal(lbResponse.after.tuple.dstIp, "10.0.0.10");
  });

  it("第二条客户端流在 maxReuse 内复用同一上游连接并打上 PROXY_REUSED 标记", async () => {
    const { simulator } = buildTopology({ proxy: true, lbMode: "static", maxReuse: 2 });
    const first = await simulator.simulate(exchange({ id: 1, clientPort: 40001, flags: { syn: true } }));
    const second = await simulator.simulate(
      exchange({
        id: 2,
        clientPort: 40002,
        flags: { syn: false, ack: true },
        requestAt: 100,
        responseAt: 110,
      }),
    );
    assert.equal(first.dropped, false);
    assert.equal(second.dropped, false);

    const upstreamEntries = second.conntrack["proxy:upstream"];
    assert.equal(upstreamEntries.length, 1);
    assert.equal(upstreamEntries[0].meta.reuseCount, 2);
    const proxyRequest = findHop(second.results[0].request, "proxy");
    assert.ok(proxyRequest.after.marks.includes(MARK.PROXY_REUSED));
  });

  it("新客户端 SYN 在 after-established 策略下复用上一条上游连接时，判代理提前复用并丢弃", async () => {
    const { simulator } = buildTopology({
      proxy: true,
      lbMode: "static",
      maxReuse: 5,
      reusePolicy: "after-established",
    });
    await simulator.simulate(exchange({ id: 1, clientPort: 40001, requestAt: 0, responseAt: 10 }));
    const early = await simulator.simulate(
      exchange({ id: 2, clientPort: 40002, flags: { syn: true }, requestAt: 20, responseAt: 30 }),
    );
    assert.equal(early.dropped, true);
    assert.equal(dropOf(early, 2).reason, DROP.PROXY_EARLY_REUSE);
  });

  it("超过 maxReuse 时拒绝复用并报告复用上限", async () => {
    const { simulator } = buildTopology({
      proxy: true,
      lbMode: "static",
      maxReuse: 1,
      reuseMode: "sticky",
    });
    await simulator.simulate(exchange({ id: 1, clientPort: 40001, flags: { syn: true } }));
    const overflow = await simulator.simulate(
      exchange({ id: 2, clientPort: 40002, flags: { syn: false, ack: true }, requestAt: 100 }),
    );
    assert.equal(dropOf(overflow, 2).reason, DROP.PROXY_REUSE_LIMIT);
  });
});

describe("双向代理：请求与响应两侧都经过代理转换", () => {
  it("请求侧和响应侧代理跳数对称，连接跟踪客户端/上游两张表都被命中", async () => {
    const { simulator } = buildTopology({ proxy: true, lbMode: "static" });
    const result = await simulator.simulate(exchange());
    const requestProxyHops = result.results[0].request.filter((hop) => hop.nodeId === "proxy").length;
    const responseProxyHops = result.results[0].response.filter((hop) => hop.nodeId === "proxy").length;
    assert.equal(requestProxyHops, 1);
    assert.equal(responseProxyHops, 1);

    const clientEntry = result.conntrack["proxy:client"][0];
    const upstreamEntry = result.conntrack["proxy:upstream"][0];
    assert.equal(clientEntry.meta.upstreamKey, upstreamEntry.key);
    assert.ok(upstreamEntry.meta.clientFlows.includes(clientEntry.key));
  });

  it("代理上游连接跟踪过期时，回程在代理处报连接跟踪过期", async () => {
    const { simulator } = buildTopology({ proxy: true, lbMode: "static", proxyTtl: 50 });
    const result = await simulator.simulate(exchange({ requestAt: 0, responseAt: 5000 }));
    assert.equal(result.dropped, true);
    assert.equal(dropOf(result).reason, DROP.CT_EXPIRED);
    const expiredAtProxy = result.results[0].response.some(
      (hop) => hop.nodeId === "proxy" && hop.drop?.reason === DROP.CT_EXPIRED,
    );
    assert.ok(expiredAtProxy);
  });
});
