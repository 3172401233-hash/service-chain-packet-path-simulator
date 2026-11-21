# service-chain-packet-path-simulator

逐跳包路径模拟器：对请求经过负载均衡、透明代理、NAT 网关和多个服务实例后的
五元组变化、包标记、连接跟踪状态进行建模，分别还原请求与响应的完整路径。

> **这是一个网络路径模型，不抓取、不发送、不监听任何真实报文。**
> 所有地址、端口、连接跟踪表项和路由都来自你提供的配置，在内存中推演。
> 它用于解释“包在哪一跳被改写、为什么被丢弃”，不能替代 `tcpdump`、`conntrack`
> 或真实设备的排障数据。

## 能力范围

- 节点类型：`client`、`loadbalancer`、`nat`、`proxy`、`service`。
- 地址转换：LB 的 DNAT（含端口改写）、NAT 网关的 SNAT/DNAT 规则、hairpin 源伪装。
- Service 端口映射：`servicePort -> targetPort`，回程自动反向还原。
- 透明代理：终结客户端连接并以代理地址向上游发起连接，支持连接复用 `maxReuse`。
- 连接跟踪：每个有状态节点独立维护 conntrack 表，记录转换前后五元组、
  正向键 `key` 与回程键 `reverseKey`、TTL 与状态（NEW/ESTABLISHED/CLOSED/EXPIRED）。
- 回程约束：DNAT/SNAT 后回程必须先反向还原，再按原转发节点的逆序经过；
  引擎维护有状态节点栈，检测非对称原路返回。

## 检测的丢弃原因

| 常量 | 含义 |
| --- | --- |
| `ASYMMETRIC_RETURN_PATH` | 回程跳过了请求路径上的有状态节点 |
| `SNAT_PORT_CONFLICT` | SNAT 临时端口段耗尽或 reverseKey 冲突 |
| `CONNTRACK_MISSING` | 回程在某节点找不到对应的连接跟踪表项 |
| `CONNTRACK_EXPIRED` | 响应到达时间超过表项 TTL，状态转为 EXPIRED |
| `PROXY_EARLY_REUSE` | 新客户端 SYN 在策略允许前复用了上游连接 |
| `PROXY_REUSE_LIMIT_EXCEEDED` | 上游连接复用次数超过 `maxReuse` |
| `HEALTH_CHECK_INCONSISTENT` | 不同观察方对同一后端的健康结论冲突 |
| `BACKEND_SWITCHED_MID_FLOW` | 已固定后端的流被改写到其他实例 |
| `LB_NO_HEALTHY_BACKEND` / `LB_NO_MATCHING_RULE` | LB 无可用后端或无匹配规则 |
| `NAT_NO_MATCHING_RULE` / `NO_ROUTE` / `LOOP_DETECTED` | 规则或路由缺失、成环 |

## 每跳输出

每个跳点记录转换前后的五元组、连接键、包标记和目标实例，例如：

```
#2 [request] nat action=forward
  before: 10.0.0.10:40001 -> 203.0.113.10:80 (tcp) | key=tcp:... | marks=[DNAT]
  after : 10.2.0.1:30000 -> 10.1.0.5:8080 (tcp) | key=tcp:... | marks=[DNAT,SNAT]
  ct    : zone=nat state=NEW key=... reverse=... expiresAt=30000ms
  change: snat srcIp 10.0.0.10 -> 10.2.0.1
```

被丢弃的跳点带 `drop.reason` 与 `drop.detail`，说明丢弃发生的节点和具体原因。

## 快速开始

要求 Node.js `>=24.16.0`，无第三方依赖。

```bash
node --test
node examples/demo.js
```

```js
import { simulate, formatTrace } from "./src/index.js";

const config = {
  defaultTtl: 30000,
  nodes: [
    { id: "client", type: "client", ip: "10.0.0.10",
      routes: { request: [{ cidr: "0.0.0.0/0", next: "nat" }] } },
    { id: "nat", type: "nat",
      snatRules: [{ id: "s1", matchSrc: "10.0.0.0/8", toIp: "10.2.0.1", toPort: "masquerade" }],
      routes: {
        request: [{ cidr: "10.1.0.0/16", next: "svc" }],
        response: [{ cidr: "10.0.0.0/8", next: "client" }],
      } },
    { id: "svc", type: "service", ip: "10.1.0.5",
      portMap: [{ servicePort: 8080, targetPort: 9000 }],
      routes: { response: [{ cidr: "0.0.0.0/0", next: "nat" }] } },
  ],
};

const result = await simulate(config, {
  clientNodeId: "client",
  clientPort: 40001,
  dstIp: "203.0.113.10",
  dstPort: 80,
  requestAt: 0,
  responseAt: 50,
});

console.log(formatTrace(result));
```

## 配置模型

- `nodes`：有序定义网络节点，每个节点带 `routes.request` / `routes.response`，
  按 CIDR 最长目的地址匹配决定下一跳。
- `loadbalancer.rules`：VIP + 端口匹配，`mode: static | rr` 选择后端，
  `hairpin: true` 时同时做源地址伪装。
- `nat.dnatRules` / `nat.snatRules`：按源/目的 CIDR、端口、协议匹配，
  `toPort: "masquerade"` 表示从端口段动态分配。
- `proxy`：`listenPort`、`upstreams`、`maxReuse`、`reusePolicy`、`reuseMode`。
- `healthObservations`：`{ backendId, source, healthy }`，多来源结论冲突即报错。
- 交换（exchange）描述一次请求-响应往返，含 `requestAt` / `responseAt` 虚拟时钟，
  用于驱动 TTL 过期判断；`responseOverrides` 可强制改写下一跳以复现非对称路径。

## 目录结构

```
src/
  constants.js      丢弃原因、连接状态、包标记常量
  tuple.js          五元组、连接键、CIDR 匹配
  conntrack.js      每节点连接跟踪表与 TTL 处理
  health.js         多观察方健康检查汇聚与一致性检测
  packet.js         包对象（标记、目标实例、标志位）
  engine.js         路由、逐跳编排、非对称回程检测
  nodes/            client / loadbalancer / nat / proxy / service
  format.js         人类可读的逐跳追踪输出
test/               node --test 测试（DNAT、SNAT、hairpin、双向代理、后端切换、过期等）
examples/demo.js    可运行示例
```

## 测试覆盖

`node --test` 覆盖：DNAT 与回程反向 DNAT、SNAT 端口分配与冲突、hairpin 双向还原、
透明代理连接复用与提前复用、双向代理两侧转换、后端轮询与中途切换检测、
连接跟踪 TTL 过期、健康检查不一致、非对称原路返回和连接跟踪缺失。
