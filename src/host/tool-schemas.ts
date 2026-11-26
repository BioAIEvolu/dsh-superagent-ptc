import type { ContentBlock } from "@deepseek-ai/dsh-llm";

export const TOOL_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean", required: true },
      state: { type: "json", required: true },
      value: { type: "json" },
      error: {
        type: "object", additionalProperties: false,
        properties: {
          code: { type: "string", required: true }, message: { type: "string", required: true }, details: { type: "json" },
        },
      },
    },
  },
  render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: "text", text: JSON.stringify(value, null, 2) }],
} as const;

const obligationDelta = { type: "array", items: { type: "json" }, description: "Structured add/amend/waive/supersede deltas; no actor identity fields." } as const;
const common = {
  expectedRevision: { type: "number", description: "Current Run revision for CAS writes." },
  expectedGeneration: { type: "number", description: "Current Run generation for recovery-safe writes." },
} as const;
const workItem = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", required: true },
    title: { type: "string", required: true },
    dependencies: { type: "array", items: { type: "string" }, required: true },
    writeScopes: { type: "array", items: { type: "string" }, required: true },
    acceptance: { type: "array", items: { type: "string" }, required: true },
    obligationIds: { type: "array", items: { type: "string" }, required: true },
    gateProfile: { type: "string", enum: ["code", "visual", "deployment", "numeric_reconcile", "coverage"], required: true },
    hostContractRequired: { type: "boolean" },
    mandatory: { type: "boolean" },
  },
} as const;
const runParameters = {
  action: { type: "string", enum: ["create", "show", "plan", "pause", "resume", "replan", "recover", "complete"], required: true },
  ...common,
  objective: { type: "string" }, definitionOfDone: { type: "string" },
  gatePolicy: { type: "object", additionalProperties: false, properties: { maxAttempts: { type: "number" }, maxSameFingerprint: { type: "number" } } },
  obligations: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", required: true },
        kind: { type: "string", enum: ["requirement", "prohibition", "coverage"], required: true },
        text: { type: "string", required: true },
        requiredEvidence: {
          type: "array",
          items: { type: "string", enum: ["build", "unit", "static", "simulated", "host_contract", "runtime_gui", "animation", "hover", "artifact", "source_hash", "build_hash", "loaded_hash", "host_receipt", "numeric_reconcile", "coverage", "user_feedback"] },
        },
        animation: { type: "string" },
        coverage: { type: "string", enum: ["full", "partial", "substitute", "unknown"] },
        verification: { type: "string", enum: ["mandate_delivery"] },
        sourceId: { type: "string" },
      },
    },
    description: "ObligationInput array; every item requires id/kind/text and rejects unknown fields.",
  },
  items: {
    type: "array",
    items: workItem,
    description: "WorkItemInput array; use dependencies (not dependsOn) and provide every required field.",
  },
  workItemRevisions: {
    type: "array",
    items: workItem,
    description: "Optional user-authorized complete WorkItemInput revisions for replan; passed through to Core.",
  },
  instruction: { type: "string" }, obligationDelta,
} as const;
const anchorParameters = {
  action: { type: "string", enum: ["create", "show", "history"], required: true }, ...common,
  instruction: { type: "string" }, obligationDelta,
} as const;
const mandateParameters = {
  action: { type: "string", enum: ["prepare", "bind", "bindReviewer", "report", "show"], required: true }, ...common,
  workItemId: { type: "string" }, mandateId: { type: "string" },
  workerAgentId: { type: "string", description: "Exact native descendant SessionId, not a display alias." },
  reviewerAgentId: { type: "string", description: "Exact independent native descendant SessionId launched with agent_preset=standard, not a display alias or super-agent/PTC Reviewer." },
  nativeTaskId: { type: "string" }, knownFailures: { type: "array", items: { type: "string" } }, summary: { type: "string" },
  routeReason: { type: "string", description: "Why the policy-selected Worker/Reviewer routes apply to this Mandate." },
} as const;
const modelRoute = {
  type: "object", additionalProperties: false,
  properties: {
    provider: { type: "string", required: true }, model: { type: "string", required: true }, reasoningEffort: { type: "string" },
  },
} as const;
const modelPolicy = {
  type: "object", additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["locked", "balanced", "economy", "performance"], required: true },
    allowedRoutes: { type: "array", items: modelRoute, required: true },
    workerRoute: modelRoute, reviewerRoute: modelRoute,
    allowFailureSwitch: { type: "boolean", required: true },
    maxSameRouteRetries: { type: "number", required: true }, maxRouteSwitches: { type: "number", required: true },
    cooldownMs: { type: "number" },
  },
} as const;
const routeParameters = {
  action: { type: "string", enum: ["show", "set", "inspect", "switch"], required: true },
  ...common,
  policy: modelPolicy,
  mandateId: { type: "string" },
  targetRole: { type: "string", enum: ["worker", "reviewer"] },
  to: modelRoute, failureCode: { type: "string" }, reason: { type: "string" },
} as const;
const evidenceParameters = {
  action: { type: "string", enum: ["observe", "record", "verify", "list"], required: true }, ...common,
  workItemId: { type: "string" }, mandateId: { type: "string" },
  kind: { type: "string", enum: ["build", "unit", "static", "simulated", "host_contract", "runtime_gui", "animation", "hover", "artifact", "source_hash", "build_hash", "loaded_hash", "host_receipt", "numeric_reconcile", "coverage", "user_feedback"], description: "For action=verify only coverage (default) or host_contract is supported." },
  result: { type: "string", enum: ["pass", "fail", "unknown"], description: "Only action=record; host observation derives this from native evidence." },
  receipt: {
    type: "object", additionalProperties: false,
    properties: Object.fromEntries([
      "exitCode", "passed", "failed", "total", "hash", "sourceHash", "buildHash", "loadedHash",
      "operation", "write", "coverage", "obligationId", "sourceId", "mode", "timeout", "unreadable",
      "malformed", "restartRequired", "deploymentStatus", "activityCount", "emptyReason", "actual", "expected",
      "left", "right", "delta", "scope", "artifactId", "status", "reason", "fingerprint", "violated", "observed",
    ].map(key => [key, { type: "json" as const }])),
    description: "Allowlisted model_reported facts; hostObserved is not in the model schema.",
  },
  summary: { type: "string" }, sessionId: { type: "string", description: "Exact native root/descendant SessionId owning eventSeq." },
  eventSeq: { type: "number" },
  verification: { type: "string", enum: ["mandate_delivery"], description: "Only action=verify; Host reads the real Lead/Worker native Sessions and records coverage or host_contract directly." },
  obligationId: { type: "string", description: "Coverage obligation linked to the current WorkItem; optional only when it is unambiguous." },
  sourceId: { type: "string", description: "Optional coverage source binding; must match the linked obligation." },
} as const;
const reviewParameters = {
  action: { type: "string", enum: ["evaluate", "decide", "release"], required: true }, ...common,
  workItemId: { type: "string" }, mandateId: { type: "string" },
  result: { type: "string", enum: ["pass", "fail", "unknown"] }, evidenceIds: { type: "array", items: { type: "string" } },
} as const;

export const SUPER_TOOL_PARAMETERS = {
  super_run: runParameters,
  super_anchor: anchorParameters,
  super_mandate: mandateParameters,
  super_evidence: evidenceParameters,
  super_review: reviewParameters,
  super_route: routeParameters,
  super_snapshot: {},
} as const;

