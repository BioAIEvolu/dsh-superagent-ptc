import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type {} from "@deepseek-ai/dsh-storage-domain";
import type {} from "@deepseek-ai/dsh-agent-team";
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-goal";
import type {} from "@deepseek-ai/dsh-session-query";
import { nativeRecoveryReader } from "./native.ts";
import { registerProjectionRpc } from "./rpc.ts";
import { openRunRepository } from "./storage.ts";
import { registerSuperPrompt } from "./prompt.ts";
import { registerSuperTools } from "./tools.ts";
import { reviewerToolDenial } from "./guard.ts";
import { isBoundReviewer } from "./access.ts";
import { registerModelFailureAdapter } from "./routing.ts";

export const name = "dsh-superagent-ptc-host";
export const inject = ["tools", "systemPrompt", "storageDomain", "subagents", "agentTeams", "goals", "sessionQuery", "agents", "agentPresets", "sessions"];

export async function apply(ctx: Context): Promise<void> {
  const repository = await openRunRepository(ctx, async state => {
    const agent = ctx.agents.get(state.run.sessionId as never);
    if (!agent || ctx.subagents.rootOf(agent).id !== state.run.sessionId) {
      return Object.values(state.mandates).filter(item => item.status === "running").map(item => ({ mandateId: item.id, status: "unknown" as const }));
    }
    return nativeRecoveryReader(ctx, agent)(state);
  });
  const disposeTools = registerSuperTools(ctx, repository);
  const disposePrompt = registerSuperPrompt(ctx, repository);
  const disposeGuard = ctx.tools.guard(execution => {
    const agent = execution.agent;
    if (!agent) return undefined;
    try {
      if (!isBoundReviewer(ctx, repository, agent)) return undefined;
      const reason = reviewerToolDenial(execution.name, execution.arguments);
      return reason ? { reason, info: { name: execution.name, code: "REVIEWER_NOT_READONLY" } } : undefined;
    } catch {
      return { reason: "Reviewer/Run identity could not be verified; fail closed.", info: { name: execution.name, code: "REVIEWER_NOT_READONLY" } };
    }
  });
  registerProjectionRpc(ctx, repository);
  const disposeFailureAdapter = registerModelFailureAdapter(ctx, repository);
  ctx.effect(() => () => {
    disposeFailureAdapter();
    disposeGuard();
    disposePrompt();
    disposeTools();
  }, "super-agent:host");
}
