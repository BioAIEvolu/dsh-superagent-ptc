/** Client ↔ host wire contract for the preset-scoped Super Agent projection. */
export const API_CHANNEL = "/api" as const;
export const SUPER_AGENT_NAMESPACE = "dsh-super-agent-mode" as const;
export const SUPER_AGENT_ENDPOINTS = ["projection"] as const;

export type SuperAgentEndpoint = (typeof SUPER_AGENT_ENDPOINTS)[number];

export function endpointName(endpoint: SuperAgentEndpoint): string {
  return `${SUPER_AGENT_NAMESPACE}/${endpoint}`;
}

export function routePath(endpoint: SuperAgentEndpoint): string {
  return `${API_CHANNEL}/${endpointName(endpoint)}`;
}

export function rpcTarget(endpoint: SuperAgentEndpoint): { channel: typeof API_CHANNEL; endpoint: string } {
  return { channel: API_CHANNEL, endpoint: endpointName(endpoint) };
}
