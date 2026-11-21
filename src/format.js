import { formatTuple } from "./tuple.js";

function renderHop(hop) {
  const lines = [
    `#${hop.seq} [${hop.phase}] ${hop.nodeId} action=${hop.action}`,
    `  before: ${formatTuple(hop.before.tuple)} | key=${hop.before.connKey} | marks=[${hop.before.marks.join(",")}] | target=${hop.before.target?.id ?? "-"}`,
    `  after : ${formatTuple(hop.after.tuple)} | key=${hop.after.connKey} | marks=[${hop.after.marks.join(",")}] | target=${hop.after.target?.id ?? "-"}`,
  ];
  if (hop.entry) {
    lines.push(`  ct    : zone=${hop.entry.zone} state=${hop.entry.state} key=${hop.entry.key} reverse=${hop.entry.reverseKey} expiresAt=${hop.entry.expiresAt}ms`);
  }
  for (const change of hop.changes) {
    if (change.field === "tuple") {
      lines.push(`  change: ${change.type} ${formatTuple(change.from)} => ${formatTuple(change.to)}`);
    } else {
      lines.push(`  change: ${change.type} ${change.field} ${change.from} -> ${change.to}`);
    }
  }
  if (hop.drop) {
    lines.push(`  DROP  : ${hop.drop.reason}${hop.drop.detail ? ` (${hop.drop.detail})` : ""}`);
  }
  return lines.join("\n");
}

export function formatTrace(result) {
  const blocks = [];
  for (const exchange of result.results) {
    blocks.push(`===== exchange ${exchange.exchangeId} ${exchange.dropped ? "DROPPED" : "OK"} =====`);
    blocks.push("-- request --");
    blocks.push(exchange.request.map(renderHop).join("\n"));
    if (exchange.response.length) {
      blocks.push("-- response --");
      blocks.push(exchange.response.map(renderHop).join("\n"));
    }
    if (exchange.drop) {
      blocks.push(`丢弃原因: ${exchange.drop.reason} (${exchange.drop.detail ?? ""})`);
    }
    if (exchange.finalTuple) {
      blocks.push(`最终五元组: ${formatTuple(exchange.finalTuple)}`);
    }
  }
  return blocks.join("\n");
}
