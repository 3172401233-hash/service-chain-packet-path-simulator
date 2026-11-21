import { CT_STATE, DROP } from "./constants.js";
import { SimDrop } from "./errors.js";
import { reverseTuple, tupleKey } from "./tuple.js";

let entrySequence = 0;

/**
 * 每个有状态节点维护一张连接跟踪表。
 * 表项记录转换前后的五元组，回程用 reverseKey 命中并做反向还原。
 */
export class ConntrackTable {
  constructor(zone) {
    this.zone = zone;
    this.byKey = new Map();
    this.byReverse = new Map();
  }

  add({ tupleBefore, tupleAfter, ttl, now, state = CT_STATE.NEW, meta = {} }) {
    const key = tupleKey(tupleBefore);
    const reverseKey = tupleKey(reverseTuple(tupleAfter));
    if (this.byKey.has(key)) {
      return this.byKey.get(key);
    }
    if (this.byReverse.has(reverseKey)) {
      throw new SimDrop(
        DROP.PORT_CONFLICT,
        `${this.zone} 上转换后的源端口 ${tupleAfter.srcIp}:${tupleAfter.srcPort} 已被其他连接占用`,
      );
    }
    const entry = {
      id: ++entrySequence,
      zone: this.zone,
      key,
      reverseKey,
      tupleBefore,
      tupleAfter,
      state,
      createdAt: now,
      lastUsed: now,
      ttl,
      expiresAt: now + ttl,
      meta,
    };
    this.byKey.set(key, entry);
    this.byReverse.set(reverseKey, entry);
    return entry;
  }

  lookup(tupleValue, now) {
    const key = tupleKey(tupleValue);
    const entry = this.byKey.get(key) ?? this.byReverse.get(key);
    if (!entry) {
      throw new SimDrop(DROP.CT_MISSING, `${this.zone} 找不到连接键 ${key}`);
    }
    if (entry.state === CT_STATE.CLOSED) {
      throw new SimDrop(DROP.CT_EXPIRED, `连接已关闭: ${entry.key}`);
    }
    if (now > entry.expiresAt) {
      entry.state = CT_STATE.EXPIRED;
      throw new SimDrop(DROP.CT_EXPIRED, `TTL=${entry.ttl}ms，已于 ${entry.expiresAt}ms 过期: ${entry.key}`);
    }
    entry.lastUsed = now;
    entry.expiresAt = now + entry.ttl;
    return entry;
  }

  get(tupleValue) {
    const key = tupleKey(tupleValue);
    return this.byKey.get(key) ?? this.byReverse.get(key) ?? null;
  }

  touch(entry, now, state = entry.state) {
    entry.lastUsed = now;
    entry.expiresAt = now + entry.ttl;
    entry.state = state;
  }

  close(entry) {
    entry.state = CT_STATE.CLOSED;
  }

  entries() {
    return [...this.byKey.values()];
  }
}
