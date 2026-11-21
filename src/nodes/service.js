import { MARK } from "../constants.js";

/**
 * Service 节点执行 Kubernetes 风格的 targetPort 映射。
 * 无 portMap 时仅作为后端实例的终止点。
 */
export function createServiceHandler(config) {
  const maps = new Map();
  for (const mapping of config.portMap ?? []) {
    maps.set(mapping.servicePort, mapping.targetPort);
  }

  return {
    node: config,
    isStateful: false,
    endpoint: true,
    async request(packet) {
      const changes = [];
      const targetPort = maps.get(packet.tuple.dstPort);
      if (targetPort !== undefined && targetPort !== packet.tuple.dstPort) {
        const before = packet.tuple.dstPort;
        packet.tuple.dstPort = targetPort;
        packet.addMark(MARK.PORTMAP);
        changes.push({ type: "portmap", field: "dstPort", from: before, to: targetPort });
      }
      return { action: "terminate", changes };
    },
    async response(packet) {
      const changes = [];
      const reverseMap = new Map([...maps].map(([servicePort, targetPort]) => [targetPort, servicePort]));
      const servicePort = reverseMap.get(packet.tuple.srcPort);
      if (servicePort !== undefined && servicePort !== packet.tuple.srcPort) {
        const before = packet.tuple.srcPort;
        packet.tuple.srcPort = servicePort;
        packet.addMark(MARK.PORTMAP);
        changes.push({ type: "portmap-reverse", field: "srcPort", from: before, to: servicePort });
      }
      return { action: "originate-response", changes };
    },
  };
}
