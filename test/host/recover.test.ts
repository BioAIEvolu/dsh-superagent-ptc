import test from "node:test";
import assert from "node:assert/strict";
import { ToolArgsError } from "@deepseek-ai/dsh-tools";
import { registerSuperTools } from "../../src/host/tools.ts";
import { RunRepository } from "../../src/host/store.ts";
import { createInput, drivers, MemoryProofStore, MemoryTable } from "./helpers.ts";

type ToolValue = {
  ok: boolean;
  error?: { code: string; message: string };
  state: {
    run: { revision: number; generation: number };
    workItems: Record<string, { id: string }>;
    audit: { type: string; generation: number }[];
  };
};
type Executable = { execute(args: unknown, exec: unknown): Promise<ToolValue> };

const validItem = {
  id: "item",
  title: "Implement bounded work",
  dependencies: [],
  writeScopes: ["src/host"],
  acceptance: ["real tests pass"],
  obligationIds: [],
  gateProfile: "code",
};

async function scenario(createRun = true) {
  const table = new MemoryTable();
  const proofs = new MemoryProofStore();
  const repo = new RunRepository(table, drivers(), undefined, proofs);
  const root = { id: "root-recover", status: "idle" };
  const definitions = new Map<string, Executable>();
  const ctx = {
    tools: { register(definition: never) { definitions.set((definition as { name: string }).name, definition); return () => {}; } },
    subagents: { rootOf: () => root },
  };
  registerSuperTools(ctx as never, repo);
  const tool = definitions.get("super_run")!;
  const exec = { agent: root, signal: new AbortController().signal };
  if (createRun) {
    const input = createInput(root.id);
    const created = await tool.execute({
      action: "create", objective: input.objective, definitionOfDone: input.definitionOfDone, obligations: input.obligations,
    }, exec);
    assert.equal(created.ok, true);
  }
  return { table, proofs, repo, root, tool, exec };
}

test("fresh root recover returns RUN_NOT_FOUND without creating quarantine, then create succeeds", async () => {
  const s = await scenario(false);
  const recovered = await s.tool.execute({ action: "recover" }, s.exec);
  assert.equal(recovered.ok, false);
  assert.equal(recovered.error?.code, "RUN_NOT_FOUND");
  assert.equal(s.repo.read(s.root.id), null);
  const input = createInput(s.root.id);
  const created = await s.tool.execute({
    action: "create", objective: input.objective, definitionOfDone: input.definitionOfDone, obligations: input.obligations,
  }, s.exec);
  assert.equal(created.ok, true);
  assert.equal(created.state.run.revision, 1);
  assert.equal(s.repo.hasLiveCore(s.root.id), true);
  assert.equal(s.proofs.events.get(s.root.id)?.length, 1);
});

test("existing quarantine without a record is retained and still blocks create", async () => {
  const s = await scenario(false);
  await assert.rejects(s.repo.transact(s.root.id, () => { throw new Error("synthetic crash before first checkpoint"); }));
  const recovered = await s.tool.execute({ action: "recover" }, s.exec);
  assert.equal(recovered.ok, false);
  assert.equal(recovered.error?.code, "RUN_NOT_FOUND");
  const input = createInput(s.root.id);
  const created = await s.tool.execute({
    action: "create", objective: input.objective, definitionOfDone: input.definitionOfDone, obligations: input.obligations,
  }, s.exec);
  assert.equal(created.ok, false);
  assert.equal(created.error?.code, "STORAGE_QUARANTINED");
  assert.equal(s.repo.read(s.root.id), null);
});

test("real malformed WorkItem args return structured violations and can be corrected immediately", async () => {
  const s = await scenario();
  await assert.rejects(s.tool.execute({
    action: "plan", expectedRevision: 1, expectedGeneration: 1,
    items: [{
      id: "bad", title: "Missing dependencies", dependsOn: [], writeScopes: [], acceptance: ["done"], obligationIds: [], gateProfile: "code",
    }],
  }, s.exec), (error: unknown) => {
    assert.ok(error instanceof ToolArgsError);
    assert.ok(error.violations.length > 0);
    assert.match(error.violations.join("\n"), /dependsOn|dependencies|required/);
    return true;
  });
  const corrected = await s.tool.execute({
    action: "plan", expectedRevision: 1, expectedGeneration: 1, items: [validItem],
  }, s.exec);
  assert.equal(corrected.ok, true);
  assert.equal(corrected.state.run.revision, 2);
  assert.equal(s.repo.hasLiveCore(s.root.id), true);
});

test("CoreResult validation rejection does not quarantine and accepts an immediate corrected write", async () => {
  const s = await scenario();
  const rejected = await s.tool.execute({
    action: "plan", expectedRevision: 1, expectedGeneration: 1,
    items: [{ ...validItem, id: "bad", dependencies: ["missing"] }],
  }, s.exec);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.error?.code);
  const corrected = await s.tool.execute({
    action: "plan", expectedRevision: 1, expectedGeneration: 1, items: [validItem],
  }, s.exec);
  assert.equal(corrected.ok, true);
  assert.equal(corrected.state.run.revision, 2);
  assert.equal(s.repo.hasLiveCore(s.root.id), true);
});

test("operation quarantine recovers from last proof, then plans with correct generation and audit", async () => {
  const s = await scenario();
  await assert.rejects(s.repo.transact(s.root.id, () => { throw new Error("synthetic live operation crash"); }),
    (error: unknown) => (error as { code?: string }).code === "OPERATION_FAILED");
  assert.equal(s.repo.hasLiveCore(s.root.id), false);
  const blocked = await s.tool.execute({ action: "plan", expectedRevision: 1, expectedGeneration: 1, items: [validItem] }, s.exec);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, "STORAGE_QUARANTINED");

  const recovered = await s.tool.execute({ action: "recover" }, s.exec);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.run.generation, 2);
  assert.equal(recovered.state.run.revision, 2);
  assert.equal(recovered.state.audit.filter(event => event.type === "run.recovered").length, 1);
  assert.equal(recovered.state.audit.at(-1)?.generation, 2);
  assert.equal(s.repo.hasLiveCore(s.root.id), true);

  const planned = await s.tool.execute({
    action: "plan", expectedRevision: 2, expectedGeneration: 2, items: [validItem],
  }, s.exec);
  assert.equal(planned.ok, true);
  assert.equal(planned.state.run.generation, 2);
  assert.equal(planned.state.run.revision, 3);
  assert.equal(planned.state.audit.filter(event => event.type === "run.recovered").length, 1);
  assert.equal(planned.state.audit.at(-1)?.type, "work.planned");
  assert.equal(s.proofs.events.get(s.root.id)?.at(-1)?.generation, 2);
  assert.equal(s.proofs.events.get(s.root.id)?.at(-1)?.revision, 3);
});

test("recover is root-only and a descendant cannot advance recovery", async () => {
  const s = await scenario();
  const result = await s.tool.execute({ action: "recover" }, { agent: { id: "descendant-native" }, signal: new AbortController().signal });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "ACTOR_MISMATCH");
  assert.equal(s.repo.read(s.root.id)?.run.generation, 1);
  assert.equal(s.proofs.events.get(s.root.id)?.length, 1);
});

test("recover without native proof is refused and quarantine remains enforced", async () => {
  const s = await scenario();
  await assert.rejects(s.repo.transact(s.root.id, () => { throw new Error("synthetic crash"); }));
  s.proofs.events.delete(s.root.id);
  const recovered = await s.tool.execute({ action: "recover" }, s.exec);
  assert.equal(recovered.ok, false);
  assert.equal(recovered.error?.code, "SNAPSHOT_PROOF_REQUIRED");
  assert.equal(s.repo.hasLiveCore(s.root.id), false);
  const planned = await s.tool.execute({ action: "plan", expectedRevision: 1, expectedGeneration: 1, items: [validItem] }, s.exec);
  assert.equal(planned.ok, false);
  assert.equal(planned.error?.code, "STORAGE_QUARANTINED");
  assert.equal(s.repo.read(s.root.id)?.run.generation, 1);
});
