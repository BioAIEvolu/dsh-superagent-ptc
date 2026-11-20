import test from "node:test";
import assert from "node:assert/strict";
import { assertNativeStandardReviewer, REVIEWER_COMPOSITION_GUIDANCE } from "../../src/host/reviewer.ts";
import { HostError } from "../../src/host/errors.ts";

function hostWithPreset(preset: unknown, headerPreset = "super-agent") {
  let disposed = 0;
  const ctx = {
    sessionQuery: {
      observeSession: async () => ({
        projections: { values: { agentPreset: preset } },
        [Symbol.dispose]: () => { disposed += 1; },
      }),
    },
  };
  const agent = { id: "reviewer-native", session: { header: { agentPreset: headerPreset } } };
  return { ctx: ctx as never, agent: agent as never, disposed: () => disposed };
}

test("native standard Reviewer passes from current projection even after blank-session preset switch", async () => {
  const host = hostWithPreset("standard", "super-agent");
  await assertNativeStandardReviewer(host.ctx, host.agent);
  assert.equal(host.disposed(), 1);
  assert.match(REVIEWER_COMPOSITION_GUIDANCE, /Worker inherits super-agent/);
  assert.match(REVIEWER_COMPOSITION_GUIDANCE, /agent_preset=standard/);
});

test("super-agent PTC Reviewer gets a clear standard-preset error and no run_code retry", async () => {
  const host = hostWithPreset("super-agent", "standard");
  await assert.rejects(assertNativeStandardReviewer(host.ctx, host.agent), (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.code, "REVIEWER_PRESET_REQUIRED");
    assert.match(error.message, /agent_preset=standard/);
    assert.match(error.message, /actual current preset is super-agent/);
    return true;
  });
  assert.equal(host.disposed(), 1);
});

test("missing or unreadable current agentPreset projection fails closed", async () => {
  for (const preset of [null, undefined, ""]) {
    const host = hostWithPreset(preset);
    await assert.rejects(assertNativeStandardReviewer(host.ctx, host.agent), (error: unknown) => error instanceof HostError && error.code === "REVIEWER_PRESET_UNKNOWN");
    assert.equal(host.disposed(), 1);
  }
  const ctx = { sessionQuery: { observeSession: async () => { throw new Error("synthetic projection unavailable"); } } };
  await assert.rejects(assertNativeStandardReviewer(ctx as never, { id: "reviewer-native" } as never), (error: unknown) => error instanceof HostError && error.code === "REVIEWER_PRESET_UNAVAILABLE");
});
