// Requires the package's pinned zod dependency. Not run in the dependency-less host test command.
import test from "node:test";
import assert from "node:assert/strict";
import { SuperAgentCore } from "../../src/core/index.ts";
import { storedRunRecordSchema } from "../../src/host/schema.ts";
import { createInput, drivers } from "./helpers.ts";
import { snapshotDigest } from "../../src/host/digest.ts";

function validRecord() {
  const core = new SuperAgentCore(drivers());
  const result = core.createRun(createInput("root-schema"));
  assert.ok(result.ok);
  const proof = {
    runId: result.state.run.id,
    snapshotSha256: snapshotDigest(result.state),
    revision: result.state.run.revision,
    generation: result.state.run.generation,
    nativeEventSeq: 1,
  };
  return { schemaVersion: 1 as const, state: result.state, proof };
}

test("storage schema accepts a real core snapshot including audit", () => {
  const record = validRecord();
  const parsed = storedRunRecordSchema.parse(record);
  assert.equal(parsed.state.schemaVersion, 2);
  assert.equal(parsed.state.run.sessionId, "root-schema");
  assert.equal(parsed.state.audit.length, 1);
  assert.equal(parsed.state.audit[0]?.changes.run?.id, parsed.state.run.id);
  assert.equal(parsed.state.audit[0]?.changes.anchors?.[parsed.state.run.currentAnchorId]?.version, 1);
});

test("storage schema rejects unknown fields, missing anchors and noncontiguous audit", () => {
  assert.throws(() => storedRunRecordSchema.parse({ ...validRecord(), extra: true }));
  const missingAnchor = validRecord();
  missingAnchor.state.run.currentAnchorId = "missing";
  assert.throws(() => storedRunRecordSchema.parse(missingAnchor));
  const badAudit = validRecord();
  badAudit.state.audit[0]!.revision = 99;
  assert.throws(() => storedRunRecordSchema.parse(badAudit));
  const legacy = validRecord();
  legacy.state.schemaVersion = 1 as never;
  assert.throws(() => storedRunRecordSchema.parse(legacy), /schemaVersion/);
  const missingChanges = validRecord();
  delete (missingChanges.state.audit[0] as Partial<typeof missingChanges.state.audit[0]>).changes;
  assert.throws(() => storedRunRecordSchema.parse(missingChanges), /changes/);
});
