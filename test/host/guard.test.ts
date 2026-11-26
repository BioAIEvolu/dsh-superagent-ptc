import test from "node:test";
import assert from "node:assert/strict";
import { classifyToolSafety, reviewerToolDenial, successfulMutatingEvents } from "../../src/host/guard.ts";

test("Reviewer guard fails closed for writes, unknown tools and arbitrary PTC run_code", () => {
  assert.equal(reviewerToolDenial("read"), undefined);
  assert.equal(reviewerToolDenial("super_review", { action: "decide" }), undefined);
  assert.match(reviewerToolDenial("edit") ?? "", /read-only/);
  assert.match(reviewerToolDenial("run_code") ?? "", /Forbidden Reviewer PTC run_code/);
  assert.match(reviewerToolDenial("run_code") ?? "", /agent_preset=standard/);
  assert.match(reviewerToolDenial("unlisted_custom_tool") ?? "", /unknown/);
  assert.equal(classifyToolSafety("super_run", { action: "show" }), "supervisory");
  assert.equal(classifyToolSafety("super_run", { action: "complete" }), "write");
  assert.equal(classifyToolSafety("codeflow_map", { action: "graph" }), "read");
  assert.equal(classifyToolSafety("codeflow_map", { action: "init" }), "write");
  assert.equal(classifyToolSafety("working_directory"), "read");
  assert.equal(classifyToolSafety("working_directory", {}), "read");
  assert.equal(classifyToolSafety("working_directory", { cd: "D:/Project/DSH" }), "read");
  assert.equal(classifyToolSafety("working_directory", { cd: "D:/Project/DSH", unexpected: true }), "unknown");
  assert.equal(classifyToolSafety("working_directory", { cd: 42 }), "unknown");
  for (const operation of ["search", "session", "event", "trace", "timeline", "workspaces", "status", "touched"]) {
    assert.equal(classifyToolSafety("sessiongraph", { operation }), "read");
  }
  assert.equal(classifyToolSafety("sessiongraph", {}), "read");
  assert.equal(classifyToolSafety("sessiongraph", { operation: "index" }), "write");
  assert.equal(classifyToolSafety("sessiongraph", { operation: "unknown" }), "unknown");
  assert.equal(classifyToolSafety("super_evidence", { action: "verify" }), "supervisory");
});

test("only successful native mutating receipts invalidate Reviewer", () => {
  const events = [
    { type: "tool/call", seq: 1, data: { callId: "w", name: "edit" } },
    { type: "tool/result", seq: 2, data: { message: { isError: false, source: { callId: "w" } } } },
    { type: "tool/call", seq: 3, data: { callId: "d", name: "write" } },
    { type: "tool/result", seq: 4, data: { message: { isError: true, source: { callId: "d" } } } },
    { type: "tool/call", seq: 5, data: { callId: "review", name: "super_review", arguments: { action: "decide" } } },
    { type: "tool/result", seq: 6, data: { message: { isError: false, source: { callId: "review" } } } },
  ];
  const violations = successfulMutatingEvents(events);
  assert.deepEqual(violations.map(item => item.seq), [2]);
});
