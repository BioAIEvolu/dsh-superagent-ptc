import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { rootOf } from "./native.ts";
import { readCurrentPreset } from "./reviewer.ts";
import type { RunRepository } from "./store.ts";

export const SUPER_AGENT_PRESET = "super-agent";

export function isBoundReviewer(ctx: Context, repository: RunRepository, agent: Agent): boolean {
  try {
    const root = rootOf(ctx, agent);
    const state = repository.read(root.id);
    return Object.values(state?.workItems ?? {}).some(item => {
      const mandate = item.currentMandateId ? state?.mandates[item.currentMandateId] : undefined;
      return mandate?.workItemId === item.id && mandate.attempt === item.attempt &&
        mandate.generation === state?.run.generation &&
        (mandate.status === "reported_done" || mandate.status === "verifying") &&
        mandate.reviewerAgentId !== undefined && mandate.reviewerAgentId === agent.id;
    });
  } catch {
    return false;
  }
}

/** Native dispatch/declaration gate: super-agent members or a proof-verified bound standard Reviewer only. */
export async function canUseSuperTools(ctx: Context, repository: RunRepository, agent: Agent, signal?: AbortSignal): Promise<boolean> {
  try {
    const preset = await readCurrentPreset(ctx, agent, signal);
    if (preset === SUPER_AGENT_PRESET) return true;
    if (preset !== "standard" || !isBoundReviewer(ctx, repository, agent)) return false;
    const root = rootOf(ctx, agent);
    const before = repository.read(root.id);
    await repository.verifyProof(root.id);
    const after = repository.read(root.id);
    return before?.run.revision === after?.run.revision && before?.run.generation === after?.run.generation &&
      isBoundReviewer(ctx, repository, agent);
  } catch {
    return false;
  }
}

/** PromptSection.text is synchronous; this registry method reads the same live agentPreset Session projection. */
export function shouldRenderSuperPrompt(ctx: Context, repository: RunRepository, agent: Agent): boolean {
  try {
    const candidate: unknown = (ctx as unknown as { agentPresets?: unknown }).agentPresets;
    if (!candidate || typeof candidate !== "object" || !("presetForSession" in candidate) || typeof candidate.presetForSession !== "function") return false;
    const reader = candidate as { presetForSession(session: Agent["session"]): string | null };
    const preset = reader.presetForSession(agent.session);
    if (preset === SUPER_AGENT_PRESET) return true;
    return preset === "standard" && isBoundReviewer(ctx, repository, agent);
  } catch {
    return false;
  }
}
