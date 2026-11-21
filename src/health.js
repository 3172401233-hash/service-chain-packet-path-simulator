import { DROP } from "./constants.js";
import { SimDrop } from "./errors.js";

/**
 * 汇聚多个观察方（LB、代理、网关）对同一后端的健康检查结果。
 * 同一后端出现 healthy / unhealthy 两种结论时判定为两侧健康检查不一致。
 */
export class HealthRegistry {
  constructor() {
    this.observations = new Map();
  }
  observe(backendId, source, healthy) {
    if (!this.observations.has(backendId)) {
      this.observations.set(backendId, new Map());
    }
    this.observations.get(backendId).set(source, Boolean(healthy));
  }

  isHealthy(backendId) {
    const sources = this.observations.get(backendId);
    if (!sources || sources.size === 0) {
      return true;
    }
    for (const healthy of sources.values()) {
      if (!healthy) {
        return false;
      }
    }
    return true;
  }

  assertConsistent(backendId, source) {
    const sources = this.observations.get(backendId);
    if (!sources || sources.size < 2) {
      return;
    }
    const values = new Set(sources.values());
    if (values.size > 1) {
      const report = [...sources.entries()]
        .map(([name, healthy]) => `${name}=${healthy ? "healthy" : "unhealthy"}`)
        .join(", ");
      throw new SimDrop(DROP.HEALTH_INCONSISTENT, `后端 ${backendId} 的健康检查结果冲突: ${report}; 当前节点 ${source}`);
    }
  }

  snapshot() {
    const result = {};
    for (const [backendId, sources] of this.observations) {
      result[backendId] = Object.fromEntries(sources);
    }
    return result;
  }
}
