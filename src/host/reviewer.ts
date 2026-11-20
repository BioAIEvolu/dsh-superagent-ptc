import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session-query";
import { HostError, errorMessage } from "./errors.ts";

export const REVIEWER_PRESET = "standard";
export const REVIEWER_COMPOSITION_GUIDANCE =
  "Worker inherits super-agent; launch Reviewer as native standard with agent_preset=standard. A super-agent/PTC Reviewer is not accepted.";

/** Read the current Session projection, never the frozen creation header alone. */
export async function readCurrentPreset(ctx: Context, agent: Agent, signal?: AbortSignal): Promise<string | null> {
  let observation;
  try {
    observation = await ctx.sessionQuery.observeSession(agent.id, { ...(signal ? { signal } : {}) });
  } catch (error) {
    throw new HostError("REVIEWER_PRESET_UNAVAILABLE", "cannot read the current agentPreset projection", { cause: errorMessage(error) });
  }
  try {
    const values: unknown = observation.projections?.values;
    const preset = values !== null && typeof values === "object" && "agentPreset" in values
      ? values.agentPreset
      : undefined;
    return typeof preset === "string" && preset.length > 0 ? preset : null;
  } finally {
    observation[Symbol.dispose]();
  }
}

export async function assertNativeStandardReviewer(ctx: Context, agent: Agent, signal?: AbortSignal): Promise<void> {
  const preset = await readCurrentPreset(ctx, agent, signal);
  if (preset === REVIEWER_PRESET) return;
  if (preset === null) {
    throw new HostError("REVIEWER_PRESET_UNKNOWN", "Reviewer current agentPreset projection is missing; launch with native agent_preset=standard");
  }
  throw new HostError(
    "REVIEWER_PRESET_REQUIRED",
    `Reviewer must run under native standard preset with agent_preset=standard; actual current preset is ${preset}. super-agent/PTC run_code is not a read-only Reviewer path.`,
    { actualPreset: preset, requiredPreset: REVIEWER_PRESET },
  );
}
