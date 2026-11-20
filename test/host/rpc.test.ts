import test from "node:test";
import assert from "node:assert/strict";
import { dispatchProjectionRpc } from "../../src/host/rpc.ts";
import { RunRepository } from "../../src/host/store.ts";
import { createInput, drivers, MemoryTable, MemoryProofStore } from "./helpers.ts";

function fakeHost(repo: RunRepository, rootId = "root-a") {
  const root = { id: rootId, status: "idle", model: { current: () => undefined } };
  let disposed = 0;
  const ctx = {
    agents: { get: (id: string) => id === rootId ? root : id === "child-native" ? { id: "child-native", status: "inactive" } : undefined },
    subagents: {
      rootOf: (agent: { id: string }) => agent.id === "child-native" ? root : agent,
      listDescendants: async () => [],
    },
    agentTeams: { isEnabled: () => false, listTasks: () => { throw new Error("disabled board must not be read"); } },
    goals: { get: () => undefined },
    sessionQuery: {
      observeSession: async () => ({
        projections: { values: { subagentCatalog: [] } },
        [Symbol.dispose]: () => { disposed += 1; },
      }),
    },
  };
  return { ctx: ctx as never, root, disposed: () => disposed, repo };
}

test("RPC rejects malformed payload, aliases and descendant SessionIds", async () => {
  const repo = new RunRepository(new MemoryTable(), drivers(), undefined, new MemoryProofStore());
  const host = fakeHost(repo);
  assert.equal((await dispatchProjectionRpc(host.ctx, repo, null)).ok, false);
  assert.equal((await dispatchProjectionRpc(host.ctx, repo, {})).ok, false);
  const missing = await dispatchProjectionRpc(host.ctx, repo, { sessionId: "agent-alias" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "SESSION_UNAVAILABLE");
  const descendant = await dispatchProjectionRpc(host.ctx, repo, { sessionId: "child-native" });
  assert.equal(descendant.ok, false);
  if (!descendant.ok) assert.equal(descendant.error.code, "SESSION_NOT_ROOT");
});

test("RPC composes disabled Team fallback and never treats inactive as success", async () => {
  const table = new MemoryTable();
  const repo = new RunRepository(table, drivers(), undefined, new MemoryProofStore());
  await repo.create("root-a", createInput("root-a"));
  const host = fakeHost(repo);
  const result = await dispatchProjectionRpc(host.ctx, repo, { sessionId: "root-a" });
  assert.ok(result.ok);
  assert.equal(result.value.teamEnabled, false);
  assert.equal(result.value.agentTeam.enabled, false);
  assert.deepEqual(result.value.agentTeam.tasks, []);
  assert.deepEqual(result.value.routeFailures, []);
  assert.equal(result.value.subagentCatalog[0]?.status, "inactive");
  assert.equal(result.value.run?.sessionId, "root-a");
  assert.equal(result.value.proof?.status, "verified");
  assert.match(result.value.proof?.snapshotSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(host.disposed(), 1);
});

test("RPC detects a stored session/run mismatch before returning native state", async () => {
  const table = new MemoryTable();
  const repo = new RunRepository(table, drivers(), undefined, new MemoryProofStore());
  await repo.create("root-a", createInput("root-a"));
  const stored = table.records.get("root-a")!;
  stored.state.run.sessionId = "root-b";
  table.records.set("root-a", stored);
  const host = fakeHost(repo);
  const result = await dispatchProjectionRpc(host.ctx, repo, { sessionId: "root-a" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "SESSION_RUN_MISMATCH");
});
