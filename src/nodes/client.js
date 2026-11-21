export function createClientHandler(config) {
  return {
    node: config,
    isStateful: false,
    endpoint: true,
    async request() {
      return { action: "originate", changes: [] };
    },
    async response() {
      return { action: "deliver", changes: [] };
    },
  };
}
