import test from "node:test";
import assert from "node:assert/strict";
import { registerSuperTools } from "../../src/host/tools.ts";
import { RunRepository } from "../../src/host/store.ts";
import { createInput, drivers, MemoryProofStore, MemoryTable } from "./helpers.ts";

type MandateResult = { ok: boolean; error?: { code: string; message: string }; value?: { id: string; reviewerAgentId?: string } };

async function fixture() {
  const order: string[] = [];
  class OrderedProofStore extends MemoryProofStore {
    override async append(sessionId: string, state: Parameters<MemoryProofStore["append"]>[1]) {
      const result = await super.append(sessionId, state);
      order.push("proof");
      return result;
    }
  }
  class OrderedTable extends MemoryTable {
    override async put(key: string, value: Parameters<MemoryTable["put"]>[1]) {
      await super.put(key, value);
      order.push("storage");
    }
  }
  const table = new OrderedTable();
  const proofs = new OrderedProofStore();
  const repo = new RunRepository(table, drivers(), undefined, proofs);
  const root = { id: "root-wake", status: "running" };
  const reviewer = { id: "reviewer-wake", status: "idle" };
  const worker = { id: "worker-wake", status: "inactive" };
  const definitions = new Map<string, { execute(args: unknown, exec: unknown): Promise<MandateResult> }>();
  const messages: { sender: unknown; target: string; text: string; signal: AbortSignal }[] = [];
  const ctx = {
    tools: { register(definition: never) { definitions.set((definition as { name: string }).name, definition); return () => {}; } },
    subagents: {
      rootOf: () => root,
      listDescendants: async () => [reviewer, worker].map(agent => ({ kind: "child", id: agent.id })),
      sendMessage: async (sender: unknown, target: string, content: { type: string; text: string }[], options: { signal: AbortSignal }) => {
        order.push("wake");
        messages.push({ sender, target, text: content.map(block => block.text).join("\n"), signal: options.signal });
        assert.equal(repo.hasLiveCore(root.id), true, "live core must be committed before Reviewer wake");
        return "message-wake-1";
      },
    },
  };
  registerSuperTools(ctx as never, repo);
  await repo.create(root.id, createInput(root.id));
  await repo.transact(root.id, core => core.planWorkItems({
    expectedRevision: 1, expectedGeneration: 1,
    items: [{ id: "item", title: "Review fixture", dependencies: [], writeScopes: [], acceptance: ["read-only evidence"], obligationIds: [], gateProfile: "code" }],
  }));
  const prepared = await repo.transact(root.id, core => core.prepareMandate({
    expectedRevision: 2, expectedGeneration: 1, workItemId: "item", workerId: worker.id, reviewerId: reviewer.id, knownFailures: [],
  }));
  assert.ok(prepared.ok);
  order.length = 0;
  return { ctx, repo, table, proofs, root, reviewer, worker, prepared: prepared.value, order, messages, tool: definitions.get("super_mandate")! };
}

test("bindReviewer commits proof/storage/live before native read-only Reviewer wake", async () => {
  const s = await fixture();
  const exec = { agent: s.root, signal: new AbortController().signal };
  const result = await s.tool.execute({
    action: "bindReviewer", expectedRevision: 3, expectedGeneration: 1,
    mandateId: s.prepared.id, reviewerAgentId: s.reviewer.id,
  }, exec);
  assert.equal(result.ok, true);
  assert.deepEqual(s.order, ["proof", "storage", "wake"]);
  assert.equal(s.messages.length, 1);
  const message = s.messages[0]!;
  assert.equal(message.sender, s.root);
  assert.equal(message.target, s.reviewer.id);
  assert.equal(message.signal, exec.signal);
  assert.match(message.text, new RegExp(s.prepared.id));
  assert.match(message.text, new RegExp(s.reviewer.id));
  assert.match(message.text, /read-only/);
  assert.match(message.text, /Available tool declarations in your next native request: super_snapshot, super_evidence, super_review, super_run, super_anchor, super_mandate, super_route/);
  assert.ok(message.text.includes("FIRST ACTION: actually invoke super_snapshot({}) and read the returned JSON"));
  assert.ok(message.text.includes("do not reply that the tools are unavailable"));
  assert.ok(message.text.indexOf("FIRST ACTION: actually invoke super_snapshot({})") < message.text.indexOf("NEXT ACTIONS AFTER SNAPSHOT:"));
  assert.ok(message.text.includes("NEXT ACTIONS AFTER SNAPSHOT: for this exact Mandate/attempt, record or observe evidence with super_evidence, then super_review evaluate, decide, and release"));
  assert.ok(message.text.includes("Do not write/edit files, use shell/run_code"));
  assert.match(message.text, /Lead must not review on your behalf/);
  assert.equal(s.repo.read(s.root.id)?.mandates[s.prepared.id]?.reviewerAgentId, s.reviewer.id);
});

test("proof/storage failures never send Reviewer wake or claim binding success", async () => {
  for (const failure of ["proof", "storage"] as const) {
    const s = await fixture();
    if (failure === "proof") s.proofs.failNextAppend = true;
    else s.table.failNextPut = true;
    const result = await s.tool.execute({
      action: "bindReviewer", expectedRevision: 3, expectedGeneration: 1,
      mandateId: s.prepared.id, reviewerAgentId: s.reviewer.id,
    }, { agent: s.root, signal: new AbortController().signal });
    assert.equal(result.ok, false);
    assert.equal(s.messages.length, 0);
    assert.equal(s.order.includes("wake"), false);
    assert.equal(s.repo.read(s.root.id)?.mandates[s.prepared.id]?.reviewerAgentId, undefined);
    assert.equal(s.repo.hasLiveCore(s.root.id), false);
  }
});

test("sendMessage failure reports REVIEWER_WAKE_FAILED without pretending rollback or wake success", async () => {
  const s = await fixture();
  s.ctx.subagents.sendMessage = async () => { throw new Error("synthetic inbox rejection"); };
  const result = await s.tool.execute({
    action: "bindReviewer", expectedRevision: 3, expectedGeneration: 1,
    mandateId: s.prepared.id, reviewerAgentId: s.reviewer.id,
  }, { agent: s.root, signal: new AbortController().signal });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "REVIEWER_WAKE_FAILED");
  assert.equal(s.repo.read(s.root.id)?.mandates[s.prepared.id]?.reviewerAgentId, s.reviewer.id, "durable binding remains explicit after native wake failure");
});
