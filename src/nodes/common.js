export function nextEphemeralPort(allocations, nodeId, range) {
  const state = allocations.get(nodeId) ?? { cursor: range.start, used: new Set() };
  let candidate = state.cursor;
  do {
    if (candidate > range.end) {
      candidate = range.start;
    }
    if (!state.used.has(candidate)) {
      state.cursor = candidate + 1;
      state.used.add(candidate);
      allocations.set(nodeId, state);
      return candidate;
    }
    candidate += 1;
  } while (candidate !== state.cursor);
  return range.end + 1;
}
