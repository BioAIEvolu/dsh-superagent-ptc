import test from "node:test";
import assert from "node:assert/strict";
import { extractNativeFacts, hostObservedReceipt, resultFromNativeFacts, sanitizeModelReceipt } from "../../src/host/evidence.ts";
import { SuperAgentCore } from "../../src/core/index.ts";
import { createInput, drivers } from "./helpers.ts";

const toolResult = (value: unknown, isError = false) => [
  { type: "tool/call", seq: 10, data: { callId: "call-1", name: "pwsh", arguments: {} } },
  { type: "tool/result", seq: 11, data: { message: { isError, source: { callId: "call-1" }, content: [{ type: "text", text: JSON.stringify(value) }] } } },
];

test("host evidence binds native SessionId/seq and derives build result without raw content", () => {
  const events = toolResult({ exitCode: 0 });
  const facts = extractNativeFacts(events, 11);
  assert.equal(facts.toolName, "pwsh");
  assert.equal(resultFromNativeFacts("build", facts), "pass");
  const receipt = hostObservedReceipt("native-worker", 11, facts);
  assert.equal(receipt.hostObserved, true);
  assert.equal(receipt.provenance, "host_observed");
  assert.equal(receipt.eventSeq, 11);
  assert.equal(receipt.exitCode, 0);
  assert.equal(JSON.stringify(receipt).includes("exitCode: 0"), false, "raw tool content must not be persisted");
});

test("native failures and contradictory unit counts never become pass", () => {
  assert.equal(resultFromNativeFacts("build", extractNativeFacts(toolResult({ exitCode: 1 }), 11)), "fail");
  assert.equal(resultFromNativeFacts("unit", extractNativeFacts(toolResult({ passed: 0, failed: 65 }), 11)), "fail");
  assert.equal(resultFromNativeFacts("unit", extractNativeFacts(toolResult({ passed: 65 }), 11)), "unknown");
  assert.equal(resultFromNativeFacts("runtime_gui", extractNativeFacts(toolResult({ exitCode: 0 }), 11)), "unknown");
});

test("PTC dispatch parses bounded data.content facts with the same fail-closed semantics", () => {
  const events = [
    { type: "tool/ptc-dispatch", seq: 21, data: { name: "run_tests", isError: false, content: [{ type: "text", text: JSON.stringify({ passed: 7, failed: 0, total: 7, exitCode: 0 }) }] } },
  ];
  const facts = extractNativeFacts(events, 21);
  assert.equal(facts.toolName, "run_tests");
  assert.equal(facts.passed, 7);
  assert.equal(facts.failed, 0);
  assert.equal(resultFromNativeFacts("unit", facts), "pass");
  assert.equal(resultFromNativeFacts("build", facts), "pass");
  const plain = extractNativeFacts([{ type: "tool/ptc-dispatch", seq: 22, data: { content: "passed: 999" } }], 22);
  assert.equal(plain.passed, undefined);
  assert.equal(resultFromNativeFacts("unit", plain), "unknown");
});

test("coverage and host-contract facts remain bound and fail closed", () => {
  const unbound = extractNativeFacts(toolResult({ coverage: "full" }), 11);
  assert.equal(resultFromNativeFacts("coverage", unbound), "unknown");
  const bound = extractNativeFacts(toolResult({ coverage: "full", obligationId: "source-a" }), 11);
  assert.equal(resultFromNativeFacts("coverage", bound), "pass");
  const contract = extractNativeFacts(toolResult({ activityCount: 2, emptyReason: "no_activity" }), 11);
  const receipt = hostObservedReceipt("native-reviewer", 11, contract);
  assert.equal(receipt.activityCount, 2);
  assert.equal(receipt.emptyReason, "no_activity");
});

test("hostObservedReceipt passes the real core boundary with nativeAgentId", () => {
  const core = new SuperAgentCore(drivers());
  assert.ok(core.createRun(createInput("root-a")).ok);
  assert.ok(core.planWorkItems({ expectedRevision: 1, expectedGeneration: 1, items: [{ id: "item", title: "Work", dependencies: [], writeScopes: [], acceptance: ["verified"], obligationIds: [], gateProfile: "code", hostContractRequired: true }] }).ok);
  const prepared = core.prepareMandate({ expectedRevision: 2, expectedGeneration: 1, workItemId: "item", workerId: "worker-native", reviewerId: "reviewer-native", knownFailures: [] });
  assert.ok(prepared.ok);
  assert.ok(core.bindExecution({ expectedRevision: 3, expectedGeneration: 1, mandateId: prepared.value.id, workerAgentId: "worker-native" }).ok);
  const facts = extractNativeFacts(toolResult({ activityCount: 1 }), 11);
  const recorded = core.recordEvidence({
    expectedRevision: 4, expectedGeneration: 1, workItemId: "item", mandateId: prepared.value.id,
    attempt: 1, kind: "host_contract", result: "pass", sourceActor: "host", sourceRole: "host",
    receipt: hostObservedReceipt("worker-native", 11, facts), summary: "host observed native tool event",
  });
  assert.ok(recorded.ok);
  assert.equal(recorded.value.receipt.nativeAgentId, "worker-native");
});

test("model receipt is explicitly model_reported and cannot mint hostObserved or credentials", () => {
  const receipt = sanitizeModelReceipt({ exitCode: 0 });
  assert.equal(receipt.hostObserved, false);
  assert.equal(receipt.provenance, "model_reported");
  assert.throws(() => sanitizeModelReceipt({ hostObserved: true } as never), /allowlist/);
  assert.throws(() => sanitizeModelReceipt({ access_token: "synthetic" } as never), /sensitive/);
  assert.throws(() => extractNativeFacts([], 99), /not readable/);
});
