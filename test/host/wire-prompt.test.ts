import test from "node:test";
import assert from "node:assert/strict";
import { endpointName, routePath, rpcTarget } from "../../src/shared/wire.ts";
import { renderRunPrompt } from "../../src/host/prompt.ts";
import { SuperAgentCore } from "../../src/core/index.ts";
import { createInput, drivers } from "./helpers.ts";

test("projection RPC target is exact and contains no duplicate namespace", () => {
  assert.equal(endpointName("projection"), "dsh-super-agent-mode/projection");
  assert.equal(routePath("projection"), "/api/dsh-super-agent-mode/projection");
  assert.deepEqual(rpcTarget("projection"), { channel: "/api", endpoint: "dsh-super-agent-mode/projection" });
});

test("dynamic prompt has a self-consistent empty state and no cross-session data", () => {
  const text = renderRunPrompt(null, []);
  assert.match(text, /no Run exists/);
  assert.match(text, /current native root/);
  assert.match(text, /agent_preset=standard/);
  assert.doesNotMatch(text, /other-session/);
  const core = new SuperAgentCore(drivers());
  const created = core.createRun({ ...createInput("root-current"), objective: "only this root objective" });
  assert.ok(created.ok);
  const populated = renderRunPrompt(created.state, []);
  assert.match(populated, /only this root objective/);
  assert.match(populated, /obligation-host/);
  assert.doesNotMatch(populated, /other-session/);
});
