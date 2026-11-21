import { DROP, formatTrace, simulate } from "../src/index.js";

const config = {
  defaultTtl: 30000,
  portRange: { start: 30000, end: 39999 },
  healthObservations: [
    { backendId: "svc-a", source: "lb", healthy: true },
    { backendId: "svc-b", source: "lb", healthy: true },
  ],
  nodes: [
    {
      id: "client",
      type: "client",
      ip: "10.0.0.10",
      routes: { request: [{ cidr: "0.0.0.0/0", next: "lb" }] },
    },
    {
      id: "lb",
      type: "loadbalancer",
      ip: "10.254.0.1",
      rules: [
        {
          id: "vip-rule",
          vip: "203.0.113.10",
          vipPort: 80,
          protocol: "tcp",
          mode: "static",
          targetPort: 8080,
          backends: [{ id: "svc-a", ip: "10.1.0.5" }],
        },
      ],
      routes: {
        request: [{ cidr: "10.1.0.0/16", next: "nat" }],
        response: [{ cidr: "10.0.0.0/8", next: "client" }],
      },
    },
    {
      id: "nat",
      type: "nat",
      snatRules: [
        { id: "masq", matchSrc: "10.0.0.0/8", toIp: "10.2.0.1", toPort: "masquerade" },
      ],
      routes: {
        request: [{ cidr: "10.1.0.0/16", next: "service-a" }],
        response: [{ cidr: "10.0.0.0/8", next: "lb" }],
      },
    },
    {
      id: "service-a",
      type: "service",
      ip: "10.1.0.5",
      portMap: [{ servicePort: 8080, targetPort: 9000 }],
      routes: { response: [{ cidr: "0.0.0.0/0", next: "nat" }] },
    },
  ],
};

const exchanges = [
  {
    id: 1,
    clientNodeId: "client",
    clientPort: 40001,
    dstIp: "203.0.113.10",
    dstPort: 80,
    requestAt: 0,
    responseAt: 50,
  },
  {
    id: 2,
    clientNodeId: "client",
    clientPort: 40002,
    dstIp: "203.0.113.10",
    dstPort: 80,
    requestAt: 100,
    responseAt: 40000,
  },
];

const result = await simulate(config, exchanges);
console.log(formatTrace(result));
console.log("\n汇总:");
for (const item of result.results) {
  console.log(
    `exchange ${item.exchangeId}: ${item.dropped ? `丢弃 ${item.drop.reason}` : "成功"}`,
  );
}
console.log(`整体状态: ${result.dropped ? DROP.CT_EXPIRED : "全部送达"}`);
