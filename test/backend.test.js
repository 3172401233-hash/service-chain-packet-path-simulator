import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DROP } from "../src/index.js";
import { buildTopology, dropOf, exchange, findHop } from "./helpers.js";

describe("后端选择与后端切换", () => {
  it("轮询模式把两个连接分别分配给 svc-a 和 svc-b，流在 conntrack 中固定后端", async () => {
    const { simulator } = buildTopology();
    const first = await simulator.simulate(exchange({ id: 1, clientPort: 40001 }));
    const second = await simulator.simulate(exchange({ id: 2, clientPort: 40002 }));

    assert.equal(findHop(first.results[0].request, "lb").after.target.id, "svc-a");
    assert.equal(findHop(second.results[0].request, "lb").after.target.id, "svc-b");
    assert.deepEqual(
      first.conntrack.lb.map((entry) => entry.meta.backendId),
      ["svc-a"],
    );
    assert.deepEqual(
      second.conntrack.lb.map((entry) => entry.meta.backendId),
      ["svc-a", "svc-b"],
    );
  });

  it("LB 在 conntrack 中记录后端绑定，表项 meta 固定为首次选定的 svc-a", async () => {
    const { simulator } = buildTopology();
    const first = await simulator.simulate(exchange({ id: 1, clientPort: 40001 }));
    assert.equal(first.dropped, false);
    const lbEntry = first.conntrack.lb[0];
    assert.equal(lbEntry.meta.backendId, "svc-a");
    assert.equal(lbEntry.meta.backendIpAtCreate, "10.1.0.5");
    assert.equal(lbEntry.state, "ESTABLISHED");

    const second = await simulator.simulate(exchange({ id: 2, clientPort: 40002 }));
    assert.equal(second.conntrack.lb[0].meta.backendId, "svc-a");
    assert.equal(second.conntrack.lb[1].meta.backendId, "svc-b");
  });

  it("回程被改写到另一个后端实例时，报连接跟踪缺失或后端切换，绝不静默转发", async () => {
    const { simulator } = buildTopology({ lbMode: "static" });
    const result = await simulator.simulate(
      exchange({
        responseOverrides: {
          nat: "service-b",
        },
      }),
    );
    assert.equal(result.dropped, true);
    assert.ok(
      [DROP.CT_MISSING, DROP.ASYMMETRIC_PATH, DROP.BACKEND_SWITCH].includes(dropOf(result).reason),
      `实际丢弃原因: ${dropOf(result).reason}`,
    );
  });
});

describe("连接跟踪过期", () => {
  it("响应到达时超过 TTL，连接被标记 EXPIRED 并丢弃", async () => {
    const { simulator } = buildTopology({ lbMode: "static", lbTtl: 100, natTtl: 100 });
    const result = await simulator.simulate(exchange({ requestAt: 0, responseAt: 5000 }));
    assert.equal(result.dropped, true);
    assert.equal(dropOf(result).reason, DROP.CT_EXPIRED);
    const expiredHop = result.results[0].response.find((hop) => hop.drop);
    assert.ok(expiredHop.drop.detail.includes("过期"));
  });

  it("TTL 内的往返保持 ESTABLISHED 并刷新过期时间", async () => {
    const { simulator } = buildTopology({ lbMode: "static", lbTtl: 10000 });
    const result = await simulator.simulate(exchange({ requestAt: 0, responseAt: 200 }));
    assert.equal(result.dropped, false);
    const lbEntry = result.conntrack.lb[0];
    assert.equal(lbEntry.state, "ESTABLISHED");
    assert.ok(lbEntry.expiresAt > 10000);
  });
});
