import test from "node:test";
import assert from "node:assert/strict";
import { ToolArgsError } from "@deepseek-ai/dsh-tools";
import { registerSuperTools } from "../../src/host/tools.ts";
import { RunRepository } from "../../src/host/store.ts";
import { drivers, MemoryProofStore, MemoryTable } from "./helpers.ts";

test("real create rejects missing kind/unknown obligation fields and then accepts valid obligations", async () => {
  const table = new MemoryTable();
  const repo = new RunRepository(table, drivers(), undefined, new MemoryProofStore());
  const root = { id: "root-obligations", status: "idle" };
  const definitions = new Map<string, { execute(args: unknown, exec: unknown): Promise<{ ok: boolean; state: { obligations: Record<string, { kind: string }> } }> }>();
  const ctx = {
    tools: { register(definition: never) { definitions.set((definition as { name: string }).name, definition); return () => {}; } },
    subagents: { rootOf: () => root },
  };
  registerSuperTools(ctx as never, repo);
  const tool = definitions.get("super_run")!;
  const exec = { agent: root, signal: new AbortController().signal };
  const base = { action: "create", objective: "Verify obligations", definitionOfDone: "All gates pass" };

  await assert.rejects(tool.execute({
    ...base, obligations: [{ id: "missing-kind", text: "kind is required" }],
  }, exec), (error: unknown) => {
    assert.ok(error instanceof ToolArgsError);
    assert.match(error.violations.join("\n"), /kind|required/);
    return true;
  });
  await assert.rejects(tool.execute({
    ...base, obligations: [{ id: "unknown-field", kind: "requirement", text: "no status input", status: "open" }],
  }, exec), (error: unknown) => error instanceof ToolArgsError && error.violations.some(item => item.includes("status")));
  assert.equal(repo.read(root.id), null, "invalid model args must not create a partial Run");

  const created = await tool.execute({
    ...base,
    obligations: [
      { id: "requirement", kind: "requirement", text: "Implement the outcome" },
      { id: "prohibition", kind: "prohibition", text: "Do not add glow" },
      { id: "visual", kind: "requirement", text: "Verify the real animation", requiredEvidence: ["runtime_gui", "animation"], animation: "clockwise_sweep" },
      { id: "coverage", kind: "coverage", text: "Cover the primary source", coverage: "full", sourceId: "source-a" },
    ],
  }, exec);
  assert.equal(created.ok, true);
  assert.equal(Object.keys(created.state.obligations).length, 4);
  assert.equal(created.state.obligations.requirement?.kind, "requirement");
  assert.equal(created.state.obligations.prohibition?.kind, "prohibition");
  assert.equal(created.state.obligations.coverage?.kind, "coverage");
});
