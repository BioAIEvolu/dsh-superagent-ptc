import test from "node:test";
import assert from "node:assert/strict";
import { SUPER_TOOL_PARAMETERS, TOOL_OUTPUT } from "../../src/host/tool-schemas.ts";

function keysDeep(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]);
}

test("six real super tools expose no self-asserted actor or role parameters", () => {
  assert.deepEqual(Object.keys(SUPER_TOOL_PARAMETERS).sort(), [
    "super_anchor", "super_evidence", "super_mandate", "super_review", "super_route", "super_run", "super_snapshot",
  ]);
  for (const [name, schema] of Object.entries(SUPER_TOOL_PARAMETERS)) {
    const keys = keysDeep(schema);
    for (const forbidden of ["sourceActor", "sourceRole", "workerId", "reviewerId", "hostObserved"]) {
      assert.ok(!keys.includes(forbidden), `${name} exposes ${forbidden}`);
    }
  }
  const receipt = SUPER_TOOL_PARAMETERS.super_evidence.receipt;
  assert.equal(receipt.additionalProperties, false);
  assert.equal(TOOL_OUTPUT.schema.type, "object");
  assert.equal(TOOL_OUTPUT.schema.additionalProperties, false);
  assert.equal(TOOL_OUTPUT.schema.properties.ok.required, true);
  assert.equal(typeof TOOL_OUTPUT.render, "function");
  assert.equal(TOOL_OUTPUT.render({}, { ok: true, state: null })[0]?.type, "text");
});

test("read and write actions are explicit in each model schema", () => {
  assert.ok(SUPER_TOOL_PARAMETERS.super_run.action.enum.includes("show"));
  assert.ok(SUPER_TOOL_PARAMETERS.super_run.action.enum.includes("complete"));
  assert.ok(SUPER_TOOL_PARAMETERS.super_run.action.enum.includes("recover"));
  const item = SUPER_TOOL_PARAMETERS.super_run.items.items;
  assert.equal(item.additionalProperties, false);
  for (const field of ["id", "title", "dependencies", "writeScopes", "acceptance", "obligationIds", "gateProfile"]) {
    const property = item.properties[field as keyof typeof item.properties] as { required?: boolean };
    assert.equal(property.required, true, field);
  }
  assert.ok(!("dependsOn" in item.properties));
  const obligation = SUPER_TOOL_PARAMETERS.super_run.obligations.items;
  assert.equal(obligation.additionalProperties, false);
  for (const field of ["id", "kind", "text"]) {
    const property = obligation.properties[field as keyof typeof obligation.properties] as { required?: boolean };
    assert.equal(property.required, true, field);
  }
  assert.deepEqual(obligation.properties.kind.enum, ["requirement", "prohibition", "coverage"]);
  assert.deepEqual(obligation.properties.verification.enum, ["mandate_delivery"]);
  assert.ok(!("status" in obligation.properties));
  assert.ok(SUPER_TOOL_PARAMETERS.super_evidence.action.enum.includes("observe"));
  assert.ok(SUPER_TOOL_PARAMETERS.super_evidence.action.enum.includes("record"));
  assert.ok(SUPER_TOOL_PARAMETERS.super_evidence.action.enum.includes("verify"));
  assert.deepEqual(SUPER_TOOL_PARAMETERS.super_evidence.verification.enum, ["mandate_delivery"]);
  assert.equal(SUPER_TOOL_PARAMETERS.super_run.workItemRevisions.items.additionalProperties, false);
  assert.equal(SUPER_TOOL_PARAMETERS.super_run.workItemRevisions.items.properties.id.required, true);
  assert.equal(SUPER_TOOL_PARAMETERS.super_run.workItemRevisions.items.properties.gateProfile.required, true);
  assert.ok(SUPER_TOOL_PARAMETERS.super_review.action.enum.includes("release"));
});
