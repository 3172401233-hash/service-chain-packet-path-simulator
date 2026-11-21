import { DROP } from "./constants.js";

export class SimDrop extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "SimDrop";
    this.reason = reason;
    this.detail = detail ?? null;
  }
}

export function dropReason(error) {
  if (error instanceof SimDrop) {
    return error.detail ? `${error.reason} (${error.detail})` : error.reason;
  }
  return DROP.NO_ROUTE;
}
