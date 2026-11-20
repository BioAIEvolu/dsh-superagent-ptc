import { z } from "zod";
import type { JsonValue } from "../core/types.ts";

const id = z.string().trim().min(1).max(4000);
const text = z.string().max(4000);
const timestamp = z.string().datetime({ offset: true });
const revision = z.number().int().nonnegative();
const stringList = z.array(z.string().max(4000)).max(256);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string().max(8000),
  z.array(jsonValueSchema).max(256),
  z.record(z.string().max(200), jsonValueSchema),
]));

const receiptSchema = z.record(z.string().max(200), jsonValueSchema);
const evidenceKindSchema = z.enum(["build", "unit", "static", "simulated", "host_contract", "runtime_gui", "animation", "hover", "artifact", "source_hash", "build_hash", "loaded_hash", "host_receipt", "numeric_reconcile", "coverage", "user_feedback"]);
const gatePolicySchema = z.object({
  maxAttempts: z.number().int().positive(),
  maxSameFingerprint: z.number().int().positive(),
}).strict();
const obligationSchema = z.object({
  id,
  kind: z.enum(["requirement", "prohibition", "coverage"]),
  text,
  requiredEvidence: z.array(evidenceKindSchema).optional(),
  animation: z.string().optional(),
  coverage: z.enum(["full", "partial", "substitute", "unknown"]).optional(),
  sourceId: z.string().optional(),
  status: z.enum(["open", "met", "violated", "waived", "superseded"]),
  evidenceIds: z.array(id),
  userWaiver: z.string().optional(),
}).strict();
const anchorSchema = z.object({
  id, version: z.number().int().positive(), supersedes: id.optional(), supersededBy: id.optional(),
  latestInstruction: text, definitionOfDone: text, constraints: stringList,
  obligationSnapshot: z.array(id), createdAt: timestamp,
}).strict();
const modelRouteSchema = z.object({
  provider: id, model: id, reasoningEffort: z.string().min(1).max(1000).optional(),
}).strict();
const modelPolicySchema = z.object({
  mode: z.enum(["locked", "balanced", "economy", "performance"]),
  allowedRoutes: z.array(modelRouteSchema),
  workerRoute: modelRouteSchema.nullable().optional(), reviewerRoute: modelRouteSchema.nullable().optional(),
  allowFailureSwitch: z.boolean(),
  maxSameRouteRetries: z.number().int().nonnegative(), maxRouteSwitches: z.number().int().nonnegative(),
  cooldownMs: z.number().int().nonnegative().optional(), revision: z.number().int().positive(),
}).strict();
const routeFailureSchema = z.object({
  id, mandateId: id, route: modelRouteSchema.nullable(),
  failureKind: z.enum(["transient", "timeout", "rate_limit", "quota", "account_quota", "provider_unavailable", "route_incompatible", "authentication", "permission", "tool_input", "business_acceptance", "snapshot_proof", "write_scope", "identity", "unknown"]),
  failureCode: text, action: z.enum(["rejected", "retry_recorded", "switch_required"]),
  sameRouteRetries: revision, routeSwitches: revision, createdAt: timestamp,
}).strict();
const routeSwitchSchema = z.object({
  id, mandateId: id, from: modelRouteSchema.nullable(), to: modelRouteSchema.nullable(),
  failureCode: text, status: z.enum(["requested", "rejected", "exhausted"]), reason: text,
  attempt: z.number().int().positive(), generation: z.number().int().positive(), actor: id, createdAt: timestamp,
}).strict();
const runSchema = z.object({
  id, sessionId: id, objective: text, definitionOfDone: text,
  status: z.enum(["active", "paused", "blocked", "needs_user", "completed"]),
  currentAnchorId: id, revision: z.number().int().positive(), generation: z.number().int().positive(),
  gatePolicy: gatePolicySchema, modelPolicy: modelPolicySchema.nullable().default(null), createdAt: timestamp, updatedAt: timestamp,
}).strict();
const workItemSchema = z.object({
  id, nativeTaskId: id.optional(), title: text, writeScopes: stringList, dependencies: z.array(id),
  acceptance: stringList, obligationIds: z.array(id),
  gateProfile: z.enum(["code", "visual", "deployment", "numeric_reconcile", "coverage"]),
  hostContractRequired: z.boolean(), mandatory: z.boolean(),
  status: z.enum(["held", "ready", "mandated", "running", "reported_done", "verifying", "rework", "accepted", "blocked", "superseded"]),
  attempt: revision, failureFingerprints: z.record(z.string(), revision), currentMandateId: id.optional(),
}).strict();
const mandateSchema = z.object({
  id, workItemId: id, anchorVersion: z.number().int().positive(), generation: z.number().int().positive(),
  attempt: z.number().int().positive(), workerId: id, reviewerId: id,
  reviewerAgentId: id.optional(), writeScopes: stringList, acceptance: stringList, knownFailures: stringList,
  status: z.enum(["prepared", "running", "reported_done", "verifying", "accepted", "superseded", "unknown"]),
  nativeTaskId: id.optional(), workerAgentId: id.optional(), needsStop: z.boolean(), mandateText: z.string().max(16000),
  workerRoute: modelRouteSchema.nullable().optional(), reviewerRoute: modelRouteSchema.nullable().optional(),
  routeReason: text.optional(), policyRevision: revision.optional(), routeSwitches: z.array(routeSwitchSchema).optional(),
}).strict();
const evidenceSchema = z.object({
  id, workItemId: id, mandateId: id, attempt: z.number().int().positive(),
  anchorVersion: z.number().int().positive(), generation: z.number().int().positive(),
  kind: evidenceKindSchema,
  result: z.enum(["pass", "fail", "unknown"]), sourceActor: id, sourceRole: z.enum(["worker", "reviewer", "lead", "host", "user"]),
  receipt: receiptSchema, summary: z.string().max(1000), createdAt: timestamp,
}).strict();
const decisionSchema = z.object({
  id, workItemId: id, mandateId: id, attempt: z.number().int().positive(),
  anchorVersion: z.number().int().positive(), generation: z.number().int().positive(), reviewerId: id,
  result: z.enum(["pass", "fail", "unknown"]), evidenceIds: z.array(id), reasons: stringList,
  createdAt: timestamp, invalidated: z.boolean(),
}).strict();
const stateChangesSchema = z.object({
  run: runSchema.optional(),
  anchors: z.record(z.string(), anchorSchema.nullable()).optional(),
  obligations: z.record(z.string(), obligationSchema.nullable()).optional(),
  workItems: z.record(z.string(), workItemSchema.nullable()).optional(),
  mandates: z.record(z.string(), mandateSchema.nullable()).optional(),
  routeFailures: z.record(z.string(), routeFailureSchema.nullable()).optional(),
  evidence: z.record(z.string(), evidenceSchema.nullable()).optional(),
  decisions: z.record(z.string(), decisionSchema.nullable()).optional(),
}).strict();
const auditSchema = z.object({
  id, runId: id, revision: z.number().int().positive(), generation: z.number().int().positive(),
  type: z.string().min(1).max(200), payload: receiptSchema, changes: stateChangesSchema, actor: id, timestamp,
}).strict();

export const runStateSchema = z.object({
  schemaVersion: z.literal(2),
  run: runSchema,
  anchors: z.record(z.string(), anchorSchema),
  obligations: z.record(z.string(), obligationSchema),
  workItems: z.record(z.string(), workItemSchema),
  mandates: z.record(z.string(), mandateSchema),
  routeFailures: z.record(z.string(), routeFailureSchema).default({}),
  evidence: z.record(z.string(), evidenceSchema),
  decisions: z.record(z.string(), decisionSchema),
  audit: z.array(auditSchema),
}).strict().superRefine((state, ctx) => {
  const anchor = state.anchors[state.run.currentAnchorId];
  if (!anchor) ctx.addIssue({ code: "custom", message: "current anchor is missing", path: ["run", "currentAnchorId"] });
  for (const [key, value] of Object.entries(state.audit)) {
    if (value.runId !== state.run.id || value.revision !== Number(key) + 1 || value.generation > state.run.generation) {
      ctx.addIssue({ code: "custom", message: "audit revision/run is inconsistent", path: ["audit", Number(key)] });
    }
  }
});

export const snapshotProofSchema = z.object({
  runId: id,
  snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().positive(),
  generation: z.number().int().positive(),
  nativeEventSeq: z.number().int().positive(),
}).strict();

// Host envelope remains v1; the core RunState schema independently requires v2.
export const storedRunRecordSchema = z.object({
  schemaVersion: z.literal(1),
  state: runStateSchema,
  proof: snapshotProofSchema,
  recoveredAt: timestamp.optional(),
}).strict();

export type StoredRunRecord = z.infer<typeof storedRunRecordSchema>;
