import test from "node:test";
import assert from "node:assert/strict";
import type { JsonValue } from "../../src/core/index.ts";
import { registerSuperTools } from "../../src/host/tools.ts";
import { RunRepository } from "../../src/host/store.ts";
import { createInput, drivers, MemoryProofStore, MemoryTable } from "./helpers.ts";

type EvidenceToolResult = {
  ok: boolean;
  value?: {
    id?: string;
    kind?: string;
    result?: string;
    receipt?: Record<string, JsonValue>;
  };
  error?: { code: string; message: string };
};
type EvidenceTool = { execute(args: unknown, exec: unknown): Promise<EvidenceToolResult> };
type NativeFixtureEvent = { type: string; seq: number; data: Record<string, unknown> };

async function fixture(mode: "coverage" | "unrelated" | "host_contract" = "coverage") {
  const root = { id: "root-delivery-fixture", status: "running" };
  const worker = { id: "worker-delivery-fixture", status: "inactive" };
  const nativeEvents = new Map<string, NativeFixtureEvent[]>([[root.id, []], [worker.id, []]]);
  const reads: string[] = [];
  const definitions = new Map<string, EvidenceTool>();
  const ctx = {
    tools: { register(definition: never) { definitions.set((definition as { name: string }).name, definition); return () => {}; } },
    subagents: {
      rootOf: () => root,
      listDescendants: async () => [{ kind: "child", id: worker.id, path: "worker" }],
    },
    sessionQuery: {
      readSession: async (id: string) => {
        reads.push(id);
        return { events: nativeEvents.get(id) ?? [] };
      },
    },
  };
  const repo = new RunRepository(new MemoryTable(), drivers(), undefined, new MemoryProofStore());
  registerSuperTools(ctx as never, repo);
  const input = createInput(root.id);
  const hasCoverage = mode !== "host_contract";
  assert.ok((await repo.create(root.id, {
    ...input,
    obligations: hasCoverage ? [{
      id: "coverage-delivery", kind: "coverage", text: "Prove the current native Mandate delivery", sourceId: "native-mandate-delivery",
      ...(mode === "coverage" ? { verification: "mandate_delivery" as const } : {}),
    }] : [],
  })).ok);
  assert.ok((await repo.transact(root.id, core => core.planWorkItems({
    expectedRevision: 1, expectedGeneration: 1,
    items: [{
      id: "item", title: "Deliver current Mandate", dependencies: [], writeScopes: [], acceptance: ["Lead send and Worker receipt match"],
      obligationIds: hasCoverage ? ["coverage-delivery"] : [], gateProfile: hasCoverage ? "coverage" : "code",
      ...(mode === "host_contract" ? { hostContractRequired: true } : {}),
    }],
  }))).ok);
  const prepared = await repo.transact(root.id, core => core.prepareMandate({
    expectedRevision: 2, expectedGeneration: 1, workItemId: "item", workerId: worker.id, reviewerId: "reviewer-delivery-fixture", knownFailures: [],
  }));
  assert.ok(prepared.ok);
  assert.ok((await repo.transact(root.id, core => core.bindExecution({
    expectedRevision: 3, expectedGeneration: 1, mandateId: prepared.value.id, workerAgentId: worker.id,
  }))).ok);
  return {
    root, worker, nativeEvents, reads, repo,
    mandate: prepared.value,
    message: `${prepared.value.mandateText}\n\nACTION NOW: execute the current WorkItem`,
    tool: definitions.get("super_evidence")!,
  };
}

function leadSend(rootEvents: NativeFixtureEvent[], message: string, target = "worker"): void {
  rootEvents.push(
    {
      type: "tool/call", seq: 100,
      data: { callId: "native-send-call", name: "send_message", arguments: JSON.stringify({ agent: target, message }) },
    },
    {
      type: "tool/result", seq: 101,
      data: { message: { isError: false, source: { kind: "tool", callId: "native-send-call" }, content: [] } },
    },
  );
}

function workerReceipt(workerEvents: NativeFixtureEvent[], rootId: string, message: string, nested = false): void {
  const body = {
    id: "native-worker-message",
    content: [{ type: "text", text: "Agent lead sent a message: " }, { type: "text", text: message }],
    source: { kind: "agent-message", senderSessionId: rootId },
  };
  workerEvents.push({ type: "user/message", seq: 201, data: nested ? { message: body } : body });
}

function verifyArgs(s: Awaited<ReturnType<typeof fixture>>, expectedRevision = 4): Record<string, unknown> {
  return {
    action: "verify", verification: "mandate_delivery", expectedRevision, expectedGeneration: 1,
    workItemId: "item", mandateId: s.mandate.id,
  };
}

test("mandate_delivery verifies real split-block native delivery and directly records bound host_observed coverage", async () => {
  const s = await fixture();
  leadSend(s.nativeEvents.get(s.root.id)!, s.message);
  workerReceipt(s.nativeEvents.get(s.worker.id)!, s.root.id, s.message);
  const result = await s.tool.execute(verifyArgs(s), { agent: s.root, signal: new AbortController().signal });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value?.kind, "coverage");
  assert.equal(result.value?.result, "pass");
  const receipt = result.value?.receipt ?? {};
  assert.equal(receipt.hostObserved, true);
  assert.equal(receipt.provenance, "host_observed");
  assert.equal(receipt.verification, "mandate_delivery");
  assert.equal(receipt.coverage, "full");
  assert.equal(receipt.obligationId, "coverage-delivery");
  assert.equal(receipt.sourceId, "native-mandate-delivery");
  assert.equal(receipt.mandateId, s.mandate.id);
  assert.equal(receipt.attempt, 1);
  assert.equal(receipt.generation, 1);
  assert.equal(receipt.leadNativeAgentId, s.root.id);
  assert.equal(receipt.workerNativeAgentId, s.worker.id);
  assert.equal(receipt.leadEventSeq, 101);
  assert.equal(receipt.leadCallId, "native-send-call");
  assert.equal(receipt.workerEventSeq, 201);
  assert.equal(receipt.workerMessageId, "native-worker-message");
  assert.equal("content" in receipt, false);
  assert.equal("mandateText" in receipt, false);
  assert.deepEqual(s.reads, [s.root.id, s.worker.id]);
  assert.equal(s.repo.read(s.root.id)?.run.revision, 5);
  assert.equal(s.repo.read(s.root.id)?.evidence[result.value!.id!]?.result, "pass");
});

test("PTC dispatch is a completed Lead send and a bound Worker may request verification", async () => {
  const s = await fixture();
  s.nativeEvents.get(s.root.id)!.push({
    type: "tool/ptc-dispatch", seq: 111,
    data: { subCallId: "ptc-send-call", name: "send_message", arguments: { agent: "worker", message: s.message }, isError: false, content: [] },
  });
  workerReceipt(s.nativeEvents.get(s.worker.id)!, s.root.id, s.message);
  const result = await s.tool.execute(verifyArgs(s), { agent: s.worker, signal: new AbortController().signal });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value?.result, "pass");
  assert.equal(result.value?.receipt?.leadEventType, "tool/ptc-dispatch");
  assert.equal(result.value?.receipt?.leadEventSeq, 111);
  assert.equal(result.value?.receipt?.leadCallId, "ptc-send-call");
});

test("agent/inbox/spliced carries the real first Worker delivery without requiring user/message", async () => {
  const s = await fixture();
  s.nativeEvents.get(s.root.id)!.push({
    type: "tool/ptc-dispatch", seq: 111,
    data: { subCallId: "ptc-send-call", name: "send_message", arguments: { agent: "worker", message: s.message }, isError: false, content: [] },
  });
  s.nativeEvents.get(s.worker.id)!.push({
    type: "agent/inbox/spliced", seq: 37,
    data: {
      target: "next-step", start: 0,
      inserted: [{
        id: "native-worker-message",
        content: [{ type: "text", text: "Agent lead sent a message: " }, { type: "text", text: s.message }],
        source: { kind: "agent-message", form: "relay", senderSessionId: s.root.id },
        role: "user",
      }],
    },
  });
  const result = await s.tool.execute(verifyArgs(s), { agent: s.root, signal: new AbortController().signal });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value?.result, "pass");
  assert.equal(result.value?.receipt?.workerEventType, "agent/inbox/spliced");
  assert.equal(result.value?.receipt?.workerEventSeq, 37);
  assert.equal(result.value?.receipt?.workerMessageId, "native-worker-message");
});

test("a bare Lead tool/call without a successful result remains unknown even when Worker text matches", async () => {
  const s = await fixture();
  s.nativeEvents.get(s.root.id)!.push({
    type: "tool/call", seq: 100,
    data: { callId: "intent-only", name: "send_message", arguments: { agent: "worker", message: s.message } },
  });
  workerReceipt(s.nativeEvents.get(s.worker.id)!, s.root.id, s.message);
  const result = await s.tool.execute(verifyArgs(s), { agent: s.root, signal: new AbortController().signal });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value?.result, "unknown");
  assert.equal(result.value?.receipt?.reason, "lead_send_missing");
  assert.equal(result.value?.receipt?.coverage, "unknown");
});

test("unbound descendants and the prepared reviewerId placeholder cannot write verification coverage", async () => {
  const s = await fixture();
  for (const actor of [{ id: "unrelated-super-agent" }, { id: "reviewer-delivery-fixture" }]) {
    const result = await s.tool.execute(verifyArgs(s), { agent: actor, signal: new AbortController().signal });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "ACTOR_MISMATCH");
  }
  assert.equal(s.repo.read(s.root.id)?.run.revision, 4);
  assert.equal(Object.keys(s.repo.read(s.root.id)?.evidence ?? {}).length, 0);
});

test("mandate_delivery records unknown when current native evidence is absent", async () => {
  const s = await fixture();
  const result = await s.tool.execute(verifyArgs(s), { agent: s.root, signal: new AbortController().signal });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value?.result, "unknown");
  assert.equal(result.value?.receipt?.coverage, "unknown");
  assert.equal(result.value?.receipt?.reason, "mandate_delivery_not_found");
  assert.equal(result.value?.receipt?.leadEventSeq, undefined);
  assert.equal(result.value?.receipt?.workerMessageId, undefined);
});

test("mandate_delivery records fail for an explicit Lead/Worker text mismatch, including nested message shape", async () => {
  const s = await fixture();
  leadSend(s.nativeEvents.get(s.root.id)!, s.message);
  workerReceipt(s.nativeEvents.get(s.worker.id)!, s.root.id, `${s.mandate.mandateText}\n\nACTION NOW: execute a different action`, true);
  const result = await s.tool.execute(verifyArgs(s), { agent: s.root, signal: new AbortController().signal });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value?.result, "fail");
  assert.equal(result.value?.receipt?.coverage, "unknown");
  assert.equal(result.value?.receipt?.reason, "lead_worker_message_mismatch");
  assert.equal(result.value?.receipt?.leadEventSeq, 101);
  assert.equal(result.value?.receipt?.workerEventSeq, 201);
});

test("mandate_delivery rejects an explicit wrong Worker target instead of minting full coverage", async () => {
  const s = await fixture();
  leadSend(s.nativeEvents.get(s.root.id)!, s.message, "another-worker");
  const result = await s.tool.execute(verifyArgs(s), { agent: s.root, signal: new AbortController().signal });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value?.result, "fail");
  assert.equal(result.value?.receipt?.reason, "worker_target_mismatch");
  assert.equal(result.value?.receipt?.coverage, "unknown");
});

test("an unrelated coverage obligation without verification=mandate_delivery cannot be closed", async () => {
  const s = await fixture("unrelated");
  leadSend(s.nativeEvents.get(s.root.id)!, s.message);
  workerReceipt(s.nativeEvents.get(s.worker.id)!, s.root.id, s.message);
  const result = await s.tool.execute(verifyArgs(s), { agent: s.root, signal: new AbortController().signal });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "COVERAGE_OBLIGATION_REQUIRED");
  assert.equal(s.repo.read(s.root.id)?.run.revision, 4);
  assert.equal(Object.keys(s.repo.read(s.root.id)?.evidence ?? {}).length, 0);
});

test("mandate_delivery produces host_contract without any coverage obligation and real activity", async () => {
  const s = await fixture("host_contract");
  leadSend(s.nativeEvents.get(s.root.id)!, s.message);
  workerReceipt(s.nativeEvents.get(s.worker.id)!, s.root.id, s.message);
  const result = await s.tool.execute({ ...verifyArgs(s), kind: "host_contract" }, { agent: s.root, signal: new AbortController().signal });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value?.kind, "host_contract");
  assert.equal(result.value?.result, "pass");
  const receipt = result.value?.receipt ?? {};
  assert.equal(receipt.hostObserved, true);
  assert.equal(receipt.verification, "mandate_delivery");
  assert.equal(receipt.activityCount, 2);
  assert.ok((receipt.activityCount as number) >= 1);
  assert.equal(receipt.coverage, undefined);
  assert.equal(receipt.obligationId, undefined);
  assert.equal(receipt.leadEventSeq, 101);
  assert.equal(receipt.workerEventSeq, 201);
  assert.equal(receipt.workerMessageId, "native-worker-message");
});

test("host_contract missing or contradictory delivery evidence cannot become pass", async () => {
  const missing = await fixture("host_contract");
  const unknown = await missing.tool.execute({ ...verifyArgs(missing), kind: "host_contract" }, { agent: missing.root, signal: new AbortController().signal });
  assert.equal(unknown.ok, true, JSON.stringify(unknown));
  assert.equal(unknown.value?.result, "unknown");
  assert.equal(unknown.value?.receipt?.activityCount, 0);

  const mismatch = await fixture("host_contract");
  leadSend(mismatch.nativeEvents.get(mismatch.root.id)!, mismatch.message);
  workerReceipt(mismatch.nativeEvents.get(mismatch.worker.id)!, mismatch.root.id, `${mismatch.mandate.mandateText}\n\nACTION NOW: contradictory action`);
  const failed = await mismatch.tool.execute({ ...verifyArgs(mismatch), kind: "host_contract" }, { agent: mismatch.root, signal: new AbortController().signal });
  assert.equal(failed.ok, true, JSON.stringify(failed));
  assert.equal(failed.value?.result, "fail");
  assert.notEqual(failed.value?.result, "pass");
});

test("Worker coverage self-report and prepared Reviewer placeholder records fail closed", async () => {
  const s = await fixture();
  const cases = [
    { actor: s.worker, kind: "coverage", code: "EVIDENCE_VERIFICATION_REQUIRED" },
    { actor: { id: "reviewer-delivery-fixture" }, kind: "coverage", code: "ACTOR_MISMATCH" },
    { actor: { id: "reviewer-delivery-fixture" }, kind: "unit", code: "ACTOR_MISMATCH" },
  ];
  for (const entry of cases) {
    const result = await s.tool.execute({
      action: "record", expectedRevision: 4, expectedGeneration: 1, workItemId: "item", mandateId: s.mandate.id,
      kind: entry.kind, result: "pass",
      receipt: { coverage: "full", obligationId: "coverage-delivery", passed: 1, failed: 0, total: 1 },
    }, { agent: entry.actor, signal: new AbortController().signal });
    assert.equal(result.ok, false, `${entry.kind} unexpectedly accepted`);
    assert.equal(result.error?.code, entry.code);
  }
  assert.equal(s.repo.read(s.root.id)?.run.revision, 4);
  assert.equal(Object.keys(s.repo.read(s.root.id)?.evidence ?? {}).length, 0);

  const workerUnit = await s.tool.execute({
    action: "record", expectedRevision: 4, expectedGeneration: 1, workItemId: "item", mandateId: s.mandate.id,
    kind: "unit", result: "pass", receipt: { passed: 1, failed: 0, total: 1 },
  }, { agent: s.worker, signal: new AbortController().signal });
  assert.equal(workerUnit.ok, true, JSON.stringify(workerUnit));
  assert.equal(workerUnit.value?.kind, "unit");
});

test("generic shell results and the verify tool receipt cannot mint coverage or host_contract", async () => {
  const s = await fixture();
  const selfReport = JSON.stringify({ result: "pass", coverage: "full", obligationId: "coverage-delivery" });
  s.nativeEvents.get(s.worker.id)!.push({
    type: "tool/result", seq: 210,
    data: { name: "pwsh", message: { isError: false, source: { callId: "shell-pass" }, content: [{ type: "text", text: selfReport }] } },
  });
  for (const kind of ["coverage", "host_contract"]) {
    const observed = await s.tool.execute({
      action: "observe", expectedRevision: 4, expectedGeneration: 1, workItemId: "item", mandateId: s.mandate.id,
      sessionId: s.worker.id, eventSeq: 210, kind,
    }, { agent: s.root, signal: new AbortController().signal });
    assert.equal(observed.ok, false);
    assert.equal(observed.error?.code, "EVIDENCE_VERIFICATION_REQUIRED");
  }

  s.nativeEvents.get(s.root.id)!.push(
    { type: "tool/call", seq: 100, data: { callId: "verify-call", name: "super_evidence", arguments: JSON.stringify({ action: "verify", verification: "mandate_delivery" }) } },
    { type: "tool/result", seq: 102, data: { name: "super_evidence", message: { isError: false, source: { callId: "verify-call" }, content: [{ type: "text", text: selfReport }] } } },
  );
  const recursive = await s.tool.execute({
    action: "observe", expectedRevision: 4, expectedGeneration: 1, workItemId: "item", mandateId: s.mandate.id,
    sessionId: s.root.id, eventSeq: 102, kind: "build",
  }, { agent: s.root, signal: new AbortController().signal });
  assert.equal(recursive.ok, false);
  assert.equal(recursive.error?.code, "EVIDENCE_EVENT_UNSUPPORTED");
  assert.equal(s.repo.read(s.root.id)?.run.revision, 4);
  assert.equal(Object.keys(s.repo.read(s.root.id)?.evidence ?? {}).length, 0);
});
