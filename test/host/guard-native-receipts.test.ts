import test from "node:test";
import assert from "node:assert/strict";
import { successfulMutatingEvents } from "../../src/host/guard.ts";

const nativePair = (seq: number, callId: string, name: string, args: unknown) => [
  { type: "tool/call", seq, data: { callId, name, arguments: JSON.stringify(args) } },
  { type: "tool/result", seq: seq + 1, data: { message: { isError: false, source: { kind: "tool", callId } } } },
];

test("Ark-shaped native Reviewer receipts parse callId-paired JSON-string actions", () => {
  const events = [
    ...nativePair(10, "evidence-record", "super_evidence", { action: "record", kind: "coverage", result: "pass" }),
    ...nativePair(20, "review-evaluate", "super_review", { action: "evaluate", workItemId: "W1" }),
    ...nativePair(30, "review-decide", "super_review", { action: "decide", result: "pass" }),
    ...nativePair(40, "review-release", "super_review", { action: "release", workItemId: "W1" }),
    ...nativePair(50, "snapshot", "super_snapshot", {}),
    ...nativePair(60, "native-read", "read", { file_path: "fixture.txt" }),
  ];
  assert.deepEqual(successfulMutatingEvents(events), []);
});

test("native result name fields and PTC dispatch recognize only supervisory actions", () => {
  const events = [
    { type: "tool/result", seq: 1, data: { name: "super_evidence", arguments: { action: "record" }, message: { isError: false, source: { callId: "a" } } } },
    { type: "tool/result", seq: 2, data: { toolName: "super_evidence", args: { action: "observe" }, message: { isError: false, source: { callId: "b" } } } },
    { type: "tool/result", seq: 3, data: { arguments: { action: "evaluate" }, message: { isError: false, source: { callId: "c", name: "super_review" } } } },
    { type: "tool/result", seq: 4, data: { args: { action: "decide" }, message: { isError: false, source: { callId: "d", toolName: "super_review" } } } },
    { type: "tool/result", seq: 5, data: { message: { isError: false, source: { callId: "e", name: "super_snapshot" } } } },
    { type: "tool/ptc-dispatch", seq: 6, data: { subCallId: "p:ptc:1", name: "super_evidence", arguments: { action: "list" }, isError: false, content: [] } },
    { type: "tool/ptc-dispatch", seq: 7, data: { subCallId: "p:ptc:2", name: "super_review", arguments: { action: "release" }, isError: false, content: [] } },
  ];
  assert.deepEqual(successfulMutatingEvents(events), []);
});

test("writes, shell, PTC, unknown actions and conflicting tool identities still fail closed", () => {
  const events = [
    ...nativePair(10, "write", "write", { file_path: "result.md", content: "no" }),
    ...nativePair(20, "shell", "pwsh", { command: "Write-Output no" }),
    ...nativePair(30, "ptc", "run_code", { code: "return 1" }),
    ...nativePair(40, "unknown", "unlisted_custom_tool", {}),
    ...nativePair(50, "unknown-evidence-action", "super_evidence", { action: "delete" }),
    ...nativePair(60, "unknown-review-action", "super_review", { action: "override" }),
    ...nativePair(70, "lead-plan", "super_run", { action: "plan" }),
    ...nativePair(80, "lead-anchor", "super_anchor", { action: "create" }),
    ...nativePair(90, "worker-report", "super_mandate", { action: "report" }),
    { type: "tool/call", seq: 100, data: { callId: "conflict", name: "write", arguments: "{}" } },
    { type: "tool/result", seq: 101, data: { name: "read", message: { isError: false, source: { callId: "conflict" } } } },
  ];
  const violations = successfulMutatingEvents(events);
  assert.deepEqual(violations.map(item => item.seq), [11, 21, 31, 41, 51, 61, 71, 81, 91, 101]);
  assert.equal(violations.at(-1)?.operation, "unknown");
});

test("working_directory navigation and sessiongraph reads are safe while extra fields/index fail closed", () => {
  const safe = [
    ...nativePair(10, "cwd-read", "working_directory", {}),
    ...nativePair(15, "cwd-navigate", "working_directory", { cd: "D:/Project/DSH" }),
    ...nativePair(20, "session-search", "sessiongraph", { operation: "search", query: "evidence" }),
    ...nativePair(30, "session-status", "sessiongraph", { operation: "status" }),
  ];
  assert.deepEqual(successfulMutatingEvents(safe), []);
  const unsafe = [
    ...nativePair(40, "cwd-unknown", "working_directory", { cd: "D:/Project/DSH", unexpected: true }),
    ...nativePair(50, "session-index", "sessiongraph", { operation: "index" }),
  ];
  assert.deepEqual(successfulMutatingEvents(unsafe).map(item => item.seq), [41, 51]);
});

test("ordinary standard read results are safe but failed writes are not new violations", () => {
  const events = [
    ...nativePair(1, "read", "read", { file_path: "fixture.txt" }),
    { type: "tool/call", seq: 3, data: { callId: "failed-write", name: "write", arguments: "{}" } },
    { type: "tool/result", seq: 4, data: { message: { isError: true, source: { callId: "failed-write" } } } },
  ];
  assert.deepEqual(successfulMutatingEvents(events), []);
});
