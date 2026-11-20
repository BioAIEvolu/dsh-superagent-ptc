import assert from "node:assert/strict";
import { SuperAgentCore } from "../../src/core/index.ts";
import type {
  CoreDrivers,
  CoreResult,
  Evidence,
  EvidenceKind,
  EvidenceResult,
  GateProfile,
  HardCheck,
  Mandate,
  ObligationInput,
  RunState,
  SnapshotProof,
  SourceRole,
  WorkItem,
  WorkItemInput
} from "../../src/core/index.ts";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(entry => canonicalJson(entry)).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry));
  return "{" + entries.join(",") + "}";
}

export function snapshotDigest(snapshot: unknown): string {
  const input = canonicalJson(snapshot);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(8);
}

export function proofFor(snapshot: RunState, nativeEventSeq = 1): SnapshotProof {
  return {
    runId: snapshot.run.id,
    snapshotSha256: snapshotDigest(snapshot),
    revision: snapshot.run.revision,
    generation: snapshot.run.generation,
    nativeEventSeq
  };
}

let coreInstance = 0;

class MutantCore extends SuperAgentCore {
  private readonly mutations: Set<HardCheck>;

  constructor(drivers: CoreDrivers, mutations: HardCheck[]) {
    super(drivers);
    this.mutations = new Set(mutations);
  }

  protected off(check: HardCheck): boolean {
    return this.mutations.has(check);
  }
}

export function makeEmptyCore(disabledChecks: HardCheck[] = []): SuperAgentCore {
  let sequence = 0;
  let tick = 0;
  const instance = ++coreInstance;
  const drivers = {
    createId: (kind: string) => kind + "-" + instance + "-" + ++sequence,
    now: () => "2026-11-18T00:00:" + String(++tick).padStart(2, "0") + ".000Z",
    digestSnapshot: snapshotDigest
  };
  return disabledChecks.length > 0 ? new MutantCore(drivers, disabledChecks) : new SuperAgentCore(drivers);
}

export function makeCore(obligations: ObligationInput[] = [], disabledChecks: HardCheck[] = [], maxSameFingerprint = 2): SuperAgentCore {
  const core = makeEmptyCore(disabledChecks);
  const created = core.createRun({
    sessionId: "session-test",
    objective: "deliver the contracted outcome",
    definitionOfDone: "all obligations and mandatory gates pass",
    obligations,
    gatePolicy: { maxAttempts: 4, maxSameFingerprint }
  });
  must(created);
  return core;
}

export function must<T>(result: CoreResult<T>): T {
  if (!result.ok) throw new Error("expected success, got " + result.error.code + ": " + result.error.message);
  return result.value;
}

export function expectError<T>(result: CoreResult<T>, code: string): void {
  assert.equal(result.ok, false, "expected " + code + " rejection");
  if (!result.ok) assert.equal(result.error.code, code);
}

export function mutationEscapes<T>(check: HardCheck, code: string, operation: () => CoreResult<T>): void {
  const mutated = operation();
  assert.throws(() => expectError(mutated, code), "disabling " + check + " must defeat the original assertion");
  must(mutated);
}

export function state(core: SuperAgentCore): RunState {
  const snapshot = core.snapshot();
  assert.ok(snapshot);
  return snapshot;
}

export function guard(core: SuperAgentCore): { expectedRevision: number; expectedGeneration: number } {
  const current = state(core).run;
  return { expectedRevision: current.revision, expectedGeneration: current.generation };
}

export function itemInput(id: string, overrides: Partial<WorkItemInput> = {}): WorkItemInput {
  return {
    id,
    title: "Work item " + id,
    dependencies: [],
    writeScopes: ["src/" + id],
    acceptance: ["contracted acceptance for " + id],
    obligationIds: [],
    gateProfile: "code",
    ...overrides
  };
}

export function plan(core: SuperAgentCore, items: WorkItemInput | WorkItemInput[]): WorkItem[] {
  return must(core.planWorkItems({ items: Array.isArray(items) ? items : [items], ...guard(core) }));
}

export function prepare(core: SuperAgentCore, workItemId: string, workerId = "worker", reviewerId = "reviewer"): Mandate {
  return must(core.prepareMandate({ workItemId, workerId, reviewerId, knownFailures: ["none known"], ...guard(core) }));
}

export function running(core: SuperAgentCore, workItemId: string, workerId = "worker", reviewerId = "reviewer"): Mandate {
  const mandate = prepare(core, workItemId, workerId, reviewerId);
  return must(core.bindExecution({ mandateId: mandate.id, nativeTaskId: "native-" + workItemId, workerAgentId: "agent-" + workerId, ...guard(core) }));
}

export function report(core: SuperAgentCore, mandate: Mandate): Mandate {
  return must(core.reportWorkerDone({ mandateId: mandate.id, workerId: mandate.workerId, summary: "worker reports implementation ready for review", ...guard(core) }));
}

export interface EvidenceOptions {
  kind: EvidenceKind;
  result?: EvidenceResult;
  receipt?: Record<string, import("../../src/core/index.ts").JsonValue>;
  sourceActor?: string;
  sourceRole?: SourceRole;
  mandateId?: string;
  attempt?: number;
}

export function evidence(core: SuperAgentCore, workItemId: string, options: EvidenceOptions): Evidence {
  const current = state(core);
  const item = current.workItems[workItemId];
  const mandateId = options.mandateId ?? item.currentMandateId;
  assert.ok(mandateId);
  return must(core.recordEvidence({
    workItemId,
    mandateId,
    attempt: options.attempt ?? item.attempt,
    kind: options.kind,
    result: options.result ?? "pass",
    sourceActor: options.sourceActor ?? "reviewer",
    sourceRole: options.sourceRole ?? "reviewer",
    receipt: (options.sourceRole ?? "reviewer") === "host"
      ? { hostObserved: true, ...(options.receipt ?? { verified: true }) }
      : options.receipt ?? { verified: true },
    summary: options.kind + " receipt",
    ...guard(core)
  }));
}

export function codeEvidence(core: SuperAgentCore, workItemId: string, sourceRole: SourceRole = "reviewer"): Evidence[] {
  const actor = sourceRole === "worker" ? "worker" : sourceRole === "host" ? "host" : "reviewer";
  return [
    evidence(core, workItemId, { kind: "build", sourceRole, sourceActor: actor, receipt: { exitCode: 0 } }),
    evidence(core, workItemId, { kind: "unit", sourceRole, sourceActor: actor, receipt: { passed: 65, failed: 0 } })
  ];
}

export function visualEvidence(core: SuperAgentCore, workItemId: string): Evidence[] {
  return [
    ...codeEvidence(core, workItemId),
    evidence(core, workItemId, { kind: "runtime_gui", receipt: { visible: true } })
  ];
}

export function allCurrentEvidenceIds(core: SuperAgentCore, workItemId: string): string[] {
  const current = state(core);
  const item = current.workItems[workItemId];
  const mandate = current.mandates[item.currentMandateId ?? ""];
  return Object.values(current.evidence).filter(entry =>
    entry.workItemId === workItemId && entry.attempt === item.attempt && entry.anchorVersion === mandate.anchorVersion
  ).map(entry => entry.id);
}

export function submitPass(core: SuperAgentCore, workItemId: string, reviewerId = "reviewer"): void {
  const current = state(core);
  const item = current.workItems[workItemId];
  must(core.submitReview({
    workItemId,
    mandateId: item.currentMandateId ?? "",
    attempt: item.attempt,
    reviewerId,
    result: "pass",
    evidenceIds: allCurrentEvidenceIds(core, workItemId),
    ...guard(core)
  }));
}

export function codeItemReadyForReview(core: SuperAgentCore, id = "item", profile: GateProfile = "code"): Mandate {
  plan(core, itemInput(id, { gateProfile: profile }));
  const mandate = running(core, id);
  report(core, mandate);
  return mandate;
}
