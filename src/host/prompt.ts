import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-system-prompt";
import type { RunState } from "../core/index.ts";
import type { RunRepository } from "./store.ts";
import { REVIEWER_COMPOSITION_GUIDANCE } from "./reviewer.ts";
import { shouldRenderSuperPrompt } from "./access.ts";

export function renderRunPrompt(state: RunState | null, gates: ReturnType<RunRepository["evaluate"]>): string {
  if (!state) return "Super Agent: no Run exists for the current native root session. Use super_run create before planning or delegation; do not invent obligations or execution state. " + REVIEWER_COMPOSITION_GUIDANCE;
  const anchor = state.anchors[state.run.currentAnchorId];
  const active = new Set(anchor?.obligationSnapshot ?? []);
  const open = Object.values(state.obligations).filter(item => active.has(item.id) && item.status === "open");
  const lines = [
    `Super Agent Run ${state.run.id}: status=${state.run.status}, revision=${state.run.revision}, generation=${state.run.generation}.`,
    `Current anchor v${anchor?.version ?? "unknown"}: ${anchor?.latestInstruction ?? "missing"}`,
    `Definition of done: ${anchor?.definitionOfDone ?? state.run.definitionOfDone}`,
    "Open obligations: " + (open.length ? open.map(item => `${item.id} [${item.kind}] ${item.text}`).join(" | ") : "none"),
    "Gates: " + (gates.length ? gates.map(gate => `${gate.workItemId}#${gate.attempt}=${gate.result} (${gate.reasons.join(",") || "no reasons"})`).join(" | ") : "no work items"),
    REVIEWER_COMPOSITION_GUIDANCE,
    "Only the current root Run above is in scope. reported_done is not accepted; unknown/missing/stale evidence never releases a gate.",
  ];
  return lines.join("\n");
}

export function registerSuperPrompt(ctx: Context, repository: RunRepository): () => void {
  return ctx.systemPrompt.section({
    name: "super-agent:current-run",
    order: ctx.systemPrompt.getSectionOrder("TEAM_POLICY") + 1,
    interpolate: false,
    text: assembly => {
      const scope = assembly.scope as unknown;
      const candidate = scope && typeof scope === "object" && "id" in scope ? scope as Agent : undefined;
      const agent = candidate?.id ? ctx.agents.get(candidate.id) ?? candidate : undefined;
      if (!agent) return "";
      try {
        if (!shouldRenderSuperPrompt(ctx, repository, agent)) return "";
        const root = ctx.subagents.rootOf(agent);
        const state = repository.read(root.id);
        return renderRunPrompt(state, repository.evaluate(root.id));
      } catch {
        return "";
      }
    },
  });
}
