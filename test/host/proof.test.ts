import test from "node:test";
import assert from "node:assert/strict";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { SuperAgentCore, type RunState, type SnapshotProof } from "../../src/core/index.ts";
import { snapshotDigest } from "../../src/host/digest.ts";
import { HostError } from "../../src/host/errors.ts";
import { NativeSnapshotProofStore } from "../../src/host/proof.ts";
import { createInput, drivers } from "./helpers.ts";

function nativeFixture() {
  const session = Session.create(SessionId("root-proof"));
  session.append("turn/start", { turn: 1 }); // proof must have positive native seq required by core.
  const root = { id: session.id, session, status: "idle" };
  let flushResult = true;
  let flushes = 0;
  let mutateReadback: ((event: unknown) => unknown) | undefined;
  const ctx = {
    agents: { get: (id: string) => id === session.id ? root : undefined },
    subagents: { rootOf: () => root },
    sessions: { flush: async () => { flushes += 1; return flushResult; } },
    sessionQuery: {
      readEvent: async ({ seq }: { seq: number }) => {
        const target = session.snapshotEvents().find(event => event.seq === seq);
        if (!target) {
          const error = new Error("missing") as Error & { code: string };
          error.code = "SESSION_QUERY_EVENT_NOT_FOUND";
          throw error;
        }
        return { session: { id: session.id }, target: mutateReadback ? mutateReadback(target) : target };
      },
    },
  };
  const core = new SuperAgentCore(drivers());
  const created = core.createRun(createInput(session.id));
  assert.ok(created.ok);
  return {
    store: new NativeSnapshotProofStore(ctx as never),
    state: created.state,
    session,
    setFlush: (value: boolean) => { flushResult = value; },
    flushes: () => flushes,
    mutate: (fn: ((event: unknown) => unknown) | undefined) => { mutateReadback = fn; },
  };
}

test("canonical SHA256 is key-order stable and matches durable optional-field semantics", () => {
  assert.equal(snapshotDigest({ b: 1, a: 2 }), snapshotDigest({ a: 2, b: 1 }));
  assert.equal(snapshotDigest({ a: 1, optional: undefined }), snapshotDigest({ a: 1 }));
  assert.throws(() => snapshotDigest({ value: Number.NaN }), /non-finite/);
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.throws(() => snapshotDigest(circular), /circular/);
});

test("native proof append returns actual seq, flushes and reads back canonical SHA256", async () => {
  const fixture = nativeFixture();
  const proof = await fixture.store.append(fixture.session.id, fixture.state);
  assert.equal(proof.nativeEventSeq, 1);
  assert.equal(proof.snapshotSha256, snapshotDigest(fixture.state));
  assert.match(proof.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.equal(fixture.flushes(), 1);
  const verified = await fixture.store.verify(fixture.session.id, fixture.state, proof);
  assert.deepEqual(verified, proof);
  assert.equal(fixture.flushes(), 1, "readback must not trigger another durability write");
});

test("missing native proof and coordinated readback tampering fail closed", async () => {
  const fixture = nativeFixture();
  const proof = await fixture.store.append(fixture.session.id, fixture.state);
  await assert.rejects(
    fixture.store.verify(fixture.session.id, fixture.state, { ...proof, nativeEventSeq: 99 }),
    (error: unknown) => error instanceof HostError && error.code === "SNAPSHOT_PROOF_REQUIRED",
  );
  fixture.mutate(event => {
    const value = event as { data: SnapshotProof };
    return { ...(event as object), data: { ...value.data, revision: value.data.revision + 1 } };
  });
  await assert.rejects(
    fixture.store.verify(fixture.session.id, fixture.state, proof),
    (error: unknown) => error instanceof HostError && error.code === "SNAPSHOT_PROOF_MISMATCH",
  );
});

test("flush=false leaves an unconfirmed proof and never returns success", async () => {
  const fixture = nativeFixture();
  fixture.setFlush(false);
  await assert.rejects(
    fixture.store.append(fixture.session.id, fixture.state),
    (error: unknown) => error instanceof HostError && error.code === "SNAPSHOT_PROOF_PERSISTENCE_UNCONFIRMED",
  );
  assert.equal(fixture.session.snapshotEvents().length, 2, "append is visible but explicitly unconfirmed");
  assert.equal(fixture.flushes(), 1);
});
