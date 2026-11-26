// Uses the package's pinned @deepseek-ai/dsh-tools when dependencies are unified.
import test from "node:test";
import assert from "node:assert/strict";
import { currentMandate, registerSuperTools } from "../../src/host/tools.ts";
import { SuperAgentCore } from "../../src/core/index.ts";
import { createInput, drivers, MemoryTable, MemoryProofStore } from "./helpers.ts";
import { RunRepository } from "../../src/host/store.ts";

test("registerSuperTools really constructs and registers six defineTool definitions", () => {
  const registered = new Map<string, { name: string; description: string; output: unknown; isConcurrencySafe?: (args: unknown) => boolean }>();
  const disposals: string[] = [];
  const ctx = {
    tools: {
      register(definition: { name: string; description: string; output: unknown; isConcurrencySafe?: (args: unknown) => boolean }) {
        registered.set(definition.name, definition);
        return () => { disposals.push(definition.name); };
      },
    },
  };
  const dispose = registerSuperTools(ctx as never, {} as never);
  assert.deepEqual([...registered.keys()].sort(), [
    "super_anchor", "super_evidence", "super_mandate", "super_review", "super_route", "super_run", "super_snapshot",
  ]);
  assert.match(registered.get("super_mandate")?.description ?? "", /Worker inherits super-agent/);
  assert.match(registered.get("super_review")?.description ?? "", /agent_preset=standard/);
  for (const definition of registered.values()) {
    assert.equal(typeof definition.output, "object");
    assert.equal((definition.output as { schema?: { type?: string } }).schema?.type, "object");
  }
  assert.equal(registered.get("super_run")?.isConcurrencySafe?.({ action: "show" }), true);
  assert.equal(registered.get("super_run")?.isConcurrencySafe?.({ action: "create" }), false);
  assert.equal(registered.get("super_evidence")?.isConcurrencySafe?.({ action: "list" }), true);
  assert.equal(registered.get("super_evidence")?.isConcurrencySafe?.({ action: "record" }), false);
  assert.equal(registered.get("super_review")?.isConcurrencySafe?.({ action: "evaluate" }), true);
  assert.equal(registered.get("super_review")?.isConcurrencySafe?.({ action: "decide" }), false);
  dispose();
  assert.equal(disposals.length, 7);
});

test("registered super_run executes with canonical output and current-root persistence", async () => {
  const definitions = new Map<string, { execute(args: unknown, exec: unknown): Promise<{ ok: boolean; value?: { sessionId?: string; run?: { sessionId?: string } } }> }>();
  const root = { id: "root-tool", status: "idle" };
  const ctx = {
    tools: { register(definition: never) { definitions.set((definition as { name: string }).name, definition); return () => {}; } },
    subagents: { rootOf: (agent: { id: string }) => agent },
  };
  const repo = new RunRepository(new MemoryTable(), drivers(), undefined, new MemoryProofStore());
  registerSuperTools(ctx as never, repo);
  const exec = { agent: root, signal: new AbortController().signal };
  const created = await definitions.get("super_run")!.execute({
    action: "create", objective: "verify real tool execution", definitionOfDone: "canonical output passes", obligations: [],
  }, exec);
  assert.equal(created.ok, true);
  assert.equal(created.value?.sessionId, "root-tool", JSON.stringify(created));
  assert.equal(repo.read("root-tool")?.run.objective, "verify real tool execution");
  const shown = await definitions.get("super_run")!.execute({ action: "show" }, exec);
  assert.equal(shown.ok, true);
  assert.equal(shown.value?.run?.sessionId, "root-tool");
});

test("super_run replan passes complete workItemRevisions through the Host/Core boundary", async () => {
  const definitions = new Map<string, { execute(args: unknown, exec: unknown): Promise<{ ok: boolean; value?: unknown }> }>();
  const root = { id: "root-replan", status: "idle" };
  const ctx = {
    tools: { register(definition: never) { definitions.set((definition as { name: string }).name, definition); return () => {}; } },
    subagents: { rootOf: () => root },
  };
  let captured: Record<string, unknown> | undefined;
  const repository = {
    read: () => ({ run: { id: "run-replan" } }),
    transact: async (_sessionId: string, callback: (core: unknown) => unknown) => callback({
      applyUserInstruction: (input: Record<string, unknown>) => {
        captured = input;
        return { ok: true, state: null, value: input };
      },
    }),
  };
  registerSuperTools(ctx as never, repository as never);
  const workItemRevisions = [{
    id: "item", title: "Revised contract", dependencies: [], writeScopes: ["src/a"], acceptance: ["new evidence"],
    obligationIds: ["coverage-delivery"], gateProfile: "coverage", hostContractRequired: false, mandatory: true,
  }];
  const result = await definitions.get("super_run")!.execute({
    action: "replan", expectedRevision: 8, expectedGeneration: 2, instruction: "User authorized contract correction",
    obligationDelta: [], workItemRevisions,
  }, { agent: root, signal: new AbortController().signal });
  assert.equal(result.ok, true);
  assert.deepEqual(captured?.workItemRevisions, workItemRevisions);
  assert.equal(captured?.expectedRevision, 8);
  assert.equal(captured?.expectedGeneration, 2);
});

test("an unaffected prepared Mandate survives an unrelated new anchor", () => {
  const core = new SuperAgentCore(drivers());
  assert.ok(core.createRun(createInput("root-a")).ok);
  assert.ok(core.planWorkItems({ expectedRevision: 1, expectedGeneration: 1, items: [{ id: "item", title: "Work", dependencies: [], writeScopes: [], acceptance: ["verified"], obligationIds: [], gateProfile: "code" }] }).ok);
  const prepared = core.prepareMandate({ expectedRevision: 2, expectedGeneration: 1, workItemId: "item", workerId: "worker-native", reviewerId: "reviewer-native", knownFailures: [] });
  assert.ok(prepared.ok);
  const anchored = core.applyUserInstruction({
    expectedRevision: 3, expectedGeneration: 1, runId: core.snapshot()!.run.id, instruction: "add unrelated scope",
    obligationDelta: [{ op: "add", obligation: { id: "unrelated", kind: "requirement", text: "unrelated duty" } }],
  });
  assert.ok(anchored.ok);
  assert.equal(anchored.state.anchors[anchored.state.run.currentAnchorId]?.version, 2);
  assert.equal(prepared.value.anchorVersion, 1);
  assert.equal(currentMandate(anchored.state, prepared.value.id).id, prepared.value.id);
});

type ReviewerTool = { execute(args: unknown, exec: unknown): Promise<{
  ok: boolean;
  error?: { code: string; message: string };
  value?: { id?: string; result?: string };
  state?: { decisions: Record<string, unknown>; workItems: Record<string, { status: string }> };
}> };

async function reviewerFixture(preset: "standard" | "super-agent") {
  const root = { id: "root-review", status: "running" };
  const worker = { id: "worker-native", status: "inactive" };
  const reviewer = { id: "reviewer-native", status: "idle" };
  const definitions = new Map<string, ReviewerTool>();
  let readSessions = 0;
  const nativeEvents: { type: string; seq: number; data: unknown }[] = [];
  const nativeChildren = [
    { kind: "child", id: worker.id, path: "worker" },
    { kind: "child", id: reviewer.id, path: "reviewer" },
  ];
  const ctx = {
    tools: { register(definition: never) { definitions.set((definition as { name: string }).name, definition); return () => {}; } },
    subagents: { rootOf: () => root, listDescendants: async () => nativeChildren, sendMessage: async () => ({}) },
    sessionQuery: {
      observeSession: async () => ({
        projections: { values: { agentPreset: preset } },
        [Symbol.dispose]: () => {},
      }),
      readSession: async () => { readSessions += 1; return { events: nativeEvents }; },
    },
  };
  const repo = new RunRepository(new MemoryTable(), drivers(), undefined, new MemoryProofStore());
  registerSuperTools(ctx as never, repo);
  await repo.create(root.id, createInput(root.id));
  await repo.transact(root.id, core => core.planWorkItems({
    expectedRevision: 1, expectedGeneration: 1,
    items: [{ id: "item", title: "Review work", dependencies: [], writeScopes: [], acceptance: ["independent evidence"], obligationIds: [], gateProfile: "code" }],
  }));
  const prepared = await repo.transact(root.id, core => core.prepareMandate({
    expectedRevision: 2, expectedGeneration: 1, workItemId: "item", workerId: worker.id, reviewerId: reviewer.id, knownFailures: [],
  }));
  assert.ok(prepared.ok);
  await repo.transact(root.id, core => core.bindExecution({
    expectedRevision: 3, expectedGeneration: 1, mandateId: prepared.value.id, workerAgentId: worker.id,
  }));
  await repo.transact(root.id, core => core.reportWorkerDone({
    expectedRevision: 4, expectedGeneration: 1, mandateId: prepared.value.id, workerId: worker.id, summary: "worker finished implementation",
  }));
  await repo.transact(root.id, core => core.bindReviewer({
    expectedRevision: 5, expectedGeneration: 1, mandateId: prepared.value.id, reviewerAgentId: reviewer.id,
  }));
  const build = await repo.transact(root.id, core => core.recordEvidence({
    expectedRevision: 6, expectedGeneration: 1, workItemId: "item", mandateId: prepared.value.id, attempt: 1,
    kind: "build", result: "pass", sourceActor: reviewer.id, sourceRole: "reviewer", receipt: { exitCode: 0 }, summary: "reviewer observed build",
  }));
  assert.ok(build.ok);
  const unit = await repo.transact(root.id, core => core.recordEvidence({
    expectedRevision: 7, expectedGeneration: 1, workItemId: "item", mandateId: prepared.value.id, attempt: 1,
    kind: "unit", result: "pass", sourceActor: reviewer.id, sourceRole: "reviewer", receipt: { passed: 1, failed: 0, total: 1 }, summary: "reviewer observed unit tests",
  }));
  assert.ok(unit.ok);
  return {
    repo, root, worker, nativeChildren, reviewer, definitions, prepared: prepared.value,
    evidenceIds: [build.value.id, unit.value.id], nativeEvents,
    readSessions: () => readSessions,
  };
}

test("native standard Reviewer can decide and release through real super_review canonical execution", async () => {
  const fixture = await reviewerFixture("standard");
  const exec = { agent: fixture.reviewer, signal: new AbortController().signal };
  const tool = fixture.definitions.get("super_review")!;
  fixture.nativeEvents.push(
    { type: "tool/call", seq: 8, data: { callId: "native-pwsh", name: "pwsh", arguments: JSON.stringify({ command: "Get-Content -Raw C:\\demo\\fixture.txt" }) } },
    { type: "tool/result", seq: 9, data: { message: { isError: false, source: { kind: "tool", callId: "native-pwsh" } } } },
    { type: "tool/call", seq: 10, data: { callId: "native-evidence", name: "super_evidence", arguments: JSON.stringify({ action: "record", kind: "coverage", result: "pass" }) } },
    { type: "tool/result", seq: 11, data: { message: { isError: false, source: { kind: "tool", callId: "native-evidence" } } } },
    { type: "tool/call", seq: 12, data: { callId: "native-evaluate", name: "super_review", arguments: JSON.stringify({ action: "evaluate", workItemId: "item" }) } },
    { type: "tool/result", seq: 13, data: { message: { isError: false, source: { kind: "tool", callId: "native-evaluate" } } } },
  );
  fixture.nativeEvents.push(
    { type: "tool/call", seq: 14, data: { callId: "native-coordination", name: "send_message", arguments: JSON.stringify({ agent: "lead", message: "Completed read-only evidence review; proceeding to decide and release only if gates pass." }) } },
    { type: "tool/result", seq: 15, data: { message: { isError: false, source: { kind: "tool", callId: "native-coordination" } } } },
  );
  const decided = await tool.execute({
    action: "decide", expectedRevision: 8, expectedGeneration: 1, workItemId: "item", mandateId: fixture.prepared.id,
    result: "pass", evidenceIds: fixture.evidenceIds,
  }, exec);
  assert.equal(decided.ok, true);
  assert.equal(decided.state?.workItems.item?.status, "verifying");
  fixture.nativeEvents.push(
    { type: "tool/call", seq: 20, data: { callId: "native-review", name: "super_review", arguments: JSON.stringify({ action: "decide" }) } },
    { type: "tool/result", seq: 21, data: { message: { isError: false, source: { callId: "native-review" } } } },
  );
  const released = await tool.execute({
    action: "release", expectedRevision: 9, expectedGeneration: 1, workItemId: "item", mandateId: fixture.prepared.id,
  }, exec);
  assert.equal(released.ok, true);
  assert.equal(released.state?.workItems.item?.status, "accepted");
  assert.equal(fixture.readSessions(), 2);
});

test("PTC super-agent Reviewer is rejected before review with no state or audit mutation", async () => {
  const fixture = await reviewerFixture("super-agent");
  const before = fixture.repo.read("root-review");
  const evaluated = await fixture.definitions.get("super_review")!.execute({
    action: "evaluate", workItemId: "item",
  }, { agent: fixture.reviewer, signal: new AbortController().signal });
  assert.equal(evaluated.ok, false);
  assert.equal(evaluated.error?.code, "REVIEWER_PRESET_REQUIRED");
  const result = await fixture.definitions.get("super_review")!.execute({
    action: "decide", expectedRevision: 8, expectedGeneration: 1, workItemId: "item", mandateId: fixture.prepared.id,
    result: "pass", evidenceIds: fixture.evidenceIds,
  }, { agent: fixture.reviewer, signal: new AbortController().signal });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "REVIEWER_PRESET_REQUIRED");
  assert.match(result.error?.message ?? "", /agent_preset=standard/);
  assert.deepEqual(fixture.repo.read("root-review"), before);
  assert.equal(fixture.readSessions(), 0);
});

test("prepared or old-attempt Reviewer cannot record, decide or release through identity fallback", async () => {
  const fixture = await reviewerFixture("standard");
  const current = fixture.repo.read("root-review")!;
  const currentId = current.workItems.item!.currentMandateId!;
  const root = { id: "root-review", status: "running" };
  const makeTools = (state: NonNullable<ReturnType<RunRepository["read"]>>) => {
    const definitions = new Map<string, ReviewerTool>();
    let writes = 0;
    const repository = {
      read: () => state,
      transact: async () => { writes += 1; throw new Error("mutation must not be reached"); },
      evaluate: () => [],
    };
    const ctx = {
      tools: { register(definition: never) { definitions.set((definition as { name: string }).name, definition); return () => {}; } },
      subagents: { rootOf: () => root },
      sessionQuery: {
        observeSession: async () => ({ projections: { values: { agentPreset: "standard" } }, [Symbol.dispose]: () => {} }),
        readSession: async () => ({ events: [] }),
      },
    };
    registerSuperTools(ctx as never, repository as never);
    return { definitions, writes: () => writes };
  };
  const exec = { agent: fixture.reviewer, signal: new AbortController().signal };
  const common = {
    expectedRevision: current.run.revision, expectedGeneration: current.run.generation,
    workItemId: "item", mandateId: currentId,
  };

  const preparedState = structuredClone(current);
  preparedState.mandates[currentId]!.reviewerAgentId = undefined;
  const prepared = makeTools(preparedState);
  const preparedRecord = await prepared.definitions.get("super_evidence")!.execute({
    ...common, action: "record", kind: "unit", result: "pass", receipt: { passed: 1, failed: 0, total: 1 },
  }, exec);
  const preparedDecision = await prepared.definitions.get("super_review")!.execute({ ...common, action: "decide", result: "pass", evidenceIds: fixture.evidenceIds }, exec);
  const preparedRelease = await prepared.definitions.get("super_review")!.execute({ ...common, action: "release" }, exec);
  for (const result of [preparedRecord, preparedDecision, preparedRelease]) {
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "ACTOR_MISMATCH");
  }
  assert.equal(prepared.writes(), 0);

  const oldAttemptState = structuredClone(current);
  const old = oldAttemptState.mandates[currentId]!;
  const successor = { ...old, id: "mandate-successor", attempt: old.attempt + 1, reviewerAgentId: undefined };
  oldAttemptState.mandates[successor.id] = successor;
  oldAttemptState.workItems.item!.currentMandateId = successor.id;
  oldAttemptState.workItems.item!.attempt = successor.attempt;
  const oldAttempt = makeTools(oldAttemptState);
  const oldRecord = await oldAttempt.definitions.get("super_evidence")!.execute({
    ...common, action: "record", kind: "unit", result: "pass", receipt: { passed: 1, failed: 0, total: 1 },
  }, exec);
  const oldDecision = await oldAttempt.definitions.get("super_review")!.execute({ ...common, action: "decide", result: "pass", evidenceIds: fixture.evidenceIds }, exec);
  const oldRelease = await oldAttempt.definitions.get("super_review")!.execute({ ...common, action: "release" }, exec);
  for (const result of [oldRecord, oldDecision, oldRelease]) {
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "MANDATE_STALE");
  }
  assert.equal(oldAttempt.writes(), 0);
});

test("Reviewer write after pass requires recover, fresh binding and fresh evidence before acceptance", async () => {
  const fixture = await reviewerFixture("standard");
  const { repo, root, worker, nativeChildren, reviewer, definitions, prepared, evidenceIds, nativeEvents } = fixture;
  const reviewTool = definitions.get("super_review")!;
  const runTool = definitions.get("super_run")!;
  const mandateTool = definitions.get("super_mandate")!;
  const evidenceTool = definitions.get("super_evidence")!;
  const rootExec = { agent: root, signal: new AbortController().signal };
  const reviewerExec = { agent: reviewer, signal: new AbortController().signal };
  const decided = await reviewTool.execute({
    action: "decide", expectedRevision: 8, expectedGeneration: 1,
    workItemId: "item", mandateId: prepared.id, result: "pass", evidenceIds,
  }, reviewerExec);
  assert.equal(decided.ok, true);
  nativeEvents.push(
    { type: "tool/call", seq: 30, data: { callId: "reviewer-write", name: "write", arguments: JSON.stringify({ file_path: "forbidden.txt", content: "write" }) } },
    { type: "tool/result", seq: 31, data: { message: { isError: false, source: { kind: "tool", callId: "reviewer-write" } } } },
  );
  const rejected = await reviewTool.execute({
    action: "release", expectedRevision: 9, expectedGeneration: 1,
    workItemId: "item", mandateId: prepared.id,
  }, reviewerExec);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, "REVIEWER_NOT_READONLY");
  const originalItem = {
    id: "item", title: "Review work", dependencies: [], writeScopes: [], acceptance: ["independent evidence"],
    obligationIds: [], gateProfile: "code", hostContractRequired: false, mandatory: true,
  };
  const direct = await runTool.execute({
    action: "plan", expectedRevision: 9, expectedGeneration: 1, items: [originalItem],
  }, rootExec);
  assert.equal(direct.ok, false);
  assert.equal(direct.error?.code, "INVALID_TRANSITION");

  const recovered = await runTool.execute({ action: "recover" }, rootExec);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(repo.read(root.id)?.run.generation, 2);
  nativeEvents.length = 0; // The fresh Reviewer has no native write receipt; the old Reviewer is not called again.
  const freshReviewer = { id: "fresh-reviewer", status: "idle" };
  nativeChildren.push({ kind: "child", id: freshReviewer.id, path: "fresh-reviewer" });
  const freshExec = { agent: freshReviewer, signal: new AbortController().signal };
  const guard = () => ({
    expectedRevision: repo.read(root.id)!.run.revision,
    expectedGeneration: repo.read(root.id)!.run.generation,
  });
  const replanned = await runTool.execute({ action: "plan", ...guard(), items: [originalItem] }, rootExec);
  assert.equal(replanned.ok, true, JSON.stringify(replanned));
  const next = await mandateTool.execute({
    action: "prepare", ...guard(), workItemId: "item", workerAgentId: worker.id,
    reviewerAgentId: freshReviewer.id, knownFailures: ["Reviewer wrote after pass"],
  }, rootExec);
  assert.equal(next.ok, true, JSON.stringify(next));
  const nextMandate = next.value as unknown as { id: string; attempt: number; generation: number };
  const nextId = nextMandate.id;
  assert.equal(nextMandate.attempt, 2);
  assert.equal(nextMandate.generation, 2);
  assert.ok((await mandateTool.execute({ action: "bind", ...guard(), mandateId: nextId, workerAgentId: worker.id }, rootExec)).ok);
  assert.ok((await mandateTool.execute({ action: "report", ...guard(), mandateId: nextId, summary: "fresh Worker validation" }, { agent: worker, signal: new AbortController().signal })).ok);
  assert.ok((await mandateTool.execute({ action: "bindReviewer", ...guard(), mandateId: nextId, reviewerAgentId: freshReviewer.id }, rootExec)).ok);
  const build = await evidenceTool.execute({
    action: "record", ...guard(), workItemId: "item", mandateId: nextId,
    kind: "build", result: "pass", receipt: { exitCode: 0 }, summary: "fresh build evidence",
  }, freshExec);
  assert.equal(build.ok, true);
  const unit = await evidenceTool.execute({
    action: "record", ...guard(), workItemId: "item", mandateId: nextId,
    kind: "unit", result: "pass", receipt: { passed: 1, failed: 0, total: 1 }, summary: "fresh unit evidence",
  }, freshExec);
  assert.equal(unit.ok, true);
  const nextDecision = await reviewTool.execute({
    action: "decide", ...guard(), workItemId: "item", mandateId: nextId,
    result: "pass", evidenceIds: [build.value!.id!, unit.value!.id!],
  }, freshExec);
  assert.equal(nextDecision.ok, true, JSON.stringify(nextDecision));
  const released = await reviewTool.execute({ action: "release", ...guard(), workItemId: "item", mandateId: nextId }, freshExec);
  assert.equal(released.ok, true, JSON.stringify(released));
  assert.equal(repo.read(root.id)?.workItems.item?.status, "accepted");
  assert.equal(repo.read(root.id)?.workItems.item?.attempt, 2);
});

