import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-team";
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-goal";
import type {} from "@deepseek-ai/dsh-session-query";
import type { ModelRoute, NativeRecoveryReceipt, RunState } from "../core/index.ts";
import type { AgentTeamDto, GoalDto, NativeMemberDto, NativeTaskDto } from "../shared/types.ts";
import { HostError } from "./errors.ts";

function currentModelRoute(agent: Agent | undefined): ModelRoute | null | undefined {
  const current = agent?.model.current();
  return current ? {
    provider: current.provider,
    model: current.model,
    ...(current.reasoningEffort !== undefined ? { reasoningEffort: current.reasoningEffort } : {}),
  } : agent ? null : undefined;
}

export interface NativeProjection {
  root: Agent;
  teamEnabled: boolean;
  agentTeam: AgentTeamDto;
  goal: GoalDto | null;
  subagentCatalog: NativeMemberDto[];
  descendantIds: Set<string>;
}

function taskDto(task: ReturnType<Context["agentTeams"]["listTasks"]>[number]): NativeTaskDto {
  return {
    id: task.id,
    revision: task.revision,
    status: task.status,
    subject: task.subject,
    description: task.description,
    ownerId: task.ownerId,
    ownerName: task.ownerName,
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ready: task.ready,
    writeScopeWarnings: [...task.writeScopeWarnings],
  } as NativeTaskDto;
}

export function rootOf(ctx: Context, agent: Agent | undefined): Agent {
  if (!agent) throw new HostError("TOOL_CONTEXT_UNAVAILABLE", "super tools require an exact calling Agent");
  return ctx.subagents.rootOf(agent);
}

export async function assertNativeMember(ctx: Context, root: Agent, sessionId: string, signal?: AbortSignal): Promise<void> {
  if (sessionId === root.id) return;
  const rows = await ctx.subagents.listDescendants(root.id, signal);
  if (!rows.some(row => row.kind === "child" && row.id === sessionId)) {
    throw new HostError("NATIVE_MEMBER_NOT_FOUND", "SessionId is not a readable descendant of the current root", { sessionId });
  }
}

export async function readNativeProjection(ctx: Context, root: Agent, signal?: AbortSignal): Promise<NativeProjection> {
  signal?.throwIfAborted();
  // Deliberately no setEnabled call: Team selection belongs to the user/root domain.
  const teamEnabled = ctx.agentTeams.isEnabled(root);
  const tasks = teamEnabled ? ctx.agentTeams.listTasks(root).map(taskDto) : [];
  const descendants = await ctx.subagents.listDescendants(root.id, signal);
  const subagentCatalog: NativeMemberDto[] = [
    { id: root.id, name: "lead", status: root.status === "running" ? "running" : "inactive", activity: root.status === "running" ? "running" : "inactive", modelRoute: currentModelRoute(root) },
    ...descendants.map((row): NativeMemberDto => row.kind === "diagnostic"
      ? { id: row.id, name: row.id, status: row.reason, diagnostic: row.reason }
      : {
          id: row.id,
          name: row.path ?? row.id,
          status: ctx.agents.get(row.id)?.status === "running" ? "running" : "inactive",
          activity: row.activity,
          mode: row.mode,
          modelRoute: currentModelRoute(ctx.agents.get(row.id)),
        }),
  ];
  const nativeGoal = ctx.goals.get(root);
  const goal = nativeGoal ? {
    id: nativeGoal.id,
    revision: nativeGoal.revision,
    objective: nativeGoal.objective,
    phase: nativeGoal.phase,
    roundsStarted: nativeGoal.roundsStarted,
    maxGoalRounds: nativeGoal.maxGoalRounds,
    activation: nativeGoal.activation,
  } : null;
  const observation = await ctx.sessionQuery.observeSession(root.id, { ...(signal ? { signal } : {}) });
  try {
    // Access the real catalog projection as a contract check; descendants above carry the live status join.
    observation.projections?.values.subagentCatalog;
  } finally {
    observation[Symbol.dispose]();
  }
  return {
    root,
    teamEnabled,
    agentTeam: { enabled: teamEnabled, tasks },
    goal,
    subagentCatalog,
    descendantIds: new Set(descendants.filter(row => row.kind === "child").map(row => row.id)),
  };
}

export function nativeRecoveryReader(ctx: Context, root: Agent): (state: RunState) => Promise<NativeRecoveryReceipt[]> {
  return async state => {
    const native = await readNativeProjection(ctx, root);
    return Object.values(state.mandates).map((mandate): NativeRecoveryReceipt => {
      if (mandate.status !== "running") return { mandateId: mandate.id, status: "unknown" };
      if (mandate.nativeTaskId) {
        if (!native.teamEnabled) return { mandateId: mandate.id, status: "unknown" };
        const task = native.agentTeam.tasks.find(item => item.id === mandate.nativeTaskId);
        if (!task) return { mandateId: mandate.id, status: "unknown" };
        if (task.status === "completed") return { mandateId: mandate.id, status: "reported_done" };
        if (task.status === "deleted") return { mandateId: mandate.id, status: "failed" };
        return { mandateId: mandate.id, status: "running" };
      }
      const workerId = mandate.workerAgentId;
      if (workerId && native.descendantIds.has(workerId)) {
        const member = native.subagentCatalog.find(row => row.id === workerId);
        if (member?.activity === "running") return { mandateId: mandate.id, status: "running" };
      }
      // inactive, missing, unreadable and contradictory native states never imply success.
      return { mandateId: mandate.id, status: "unknown" };
    });
  };
}
