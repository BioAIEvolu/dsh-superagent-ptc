import test from "node:test";
import assert from "node:assert/strict";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { registerSuperTools } from "../../src/host/tools.ts";
import { registerSuperPrompt } from "../../src/host/prompt.ts";
import { RunRepository } from "../../src/host/store.ts";
import { createInput, drivers, MemoryProofStore, MemoryTable } from "./helpers.ts";

type TestAgent = Agent & { currentPreset: string };
type When = (input: { agent: Agent; signal: AbortSignal }) => Promise<boolean>;

async function makeFixture() {
  const table = new MemoryTable();
  const proofs = new MemoryProofStore();
  const repo = new RunRepository(table, drivers(), undefined, proofs);
  const agents = new Map<string, TestAgent>();
  const makeAgent = (id: string, preset: string): TestAgent => {
    const agent = {
      id, status: "idle", currentPreset: preset,
      session: { currentPreset: preset, header: { agentPreset: "super-agent" } },
    } as unknown as TestAgent;
    agents.set(id, agent);
    return agent;
  };
  const root = makeAgent("root-access", "super-agent");
  const reviewer = makeAgent("reviewer-native", "standard");
  await repo.create(root.id, createInput(root.id));
  await repo.transact(root.id, core => core.planWorkItems({
    expectedRevision: 1, expectedGeneration: 1,
    items: [{ id: "item", title: "Work", dependencies: [], writeScopes: [], acceptance: ["verified"], obligationIds: [], gateProfile: "code" }],
  }));
  const prepared = await repo.transact(root.id, core => core.prepareMandate({
    expectedRevision: 2, expectedGeneration: 1, workItemId: "item", workerId: "worker-native", reviewerId: reviewer.id, knownFailures: [],
  }));
  assert.ok(prepared.ok);

  const ctx = {
    tools: { register: () => () => {} },
    agents: { get: (id: string) => agents.get(id) },
    subagents: { rootOf: (agent: TestAgent) => agent.id === root.id ? root : root },
    sessionQuery: {
      observeSession: async (id: string) => ({
        projections: { values: { agentPreset: agents.get(id)?.currentPreset ?? null } },
        [Symbol.dispose]: () => {},
      }),
    },
    agentPresets: { presetForSession: (session: { currentPreset: string }) => session.currentPreset },
  };
  return { ctx, repo, proofs, root, reviewer, makeAgent };
}

test("real async tool when excludes ordinary presets and admits only bound standard Reviewer", async () => {
  const fixture = await makeFixture();
  const registrations: { name: string; when: When }[] = [];
  fixture.ctx.tools.register = ((definition: { name: string }, options: { when: When }) => {
    registrations.push({ name: definition.name, when: options.when });
    return () => {};
  }) as never;
  registerSuperTools(fixture.ctx as never, fixture.repo);
  assert.equal(registrations.length, 7);
  for (const registration of registrations) assert.equal(typeof registration.when, "function");

  for (const preset of ["standard", "ptc", "minimal", "creative"]) {
    const ordinary = fixture.makeAgent(`ordinary-${preset}`, preset);
    for (const registration of registrations) {
      assert.equal(await registration.when({ agent: ordinary, signal: new AbortController().signal }), false, `${preset} exposed ${registration.name}`);
    }
  }
  for (const registration of registrations) {
    assert.equal(await registration.when({ agent: fixture.root, signal: new AbortController().signal }), true);
    assert.equal(await registration.when({ agent: fixture.reviewer, signal: new AbortController().signal }), true);
  }
  fixture.proofs.events.delete(fixture.root.id);
  for (const registration of registrations) {
    assert.equal(await registration.when({ agent: fixture.reviewer, signal: new AbortController().signal }), false, "bound Reviewer without valid proof must fail closed");
  }
});

test("prompt section is empty for ordinary sessions and visible to super-agent/bound standard Reviewer", async () => {
  const fixture = await makeFixture();
  let section: { text: (input: { scope: Agent }) => string } | undefined;
  const ctx = {
    ...fixture.ctx,
    systemPrompt: {
      getSectionOrder: () => 600,
      section: (value: { text: (input: { scope: Agent }) => string }) => { section = value; return () => {}; },
    },
  };
  registerSuperPrompt(ctx as never, fixture.repo);
  assert.ok(section);
  for (const preset of ["standard", "ptc", "minimal", "creative"]) {
    assert.equal(section.text({ scope: fixture.makeAgent(`prompt-${preset}`, preset) }), "");
  }
  assert.equal(section.text({ scope: fixture.makeAgent("ordinary-standard", "standard") }), "");
  assert.match(section.text({ scope: fixture.root }), /Super Agent Run/);
  assert.match(section.text({ scope: fixture.reviewer }), /Super Agent Run/);
});
