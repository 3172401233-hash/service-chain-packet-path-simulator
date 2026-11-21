import { PROTOCOL } from "./constants.js";

/**
 * 五元组：protocol / srcIp / srcPort / dstIp / dstPort。
 * 所有路径节点都通过 copyTuple 生成新对象，避免跨跳共享引用。
 */
export function tuple(srcIp, srcPort, dstIp, dstPort, protocol = PROTOCOL.TCP) {
  return { protocol, srcIp, srcPort, dstIp, dstPort };
}

export function copyTuple(value) {
  return {
    protocol: value.protocol,
    srcIp: value.srcIp,
    srcPort: value.srcPort,
    dstIp: value.dstIp,
    dstPort: value.dstPort,
  };
}

export function tupleKey(value) {
  return `${value.protocol}:${value.srcIp}:${value.srcPort}->${value.dstIp}:${value.dstPort}`;
}

export function reverseTuple(value) {
  return {
    protocol: value.protocol,
    srcIp: value.dstIp,
    srcPort: value.dstPort,
    dstIp: value.srcIp,
    dstPort: value.srcPort,
  };
}

export function sameTuple(a, b) {
  return (
    a.protocol === b.protocol &&
    a.srcIp === b.srcIp &&
    a.srcPort === b.srcPort &&
    a.dstIp === b.dstIp &&
    a.dstPort === b.dstPort
  );
}

export function formatTuple(value) {
  return `${value.srcIp}:${value.srcPort} -> ${value.dstIp}:${value.dstPort} (${value.protocol})`;
}

function ipToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    throw new Error(`仅支持 IPv4，非法地址: ${ip}`);
  }
  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`非法 IPv4 八位组: ${part}`);
    }
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

export function ipInCidr(ip, cidr) {
  const [base, prefixText] = cidr.split("/");
  const prefix = Number(prefixText ?? 32);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`非法 CIDR 前缀: ${cidr}`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
}
