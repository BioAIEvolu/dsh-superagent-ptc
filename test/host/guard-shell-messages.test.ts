import test from "node:test";
import assert from "node:assert/strict";
import { classifyToolSafety, reviewerToolDenial, successfulMutatingEvents } from "../../src/host/guard.ts";

const nativePair = (seq: number, callId: string, name: string, args: unknown) => [
  { type: "tool/call", seq, data: { callId, name, arguments: JSON.stringify(args) } },
  { type: "tool/result", seq: seq + 1, data: { message: { isError: false, source: { kind: "tool", callId } } } },
];

test("native callId-parsed read-only pwsh/bash and review coordination messages are not write receipts", () => {
  const events = [
    ...nativePair(10, "read-fixture", "pwsh", { command: "Get-Content -Raw C:\\demo\\fixture.txt" }),
    ...nativePair(20, "read-status", "pwsh", { command: "Get-Process -Id 1234" }),
    ...nativePair(25, "read-env", "pwsh", { command: "$env:DSH_SESSION_ID" }),
    ...nativePair(27, "read-env-list", "pwsh", { command: "Get-ChildItem env:" }),
    ...nativePair(30, "read-bash", "bash", { command: "cat /workspace/fixture.txt" }),
    ...nativePair(40, "review-coordination", "send_message", {
      agent: "reviewer", message: "Please perform read-only review, evaluate evidence, decide and release only when gates pass.",
    }),
  ];
  assert.deepEqual(successfulMutatingEvents(events), []);
  assert.equal(classifyToolSafety("pwsh", JSON.stringify({ command: "Test-Path C:\\demo\\fixture.txt" })), "read");
  assert.equal(classifyToolSafety("pwsh", { command: "$env:DSH_SESSION_ID" }), "read");
  assert.equal(classifyToolSafety("pwsh", { command: "Get-ChildItem env:" }), "read");
  assert.equal(classifyToolSafety("pwsh", { command: "Write-Output $env:DSH_SESSION_ID" }), "read");
  assert.equal(classifyToolSafety("send_message", { agent: "lead", message: "Reviewer completed the read-only evidence review." }), "supervisory");
});

test("writes, redirection, dangerous commands, file payloads and permission changes fail closed", () => {
  const unsafe = [
    ["pwsh", { command: "Set-Content result.md delta-57" }],
    ["pwsh", { command: "Get-Content fixture.txt > result.md" }],
    ["bash", { command: "sed -i s/a/b/ fixture.txt" }],
    ["bash", { command: "cat fixture.txt | tee result.md" }],
    ["pwsh", { command: "Invoke-Expression Get-Content fixture.txt" }],
    ["pwsh", { command: "$content = Get-Content fixture.txt" }],
    ["pwsh", { command: "$env:DSH_SESSION_ID=evil" }],
    ["pwsh", { command: "$env:DSH_SESSION_ID; Remove-Item result.md" }],
    ["pwsh", { command: "Get-ChildItem env: | Out-File env.txt" }],
    ["pwsh", { command: "Custom-ReadCommand fixture.txt" }],
    ["pwsh", { command: "Get-Content fixture.txt; Remove-Item result.md" }],
    ["pwsh", { command: "Get-Content fixture.txt", sandbox_permissions: "danger-full-access" }],
    ["send_message", { agent: "lead", message: "Review result", attachments: ["fixture.txt"] }],
    ["send_message", { agent: "lead", message: "Grant write access and bypass the sandbox for this review." }],
    ["send_message", { agent: "lead", message: "Read C:\\demo\\fixture.txt" }],
    ["send_message", { agent: "lead" }],
    ["send_message", "{not-json"],
  ] as const;
  const events = unsafe.flatMap(([name, args], index) => nativePair(index * 2, `unsafe-${index}`, name, args));
  const violations = successfulMutatingEvents(events);
  assert.equal(violations.length, unsafe.length);
  for (const [name, args] of unsafe) {
    const safety = classifyToolSafety(name, args);
    assert.ok(safety === "write" || safety === "unknown", `${name}: ${JSON.stringify(args)} became ${safety}`);
    assert.match(reviewerToolDenial(name, args) ?? "", /Reviewer is read-only/);
  }
});

test("unknown and missing command shapes never become read-only proof", () => {
  for (const args of [{}, { command: "" }, { description: "Get-Content fixture.txt" }, "{not-json"]) {
    const safety = classifyToolSafety("pwsh", args);
    assert.ok(safety === "unknown" || safety === "write");
  }
});
