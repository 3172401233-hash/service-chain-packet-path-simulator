import { Simulator } from "../src/index.js";

export const VIP = "203.0.113.10";

/**
 * 标准拓扑：client -> lb -> (proxy) -> nat -> svc-a/svc-b 两个实例。
 * 通过 options 打开/关闭代理、hairpin、健康检查和回程路由。
 */
export function buildTopology(options = {}) {
  const useProxy = options.proxy ?? false;
  const hairpin = options.hairpin ?? false;
  const includeReturnRoute = options.includeReturnRoute ?? true;

  const nodes = [
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
      masqueradeIp: "10.254.0.1",
      hairpin,
      ttl: options.lbTtl ?? 30000,
      rules: [
        {
          id: "vip-rule",
          vip: VIP,
          vipPort: 80,
          protocol: "tcp",
          mode: options.lbMode ?? "rr",
          targetPort: 8080,
          backends: [
            { id: "svc-a", ip: "10.1.0.5" },
            { id: "svc-b", ip: "10.1.0.6" },
          ],
        },
      ],
      routes: {
        request: [{ cidr: "10.1.0.0/16", next: useProxy ? "proxy" : "nat" }],
        response: includeReturnRoute ? [{ cidr: "10.0.0.0/8", next: "client" }] : [],
      },
    },
  ];

  if (useProxy) {
    nodes.push({
      id: "proxy",
      type: "proxy",
      ip: "10.20.0.1",
      listenPort: 9000,
      ttl: options.proxyTtl ?? 30000,
      maxReuse: options.maxReuse ?? 2,
      reusePolicy: options.reusePolicy ?? "after-established",
      reuseMode: options.reuseMode ?? "new-connection",
      upstreams: [{ id: "svc-a", ip: "10.1.0.5", port: 8080 }],
      routes: {
        request: [{ cidr: "10.1.0.0/16", next: "nat" }],
        response: [
          { cidr: "10.254.0.0/16", next: "lb" },
          { cidr: "10.0.0.0/8", next: "lb" },
        ],
      },
    });
  }

  nodes.push(
    {
      id: "nat",
      type: "nat",
      ttl: options.natTtl ?? 30000,
      snatRules: hairpin
        ? [{ id: "snat-pool", matchSrc: "10.254.0.0/16", toIp: "10.2.0.1", toPort: "masquerade" }]
        : [{ id: "snat-pool", matchSrc: "10.0.0.0/8", toIp: "10.2.0.1", toPort: "masquerade" }],
      routes: {
        request: [{ cidr: "10.1.0.0/16", next: options.natNext ?? "service-a" }],
        response: [
          { cidr: "10.20.0.0/16", next: "proxy" },
          { cidr: "10.254.0.0/16", next: "lb" },
          { cidr: "10.0.0.0/8", next: "lb" },
        ],
      },
    },
    {
      id: "service-a",
      type: "service",
      ip: "10.1.0.5",
      portMap: [{ servicePort: 8080, targetPort: 9000 }],
      routes: { response: [{ cidr: "0.0.0.0/0", next: "nat" }] },
    },
    {
      id: "service-b",
      type: "service",
      ip: "10.1.0.6",
      portMap: [{ servicePort: 8080, targetPort: 9000 }],
      routes: { response: [{ cidr: "0.0.0.0/0", next: "nat" }] },
    },
  );

  const config = {
    nodes,
    defaultTtl: options.defaultTtl ?? 30000,
    portRange: options.portRange ?? { start: 40000, end: 49999 },
    healthObservations: options.healthObservations ?? [
      { backendId: "svc-a", source: "lb", healthy: true },
      { backendId: "svc-b", source: "lb", healthy: true },
    ],
  };
  return { config, simulator: new Simulator(config) };
}

export function exchange(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    clientNodeId: "client",
    clientPort: overrides.clientPort ?? 40001,
    dstIp: VIP,
    dstPort: 80,
    requestAt: overrides.requestAt ?? 0,
    responseAt: overrides.responseAt ?? 50,
    flags: overrides.flags ?? { syn: true, ack: false },
    ...overrides,
  };
}

export function findHop(trace, nodeId, phase) {
  const list = phase ? trace.filter((hop) => hop.phase === phase) : trace;
  return list.find((hop) => hop.nodeId === nodeId && hop.action !== "drop");
}

export function dropOf(result, exchangeId = 1) {
  const target = result.results.find((item) => item.exchangeId === exchangeId);
  return target.drop;
}
