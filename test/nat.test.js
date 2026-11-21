import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DROP, MARK } from "../src/index.js";
import { buildTopology, dropOf, exchange, findHop, VIP } from "./helpers.js";

describe("DNAT：LB 将 VIP 转换为后端实例地址", () => {
  it("请求在 lb 上将目的地址改写为 svc-a，回程先反向 DNAT 再回到 client", async () => {
    const { simulator } = buildTopology({ lbMode: "static" });
    const result = await simulator.simulate(exchange());

    assert.equal(result.dropped, false);
    const lbRequest = findHop(result.results[0].request, "lb");
    assert.equal(lbRequest.before.tuple.dstIp, VIP);
    assert.equal(lbRequest.after.tuple.dstIp, "10.1.0.5");
    assert.equal(lbRequest.after.tuple.dstPort, 8080);
    assert.ok(lbRequest.after.marks.includes(MARK.DNAT));
    assert.equal(lbRequest.after.target.id, "svc-a");
    assert.ok(lbRequest.entry.reverseKey);

    const lbResponse = findHop(result.results[0].response, "lb");
    assert.equal(lbResponse.after.tuple.srcIp, VIP);
    assert.equal(lbResponse.after.tuple.srcPort, 80);
    assert.equal(lbResponse.after.tuple.dstIp, "10.0.0.10");

    const final = result.results[0].finalTuple;
    assert.deepEqual(final, {
      protocol: "tcp",
      srcIp: VIP,
      srcPort: 80,
      dstIp: "10.0.0.10",
      dstPort: 40001,
    });
  });

  it("每一跳都记录转换前后五元组和连接键", async () => {
    const { simulator } = buildTopology({ lbMode: "static" });
    const result = await simulator.simulate(exchange());
    for (const hop of result.results[0].request) {
      assert.ok(hop.before.connKey.includes("->"));
      assert.equal(hop.before.connKey, `${hop.before.tuple.protocol}:${hop.before.tuple.srcIp}:${hop.before.tuple.srcPort}->${hop.before.tuple.dstIp}:${hop.before.tuple.dstPort}`);
      assert.equal(hop.after.connKey, `${hop.after.tuple.protocol}:${hop.after.tuple.srcIp}:${hop.after.tuple.srcPort}->${hop.after.tuple.dstIp}:${hop.after.tuple.dstPort}`);
    }
  });
});

describe("SNAT：NAT 网关复用地址池端口", () => {
  it("请求源地址被伪装为网关地址，回程按 reverseKey 还原源端口", async () => {
    const { simulator } = buildTopology({ lbMode: "static" });
    const result = await simulator.simulate(exchange());

    const natRequest = findHop(result.results[0].request, "nat");
    assert.equal(natRequest.before.tuple.srcIp, "10.0.0.10");
    assert.equal(natRequest.after.tuple.srcIp, "10.2.0.1");
    assert.ok(natRequest.after.tuple.srcPort >= 30000);
    assert.ok(natRequest.after.marks.includes(MARK.SNAT));

    const natResponse = findHop(result.results[0].response, "nat");
    assert.equal(natResponse.after.tuple.dstIp, "10.0.0.10");
    assert.equal(natResponse.after.tuple.dstPort, 40001);
  });

  it("两个连接拿到不同的 SNAT 临时端口，第三次因端口段耗尽触发端口冲突", async () => {
    const { simulator } = buildTopology({
      lbMode: "static",
      portRange: { start: 30000, end: 30001 },
    });
    const first = await simulator.simulate(exchange({ id: 1, clientPort: 40001 }));
    const second = await simulator.simulate(exchange({ id: 2, clientPort: 40002 }));
    assert.equal(first.dropped, false);
    assert.equal(second.dropped, false);
    const firstPort = findHop(first.results[0].request, "nat").after.tuple.srcPort;
    const secondPort = findHop(second.results[0].request, "nat").after.tuple.srcPort;
    assert.notEqual(firstPort, secondPort);

    const third = await simulator.simulate(exchange({ id: 3, clientPort: 40003 }));
    assert.equal(dropOf(third, 3).reason, DROP.PORT_CONFLICT);
  });
});

describe("Service 端口映射", () => {
  it("service 节点将 8080 改写为 targetPort 9000，回程反向还原", async () => {
    const { simulator } = buildTopology({ lbMode: "static" });
    const result = await simulator.simulate(exchange());
    const serviceHop = findHop(result.results[0].request, "service-a");
    assert.equal(serviceHop.before.tuple.dstPort, 8080);
    assert.equal(serviceHop.after.tuple.dstPort, 9000);
    assert.ok(serviceHop.after.marks.includes(MARK.PORTMAP));

    const responseHop = result.results[0].response.find((hop) => hop.nodeId === "service-a");
    assert.equal(responseHop.after.tuple.srcPort, 8080);
  });
});
