import { PHASE, PROTOCOL } from "./constants.js";
import { copyTuple } from "./tuple.js";

let packetSequence = 0;

export class Packet {
  constructor({ phase, tupleValue, marks = [], target = null, exchangeId = 1, seq = 1, flags = {}, now = 0 }) {
    this.id = ++packetSequence;
    this.phase = phase;
    this.tuple = copyTuple(tupleValue);
    this.marks = [...marks];
    this.target = target;
    this.exchangeId = exchangeId;
    this.seq = seq;
    this.flags = { syn: false, ack: false, fin: false, rst: false, ...flags };
    this.now = now;
  }

  static request(tupleValue, options = {}) {
    return new Packet({ ...options, phase: PHASE.REQUEST, tupleValue });
  }

  static response(packet, now) {
    const reply = new Packet({
      phase: PHASE.RESPONSE,
      tupleValue: {
        protocol: packet.tuple.protocol,
        srcIp: packet.tuple.dstIp,
        srcPort: packet.tuple.dstPort,
        dstIp: packet.tuple.srcIp,
        dstPort: packet.tuple.srcPort,
      },
      marks: packet.marks,
      target: packet.target,
      exchangeId: packet.exchangeId,
      seq: packet.seq,
      flags: { syn: false, ack: true, fin: false, rst: false },
      now,
    });
    return reply;
  }

  addMark(mark) {
    if (!this.marks.includes(mark)) {
      this.marks.push(mark);
    }
  }

  hasMark(mark) {
    return this.marks.includes(mark);
  }

  snapshot() {
    return {
      tuple: copyTuple(this.tuple),
      marks: [...this.marks],
      target: this.target,
    };
  }

  get protocol() {
    return this.tuple.protocol ?? PROTOCOL.TCP;
  }
}
