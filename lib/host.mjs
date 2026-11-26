import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
// src/host/errors.ts
var HostError = class extends Error {
	code;
	details;
	constructor(code, message, details) {
		super(message);
		this.name = "HostError";
		this.code = code;
		this.details = details;
	}
};
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
// src/host/native.ts
function currentModelRoute(agent) {
	const current = agent?.model.current();
	return current ? {
		provider: current.provider,
		model: current.model,
		...current.reasoningEffort !== void 0 ? { reasoningEffort: current.reasoningEffort } : {}
	} : agent ? null : void 0;
}
function taskDto(task) {
	return {
		id: task.id,
		revision: task.revision,
		status: task.status,
		subject: task.subject,
		description: task.description,
		ownerId: task.ownerId,
		ownerName: task.ownerName,
		blockedBy: [...task.blockedBy],
		writeScopes: [...task.writeScopes],
		ready: task.ready,
		writeScopeWarnings: [...task.writeScopeWarnings]
	};
}
function rootOf(ctx, agent) {
	if (!agent) throw new HostError("TOOL_CONTEXT_UNAVAILABLE", "super tools require an exact calling Agent");
	return ctx.subagents.rootOf(agent);
}
async function assertNativeMember(ctx, root, sessionId, signal) {
	if (sessionId === root.id) return;
	if (!(await ctx.subagents.listDescendants(root.id, signal)).some((row) => row.kind === "child" && row.id === sessionId)) throw new HostError("NATIVE_MEMBER_NOT_FOUND", "SessionId is not a readable descendant of the current root", { sessionId });
}
async function nativeMemberAddresses(ctx, root, sessionId, signal) {
	if (sessionId === root.id) return /* @__PURE__ */ new Set([root.id]);
	const row = (await ctx.subagents.listDescendants(root.id, signal)).find((item) => item.kind === "child" && item.id === sessionId);
	if (!row || row.kind !== "child") throw new HostError("NATIVE_MEMBER_NOT_FOUND", "SessionId is not a readable descendant of the current root", { sessionId });
	return /* @__PURE__ */ new Set([sessionId, ...typeof row.path === "string" && row.path.length > 0 ? [row.path] : []]);
}
async function readNativeProjection(ctx, root, signal) {
	signal?.throwIfAborted();
	const teamEnabled = ctx.agentTeams.isEnabled(root);
	const tasks = teamEnabled ? ctx.agentTeams.listTasks(root).map(taskDto) : [];
	const descendants = await ctx.subagents.listDescendants(root.id, signal);
	const subagentCatalog = [{
		id: root.id,
		name: "lead",
		status: root.status === "running" ? "running" : "inactive",
		activity: root.status === "running" ? "running" : "inactive",
		modelRoute: currentModelRoute(root)
	}, ...descendants.map((row) => row.kind === "diagnostic" ? {
		id: row.id,
		name: row.id,
		status: row.reason,
		diagnostic: row.reason
	} : {
		id: row.id,
		name: row.path ?? row.id,
		status: ctx.agents.get(row.id)?.status === "running" ? "running" : "inactive",
		activity: row.activity,
		mode: row.mode,
		modelRoute: currentModelRoute(ctx.agents.get(row.id))
	})];
	const nativeGoal = ctx.goals.get(root);
	const goal = nativeGoal ? {
		id: nativeGoal.id,
		revision: nativeGoal.revision,
		objective: nativeGoal.objective,
		phase: nativeGoal.phase,
		roundsStarted: nativeGoal.roundsStarted,
		maxGoalRounds: nativeGoal.maxGoalRounds,
		activation: nativeGoal.activation
	} : null;
	const observation = await ctx.sessionQuery.observeSession(root.id, { ...signal ? { signal } : {} });
	try {
		observation.projections?.values.subagentCatalog;
	} finally {
		observation[Symbol.dispose]();
	}
	return {
		root,
		teamEnabled,
		agentTeam: {
			enabled: teamEnabled,
			tasks
		},
		goal,
		subagentCatalog,
		descendantIds: new Set(descendants.filter((row) => row.kind === "child").map((row) => row.id))
	};
}
function nativeRecoveryReader(ctx, root) {
	return async (state) => {
		const native = await readNativeProjection(ctx, root);
		return Object.values(state.mandates).map((mandate) => {
			if (mandate.status !== "running") return {
				mandateId: mandate.id,
				status: "unknown"
			};
			if (mandate.nativeTaskId) {
				if (!native.teamEnabled) return {
					mandateId: mandate.id,
					status: "unknown"
				};
				const task = native.agentTeam.tasks.find((item) => item.id === mandate.nativeTaskId);
				if (!task) return {
					mandateId: mandate.id,
					status: "unknown"
				};
				if (task.status === "completed") return {
					mandateId: mandate.id,
					status: "reported_done"
				};
				if (task.status === "deleted") return {
					mandateId: mandate.id,
					status: "failed"
				};
				return {
					mandateId: mandate.id,
					status: "running"
				};
			}
			const workerId = mandate.workerAgentId;
			if (workerId && native.descendantIds.has(workerId)) {
				if (native.subagentCatalog.find((row) => row.id === workerId)?.activity === "running") return {
					mandateId: mandate.id,
					status: "running"
				};
			}
			return {
				mandateId: mandate.id,
				status: "unknown"
			};
		});
	};
}
// src/shared/wire.ts
/** Client ↔ host wire contract for the preset-scoped Super Agent projection. */
const API_CHANNEL = "/api";
const SUPER_AGENT_NAMESPACE = "dsh-super-agent-mode";
function endpointName(endpoint) {
	return `${SUPER_AGENT_NAMESPACE}/${endpoint}`;
}
function routePath(endpoint) {
	return `${API_CHANNEL}/${endpointName(endpoint)}`;
}
// src/host/projection.ts
function projectionBlockReasons(state, gates, recovery, native) {
	if (!state) return recovery.status === "unavailable" ? [recovery.reason ?? "CORE_RESTORE_UNAVAILABLE"] : [];
	const reasons = [];
	if (state.run.status !== "active" && state.run.status !== "completed") reasons.push(`RUN_${state.run.status.toUpperCase()}`);
	const anchor = state.anchors[state.run.currentAnchorId];
	const activeIds = new Set(anchor?.obligationSnapshot ?? []);
	for (const obligation of Object.values(state.obligations)) {
		if (activeIds.has(obligation.id) && obligation.status === "open") reasons.push(`OBLIGATION_OPEN:${obligation.id}`);
		if (activeIds.has(obligation.id) && obligation.status === "violated") reasons.push(`PROHIBITION_VIOLATED:${obligation.id}`);
	}
	for (const mandate of Object.values(state.mandates)) {
		if (mandate.needsStop) reasons.push(`NATIVE_STOP_REQUIRED:${mandate.id}`);
		if (mandate.status === "unknown") reasons.push(`MANDATE_UNKNOWN:${mandate.id}`);
	}
	for (const gate of gates) if (gate.result !== "pass") reasons.push(`GATE_${gate.result.toUpperCase()}:${gate.workItemId}`);
	for (const item of Object.values(state.workItems)) {
		if (!item.nativeTaskId || !native) continue;
		const task = native.agentTeam.tasks.find((entry) => entry.id === item.nativeTaskId);
		if (item.status === "accepted" && (!task || task.status !== "completed")) reasons.push(`NATIVE_EXECUTION_MISMATCH:${item.id}`);
	}
	if (recovery.status === "unavailable") reasons.push(recovery.reason ?? "CORE_RESTORE_UNAVAILABLE");
	return [...new Set(reasons)];
}
function createProjection(sessionId, state, native, gates, recovery, observedAt, proof) {
	const currentAnchor = state?.anchors[state.run.currentAnchorId] ?? null;
	const activeIds = new Set(currentAnchor?.obligationSnapshot ?? []);
	const obligations = state ? Object.values(state.obligations) : [];
	const value = {
		schemaVersion: 1,
		sessionId,
		agentPreset: "super-agent",
		run: state?.run ?? null,
		currentAnchor,
		anchors: state ? Object.values(state.anchors) : [],
		obligations,
		openObligations: obligations.filter((item) => activeIds.has(item.id) && item.status === "open"),
		workItems: state ? Object.values(state.workItems) : [],
		mandates: state ? Object.values(state.mandates) : [],
		routeFailures: state ? Object.values(state.routeFailures) : [],
		evidence: state ? Object.values(state.evidence) : [],
		decisions: state ? Object.values(state.decisions) : [],
		audit: state?.audit ?? [],
		gates,
		teamEnabled: native.teamEnabled,
		agentTeam: native.agentTeam,
		goal: native.goal,
		subagentCatalog: native.subagentCatalog,
		blockReasons: [],
		recovery,
		...proof ? { proof } : {},
		observedAt
	};
	value.blockReasons = projectionBlockReasons(state, gates, recovery, native);
	return value;
}
async function projectRoot(ctx, repository, root, signal) {
	const state = repository.read(root.id);
	const native = await readNativeProjection(ctx, root, signal);
	const after = repository.read(root.id);
	if (state?.run.revision !== after?.run.revision || state?.run.generation !== after?.run.generation) throw new HostError("PROJECTION_CONCURRENT_CHANGE", "Run changed while native state was read; retry the read-only projection");
	let proof;
	if (state) try {
		proof = {
			status: "verified",
			...await repository.verifyProof(root.id)
		};
	} catch (error) {
		const reason = error instanceof HostError ? error.code : "SNAPSHOT_PROOF_UNAVAILABLE";
		proof = {
			status: reason === "SNAPSHOT_PROOF_UNAVAILABLE" ? "unavailable" : "invalid",
			reason
		};
	}
	const finalState = repository.read(root.id);
	if (state?.run.revision !== finalState?.run.revision || state?.run.generation !== finalState?.run.generation) throw new HostError("PROJECTION_CONCURRENT_CHANGE", "Run changed during proof readback; retry the read-only projection");
	const proofInvalid = proof !== void 0 && proof.status !== "verified";
	const recovery = !state ? { status: "not_required" } : proofInvalid ? {
		status: "unavailable",
		reason: proof?.reason ?? "SNAPSHOT_PROOF_REQUIRED"
	} : repository.hasLiveCore(root.id) ? { status: "ready" } : {
		status: "unavailable",
		reason: "CORE_RESTORE_REQUIRED_ON_NEXT_WRITE"
	};
	return createProjection(root.id, state, native, repository.evaluate(root.id), recovery, (/* @__PURE__ */ new Date()).toISOString(), proof);
}
// src/host/rpc.ts
function fail(code, message, details = {}) {
	return {
		ok: false,
		error: {
			code,
			message,
			details
		}
	};
}
async function dispatchProjectionRpc(ctx, repository, payload) {
	try {
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new HostError("BAD_REQUEST", "payload must be an object");
		const sessionId = payload.sessionId;
		if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 4e3) throw new HostError("BAD_REQUEST", "sessionId must be an exact native root SessionId string");
		const agent = ctx.agents.get(sessionId);
		if (!agent) throw new HostError("SESSION_UNAVAILABLE", "the exact native SessionId is not a live Agent; aliases and cold ids are not resolved");
		const root = rootOf(ctx, agent);
		if (root.id !== sessionId) throw new HostError("SESSION_NOT_ROOT", "projection requires the root SessionId, not a descendant or alias");
		repository.read(sessionId);
		return {
			ok: true,
			value: await projectRoot(ctx, repository, root)
		};
	} catch (error) {
		return fail(error instanceof HostError ? error.code : "SESSION_QUERY_UNAVAILABLE", errorMessage(error), error instanceof HostError && error.details ? error.details : {});
	}
}
async function serve(ctx, repository, request) {
	let body;
	try {
		body = await request.json();
	} catch {
		return new Response("body is not JSON", { status: 400 });
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("invalid client-request envelope", { status: 400 });
	const message = body;
	const rpcId = typeof message.rpcId === "string" ? message.rpcId : void 0;
	if (!rpcId || message.method !== endpointName("projection")) return new Response("invalid client-request envelope or method mismatch", { status: 400 });
	const result = await dispatchProjectionRpc(ctx, repository, message.payload);
	return Response.json({
		type: "server-response",
		rpcId,
		result
	});
}
function registerProjectionRpc(ctx, repository) {
	ctx.inject(["connection"], (sub) => {
		const connection = sub.get("connection");
		if (!connection?.fetch) return;
		const dispose = connection.fetch.register({
			path: routePath("projection"),
			methods: ["POST"],
			requestBody: "buffered",
			fetch: (request) => serve(ctx, repository, request)
		});
		sub.effect(() => () => void dispose(), "super-agent:projection-rpc");
	});
}
// src/host/schema.ts
const id = z.string().trim().min(1).max(4e3);
const text = z.string().max(4e3);
const timestamp = z.string().datetime({ offset: true });
const revision = z.number().int().nonnegative();
const stringList = z.array(z.string().max(4e3)).max(256);
const jsonValueSchema = z.lazy(() => z.union([
	z.null(),
	z.boolean(),
	z.number().finite(),
	z.string().max(8e3),
	z.array(jsonValueSchema).max(256),
	z.record(z.string().max(200), jsonValueSchema)
]));
const receiptSchema = z.record(z.string().max(200), jsonValueSchema);
const evidenceKindSchema = z.enum([
	"build",
	"unit",
	"static",
	"simulated",
	"host_contract",
	"runtime_gui",
	"animation",
	"hover",
	"artifact",
	"source_hash",
	"build_hash",
	"loaded_hash",
	"host_receipt",
	"numeric_reconcile",
	"coverage",
	"user_feedback"
]);
const gatePolicySchema = z.object({
	maxAttempts: z.number().int().positive(),
	maxSameFingerprint: z.number().int().positive()
}).strict();
const obligationSchema = z.object({
	id,
	kind: z.enum([
		"requirement",
		"prohibition",
		"coverage"
	]),
	text,
	requiredEvidence: z.array(evidenceKindSchema).optional(),
	animation: z.string().optional(),
	coverage: z.enum([
		"full",
		"partial",
		"substitute",
		"unknown"
	]).optional(),
	sourceId: z.string().optional(),
	verification: z.literal("mandate_delivery").optional(),
	status: z.enum([
		"open",
		"met",
		"violated",
		"waived",
		"superseded"
	]),
	evidenceIds: z.array(id),
	userWaiver: z.string().optional()
}).strict();
const anchorSchema = z.object({
	id,
	version: z.number().int().positive(),
	supersedes: id.optional(),
	supersededBy: id.optional(),
	latestInstruction: text,
	definitionOfDone: text,
	constraints: stringList,
	obligationSnapshot: z.array(id),
	createdAt: timestamp
}).strict();
const modelRouteSchema = z.object({
	provider: id,
	model: id,
	reasoningEffort: z.string().min(1).max(1e3).optional()
}).strict();
const modelPolicySchema = z.object({
	mode: z.enum([
		"locked",
		"balanced",
		"economy",
		"performance"
	]),
	allowedRoutes: z.array(modelRouteSchema),
	workerRoute: modelRouteSchema.nullable().optional(),
	reviewerRoute: modelRouteSchema.nullable().optional(),
	allowFailureSwitch: z.boolean(),
	maxSameRouteRetries: z.number().int().nonnegative(),
	maxRouteSwitches: z.number().int().nonnegative(),
	cooldownMs: z.number().int().nonnegative().optional(),
	revision: z.number().int().positive()
}).strict();
const routeFailureSchema = z.object({
	id,
	mandateId: id,
	route: modelRouteSchema.nullable(),
	failureKind: z.enum([
		"transient",
		"timeout",
		"rate_limit",
		"quota",
		"account_quota",
		"provider_unavailable",
		"route_incompatible",
		"authentication",
		"permission",
		"tool_input",
		"business_acceptance",
		"snapshot_proof",
		"write_scope",
		"identity",
		"unknown"
	]),
	failureCode: text,
	action: z.enum([
		"rejected",
		"retry_recorded",
		"switch_required"
	]),
	sameRouteRetries: revision,
	routeSwitches: revision,
	createdAt: timestamp
}).strict();
const routeSwitchSchema = z.object({
	id,
	mandateId: id,
	from: modelRouteSchema.nullable(),
	to: modelRouteSchema.nullable(),
	failureCode: text,
	status: z.enum([
		"requested",
		"rejected",
		"exhausted"
	]),
	reason: text,
	attempt: z.number().int().positive(),
	generation: z.number().int().positive(),
	actor: id,
	createdAt: timestamp
}).strict();
const runSchema = z.object({
	id,
	sessionId: id,
	objective: text,
	definitionOfDone: text,
	status: z.enum([
		"active",
		"paused",
		"blocked",
		"needs_user",
		"completed"
	]),
	currentAnchorId: id,
	revision: z.number().int().positive(),
	generation: z.number().int().positive(),
	gatePolicy: gatePolicySchema,
	modelPolicy: modelPolicySchema.nullable().default(null),
	createdAt: timestamp,
	updatedAt: timestamp
}).strict();
const workItemSchema = z.object({
	id,
	nativeTaskId: id.optional(),
	title: text,
	writeScopes: stringList,
	dependencies: z.array(id),
	acceptance: stringList,
	obligationIds: z.array(id),
	gateProfile: z.enum([
		"code",
		"visual",
		"deployment",
		"numeric_reconcile",
		"coverage"
	]),
	hostContractRequired: z.boolean(),
	mandatory: z.boolean(),
	status: z.enum([
		"held",
		"ready",
		"mandated",
		"running",
		"reported_done",
		"verifying",
		"rework",
		"accepted",
		"blocked",
		"superseded"
	]),
	attempt: revision,
	failureFingerprints: z.record(z.string(), revision),
	currentMandateId: id.optional()
}).strict();
const mandateSchema = z.object({
	id,
	workItemId: id,
	anchorVersion: z.number().int().positive(),
	generation: z.number().int().positive(),
	attempt: z.number().int().positive(),
	workerId: id,
	reviewerId: id,
	reviewerAgentId: id.optional(),
	writeScopes: stringList,
	acceptance: stringList,
	knownFailures: stringList,
	status: z.enum([
		"prepared",
		"running",
		"reported_done",
		"verifying",
		"accepted",
		"superseded",
		"unknown"
	]),
	nativeTaskId: id.optional(),
	workerAgentId: id.optional(),
	needsStop: z.boolean(),
	mandateText: z.string().max(16e3),
	workerRoute: modelRouteSchema.nullable().optional(),
	reviewerRoute: modelRouteSchema.nullable().optional(),
	routeReason: text.optional(),
	policyRevision: revision.optional(),
	routeSwitches: z.array(routeSwitchSchema).optional()
}).strict();
const evidenceSchema = z.object({
	id,
	workItemId: id,
	mandateId: id,
	attempt: z.number().int().positive(),
	anchorVersion: z.number().int().positive(),
	generation: z.number().int().positive(),
	kind: evidenceKindSchema,
	result: z.enum([
		"pass",
		"fail",
		"unknown"
	]),
	sourceActor: id,
	sourceRole: z.enum([
		"worker",
		"reviewer",
		"lead",
		"host",
		"user"
	]),
	receipt: receiptSchema,
	summary: z.string().max(1e3),
	createdAt: timestamp
}).strict();
const decisionSchema = z.object({
	id,
	workItemId: id,
	mandateId: id,
	attempt: z.number().int().positive(),
	anchorVersion: z.number().int().positive(),
	generation: z.number().int().positive(),
	reviewerId: id,
	result: z.enum([
		"pass",
		"fail",
		"unknown"
	]),
	evidenceIds: z.array(id),
	reasons: stringList,
	createdAt: timestamp,
	invalidated: z.boolean()
}).strict();
const stateChangesSchema = z.object({
	run: runSchema.optional(),
	anchors: z.record(z.string(), anchorSchema.nullable()).optional(),
	obligations: z.record(z.string(), obligationSchema.nullable()).optional(),
	workItems: z.record(z.string(), workItemSchema.nullable()).optional(),
	mandates: z.record(z.string(), mandateSchema.nullable()).optional(),
	routeFailures: z.record(z.string(), routeFailureSchema.nullable()).optional(),
	evidence: z.record(z.string(), evidenceSchema.nullable()).optional(),
	decisions: z.record(z.string(), decisionSchema.nullable()).optional()
}).strict();
const auditSchema = z.object({
	id,
	runId: id,
	revision: z.number().int().positive(),
	generation: z.number().int().positive(),
	type: z.string().min(1).max(200),
	payload: receiptSchema,
	changes: stateChangesSchema,
	actor: id,
	timestamp
}).strict();
const runStateSchema = z.object({
	schemaVersion: z.literal(2),
	run: runSchema,
	anchors: z.record(z.string(), anchorSchema),
	obligations: z.record(z.string(), obligationSchema),
	workItems: z.record(z.string(), workItemSchema),
	mandates: z.record(z.string(), mandateSchema),
	routeFailures: z.record(z.string(), routeFailureSchema).default({}),
	evidence: z.record(z.string(), evidenceSchema),
	decisions: z.record(z.string(), decisionSchema),
	audit: z.array(auditSchema)
}).strict().superRefine((state, ctx) => {
	if (!state.anchors[state.run.currentAnchorId]) ctx.addIssue({
		code: "custom",
		message: "current anchor is missing",
		path: ["run", "currentAnchorId"]
	});
	for (const [key, value] of Object.entries(state.audit)) if (value.runId !== state.run.id || value.revision !== Number(key) + 1 || value.generation > state.run.generation) ctx.addIssue({
		code: "custom",
		message: "audit revision/run is inconsistent",
		path: ["audit", Number(key)]
	});
});
const snapshotProofSchema = z.object({
	runId: id,
	snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
	revision: z.number().int().positive(),
	generation: z.number().int().positive(),
	nativeEventSeq: z.number().int().positive()
}).strict();
const storedRunRecordSchema = z.object({
	schemaVersion: z.literal(1),
	state: runStateSchema,
	proof: snapshotProofSchema,
	recoveredAt: timestamp.optional()
}).strict();
// src/core/core.ts
const MAX_TEXT = 4e3;
const MAX_RECEIPT = 8e3;
function forbiddenReceiptKey(key) {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return /(token|cookie|secret|password|passwd|apikey|credential|privatekey|session|authorization|authentication)/.test(normalized) || normalized === "auth" || normalized === "body" || normalized === "content" || normalized === "transcript" || normalized === "sourcetext";
}
function obligationValid(input) {
	if (!isRecord(input)) return false;
	return textValid(input.id) && textValid(input.text) && [
		"requirement",
		"prohibition",
		"coverage"
	].includes(String(input.kind)) && (input.sourceId === void 0 || textValid(input.sourceId, 1e3)) && (input.animation === void 0 || textValid(input.animation, 1e3)) && (input.requiredEvidence === void 0 || Array.isArray(input.requiredEvidence) && input.requiredEvidence.every((kind) => [
		"build",
		"unit",
		"static",
		"simulated",
		"host_contract",
		"runtime_gui",
		"animation",
		"hover",
		"artifact",
		"source_hash",
		"build_hash",
		"loaded_hash",
		"host_receipt",
		"numeric_reconcile",
		"coverage",
		"user_feedback"
	].includes(String(kind)))) && (input.coverage === void 0 || [
		"full",
		"partial",
		"substitute",
		"unknown"
	].includes(String(input.coverage))) && (input.verification === void 0 || input.kind === "coverage" && input.verification === "mandate_delivery");
}
function clone(value) {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map((entry) => clone(entry));
	const result = {};
	for (const [key, entry] of Object.entries(value)) result[key] = clone(entry);
	return result;
}
function deepEqual(left, right) {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
	const leftObject = left;
	const rightObject = right;
	const leftKeys = Object.keys(leftObject);
	const rightKeys = Object.keys(rightObject);
	return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(rightObject, key) && deepEqual(leftObject[key], rightObject[key]));
}
function computeChanges(previous, next) {
	const changes = { run: clone(next.run) };
	for (const key of [
		"anchors",
		"obligations",
		"workItems",
		"mandates",
		"evidence",
		"decisions",
		"routeFailures"
	]) {
		const before = previous?.[key] ?? {};
		const after = next[key];
		const changed = {};
		for (const id of /* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])) if (!deepEqual(before[id], after[id])) changed[id] = after[id] ? clone(after[id]) : null;
		if (Object.keys(changed).length > 0) changes[key] = changed;
	}
	return changes;
}
function textValid(value, maximum = MAX_TEXT) {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}
function unique(values) {
	return [...new Set(values)];
}
function receiptString(evidence, key) {
	const value = evidence?.receipt[key];
	return typeof value === "string" ? value : void 0;
}
function receiptNumber(evidence, key) {
	const value = evidence?.receipt[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function scopeOverlap(left, right) {
	const normalize = (value) => value.replaceAll("\\", "/").replace(/\/+$/, "");
	const a = normalize(left);
	const b = normalize(right);
	return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}
function validateReceipt(receipt) {
	if (!isRecord(receipt)) return "receipt must be a JSON object";
	let serialized;
	try {
		serialized = JSON.stringify(receipt);
	} catch {
		return "receipt must be serializable JSON";
	}
	if (serialized === void 0) return "receipt must be serializable JSON";
	if (serialized.length > MAX_RECEIPT) return "receipt exceeds 8000 characters";
	const visit = (value, depth) => {
		if (depth > 8) return "receipt nesting exceeds 8 levels";
		if (typeof value === "number" && !Number.isFinite(value)) return "receipt numbers must be finite";
		if (value !== null && ![
			"string",
			"number",
			"boolean",
			"object"
		].includes(typeof value)) return "receipt contains non-JSON values";
		if (typeof value === "string" && value.length > 2e3) return "receipt text exceeds 2000 characters";
		if (Array.isArray(value)) {
			if (value.length > 100) return "receipt array exceeds 100 entries";
			for (const entry of value) {
				const problem = visit(entry, depth + 1);
				if (problem) return problem;
			}
		} else if (value !== null && typeof value === "object") for (const [key, entry] of Object.entries(value)) {
			if (forbiddenReceiptKey(key)) return "receipt contains credentials or unrelated body text: " + key;
			const problem = visit(entry, depth + 1);
			if (problem) return problem;
		}
		return null;
	};
	return visit(receipt, 0);
}
function routeShapeValid(value) {
	return isRecord(value) && textValid(value.provider, 1e3) && textValid(value.model, 1e3) && (value.reasoningEffort === void 0 || textValid(value.reasoningEffort, 1e3));
}
function nullableRouteShapeValid(value) {
	return value === void 0 || value === null || routeShapeValid(value);
}
function workItemInputValid(value) {
	if (!isRecord(value)) return false;
	return textValid(value.id) && textValid(value.title) && validStringArray(value.dependencies) && validStringArray(value.writeScopes) && validStringArray(value.obligationIds) && validStringArray(value.acceptance, false) && [
		"code",
		"visual",
		"deployment",
		"numeric_reconcile",
		"coverage"
	].includes(String(value.gateProfile)) && (value.mandatory === void 0 || typeof value.mandatory === "boolean") && (value.hostContractRequired === void 0 || typeof value.hostContractRequired === "boolean");
}
function normalizedWorkItemContract(source) {
	return {
		id: source.id,
		title: source.title,
		dependencies: [...source.dependencies],
		writeScopes: [...source.writeScopes],
		acceptance: [...source.acceptance],
		obligationIds: [...source.obligationIds],
		gateProfile: source.gateProfile,
		hostContractRequired: source.hostContractRequired ?? false,
		mandatory: source.mandatory ?? true
	};
}
function sameWorkItemContract(left, right) {
	return deepEqual(normalizedWorkItemContract(left), normalizedWorkItemContract(right));
}
function isMutationReceipt(receipt) {
	if (receipt.write === true) return true;
	const operation = receipt.operation;
	if (operation === void 0) return false;
	if (typeof operation !== "string") return true;
	const normalized = operation.trim().toLowerCase().replaceAll("-", "_");
	return !(/* @__PURE__ */ new Set([
		"read",
		"grep",
		"glob",
		"search",
		"list",
		"test",
		"build",
		"verify",
		"inspect",
		"screenshot",
		"diff",
		"status",
		"show",
		"get",
		"query",
		"observe",
		"run_tests",
		"typecheck"
	])).has(normalized);
}
function independentEvidenceSource(mandate, evidence) {
	if (!mandate) return false;
	const fromReviewer = evidence.sourceActor === mandate.reviewerId && evidence.sourceRole === "reviewer";
	const fromObservedHost = evidence.sourceRole === "host" && evidence.receipt.hostObserved === true;
	return fromReviewer || fromObservedHost;
}
function coverageMatches(evidence, obligation) {
	if (receiptString(evidence, "obligationId") === obligation.id) return true;
	const expectedSource = obligation.sourceId;
	return expectedSource !== void 0 && expectedSource.trim().length > 0 && receiptString(evidence, "sourceId") === expectedSource;
}
function runProhibitionViolations(state) {
	const anchor = state.anchors[state.run.currentAnchorId];
	const violations = [];
	for (const id of anchor.obligationSnapshot) {
		const obligation = state.obligations[id];
		if (!obligation || obligation.kind !== "prohibition" || obligation.status === "waived") continue;
		if (obligation.status === "violated" || Object.values(state.evidence).some((entry) => entry.generation === state.run.generation && receiptString(entry, "obligationId") === id && entry.receipt.violated === true)) violations.push(id);
	}
	return unique(violations);
}
function hasWorkerDoneProof(state, mandate) {
	if (state.audit.some((event) => event.type === "worker.reported_done" && event.payload.mandateId === mandate.id && event.generation === mandate.generation)) return true;
	return state.audit.some((event) => event.type === "run.recovered" && event.generation === mandate.generation && Array.isArray(event.payload.nativeReportedDoneMandateIds) && event.payload.nativeReportedDoneMandateIds.includes(mandate.id));
}
function latestByKind(evidence, kind) {
	const candidates = evidence.filter((entry) => entry.kind === kind);
	return candidates[candidates.length - 1];
}
function error(code, message, details) {
	return details ? {
		code,
		message,
		details
	} : {
		code,
		message
	};
}
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validStringArray(value, allowEmpty = true) {
	return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((entry) => textValid(entry, 1e3));
}
function validateAuditChanges(state) {
	let runAfter;
	const latest = {
		anchors: /* @__PURE__ */ new Map(),
		obligations: /* @__PURE__ */ new Map(),
		workItems: /* @__PURE__ */ new Map(),
		mandates: /* @__PURE__ */ new Map(),
		evidence: /* @__PURE__ */ new Map(),
		decisions: /* @__PURE__ */ new Map(),
		routeFailures: /* @__PURE__ */ new Map()
	};
	for (const event of state.audit) {
		if (event.changes.run !== void 0) runAfter = event.changes.run;
		for (const key of Object.keys(latest)) {
			const changes = event.changes[key];
			if (!changes) continue;
			for (const [id, after] of Object.entries(changes)) latest[key].set(id, after);
		}
	}
	if (!runAfter || !deepEqual(runAfter, state.run)) return error("SNAPSHOT_INVALID", "run does not match its latest audit after version");
	for (const key of Object.keys(latest)) {
		const current = key === "routeFailures" ? state.routeFailures ?? {} : state[key];
		for (const id of /* @__PURE__ */ new Set([...Object.keys(current), ...latest[key].keys()])) {
			const after = latest[key].get(id);
			if (after === null) {
				if (current[id] !== void 0) return error("SNAPSHOT_INVALID", key + " object was reintroduced after audit deletion: " + id);
			} else if (after === void 0 || current[id] === void 0 || !deepEqual(after, current[id])) return error("SNAPSHOT_INVALID", key + " object does not match its latest audit after version: " + id);
		}
	}
	return null;
}
function validateSnapshot(value) {
	const invalid = (message) => error("SNAPSHOT_INVALID", message);
	if (!isRecord(value) || value.schemaVersion !== 2) return invalid("schemaVersion must be 2 and snapshot must be an object");
	for (const key of [
		"anchors",
		"obligations",
		"workItems",
		"mandates",
		"evidence",
		"decisions"
	]) if (!isRecord(value[key])) return invalid(key + " must be an object map");
	if (!isRecord(value.run) || !Array.isArray(value.audit)) return invalid("run and audit are required");
	const run = value.run;
	if (!textValid(run.id) || !textValid(run.sessionId) || !textValid(run.objective) || !textValid(run.definitionOfDone) || ![
		"active",
		"paused",
		"blocked",
		"needs_user",
		"completed"
	].includes(String(run.status)) || !Number.isInteger(run.revision) || Number(run.revision) < 1 || !Number.isInteger(run.generation) || Number(run.generation) < 1 || !textValid(run.currentAnchorId) || !textValid(run.createdAt, 100) || !textValid(run.updatedAt, 100) || !isRecord(run.gatePolicy) || !Number.isInteger(run.gatePolicy.maxAttempts) || Number(run.gatePolicy.maxAttempts) < 1 || !Number.isInteger(run.gatePolicy.maxSameFingerprint) || Number(run.gatePolicy.maxSameFingerprint) < 1) return invalid("run fields or CAS/generation budgets are invalid");
	const runId = run.id;
	const revision = Number(run.revision);
	const generation = Number(run.generation);
	const anchors = value.anchors;
	const obligations = value.obligations;
	const workItems = value.workItems;
	const mandates = value.mandates;
	const evidence = value.evidence;
	const decisions = value.decisions;
	if (!anchors[String(run.currentAnchorId)]) return invalid("currentAnchorId must reference an anchor");
	for (const [id, raw] of Object.entries(anchors)) {
		if (!isRecord(raw) || raw.id !== id || !Number.isInteger(raw.version) || Number(raw.version) < 1 || !textValid(raw.latestInstruction) || !textValid(raw.definitionOfDone) || !validStringArray(raw.constraints) || !validStringArray(raw.obligationSnapshot) || !textValid(raw.createdAt, 100)) return invalid("invalid anchor " + id);
		if (raw.supersedes !== void 0 && (typeof raw.supersedes !== "string" || !anchors[raw.supersedes])) return invalid("anchor supersedes reference is invalid");
		if (raw.supersededBy !== void 0 && (typeof raw.supersededBy !== "string" || !anchors[raw.supersededBy])) return invalid("anchor supersededBy reference is invalid");
		if (new Set(raw.obligationSnapshot).size !== raw.obligationSnapshot.length) return invalid("anchor obligation snapshot contains duplicates");
		for (const obligationId of raw.obligationSnapshot) if (!obligations[obligationId]) return invalid("anchor references unknown obligation");
	}
	const currentAnchor = anchors[String(run.currentAnchorId)];
	if (Math.max(...Object.values(anchors).map((raw) => Number(raw.version))) !== currentAnchor.version) return invalid("current anchor must have the latest version");
	for (const [id, raw] of Object.entries(obligations)) {
		if (!isRecord(raw) || raw.id !== id || ![
			"requirement",
			"prohibition",
			"coverage"
		].includes(String(raw.kind)) || ![
			"open",
			"met",
			"violated",
			"waived",
			"superseded"
		].includes(String(raw.status)) || !textValid(raw.text) || !validStringArray(raw.evidenceIds) || raw.userWaiver !== void 0 && !textValid(raw.userWaiver) || raw.sourceId !== void 0 && !textValid(raw.sourceId, 1e3) || raw.animation !== void 0 && !textValid(raw.animation, 1e3) || raw.verification !== void 0 && (raw.kind !== "coverage" || raw.verification !== "mandate_delivery") || raw.requiredEvidence !== void 0 && !validStringArray(raw.requiredEvidence)) return invalid("invalid obligation " + id);
		for (const evidenceId of raw.evidenceIds) if (!evidence[evidenceId]) return invalid("obligation references unknown evidence");
	}
	for (const [id, raw] of Object.entries(workItems)) {
		if (!isRecord(raw) || raw.id !== id || !textValid(raw.title) || !validStringArray(raw.writeScopes) || !validStringArray(raw.dependencies) || !validStringArray(raw.acceptance, false) || !validStringArray(raw.obligationIds) || ![
			"code",
			"visual",
			"deployment",
			"numeric_reconcile",
			"coverage"
		].includes(String(raw.gateProfile)) || typeof raw.hostContractRequired !== "boolean" || typeof raw.mandatory !== "boolean" || ![
			"held",
			"ready",
			"mandated",
			"running",
			"reported_done",
			"verifying",
			"rework",
			"accepted",
			"blocked",
			"superseded"
		].includes(String(raw.status)) || !Number.isInteger(raw.attempt) || Number(raw.attempt) < 0 || !isRecord(raw.failureFingerprints) || raw.nativeTaskId !== void 0 && !textValid(raw.nativeTaskId, 1e3) || raw.currentMandateId !== void 0 && (typeof raw.currentMandateId !== "string" || !mandates[raw.currentMandateId])) return invalid("invalid work item " + id);
		for (const dependency of raw.dependencies) if (!workItems[dependency]) return invalid("work item references unknown dependency");
		for (const obligationId of raw.obligationIds) if (!obligations[obligationId]) return invalid("work item references unknown obligation");
		for (const count of Object.values(raw.failureFingerprints)) if (!Number.isInteger(count) || Number(count) < 0) return invalid("invalid failure fingerprint count");
		if (raw.status === "accepted" && !raw.dependencies.every((dependency) => {
			const parent = workItems[dependency];
			return isRecord(parent) && parent.status === "accepted";
		})) return invalid("accepted work item has a non-accepted dependency");
		if (raw.currentMandateId !== void 0) {
			const current = mandates[String(raw.currentMandateId)];
			if (current.workItemId !== id) return invalid("current mandate belongs to another work item");
			if (raw.status === "accepted") {
				if (current.status !== "accepted") return invalid("accepted work item lacks accepted current mandate");
				if (!Object.values(decisions).some((candidate) => isRecord(candidate) && candidate.workItemId === id && candidate.mandateId === current.id && candidate.reviewerId === current.reviewerId && candidate.attempt === raw.attempt && candidate.anchorVersion === current.anchorVersion && candidate.generation === current.generation && candidate.result === "pass" && candidate.invalidated === false)) return invalid("accepted work item lacks a valid current pass decision");
			}
		}
		if (raw.status === "accepted" && raw.currentMandateId === void 0) return invalid("accepted work item lacks current mandate");
	}
	for (const [id, raw] of Object.entries(mandates)) {
		if (!isRecord(raw) || raw.id !== id || typeof raw.workItemId !== "string" || !workItems[raw.workItemId] || !Number.isInteger(raw.anchorVersion) || !Number.isInteger(raw.generation) || !Number.isInteger(raw.attempt) || Number(raw.anchorVersion) < 1 || Number(raw.generation) < 1 || Number(raw.generation) > generation || Number(raw.attempt) < 1 || !textValid(raw.workerId) || !textValid(raw.reviewerId) || raw.workerId === raw.reviewerId || !validStringArray(raw.writeScopes) || !validStringArray(raw.acceptance, false) || !validStringArray(raw.knownFailures) || ![
			"prepared",
			"running",
			"reported_done",
			"verifying",
			"accepted",
			"superseded",
			"unknown"
		].includes(String(raw.status)) || typeof raw.needsStop !== "boolean" || !textValid(raw.mandateText, 2e4) || raw.nativeTaskId !== void 0 && !textValid(raw.nativeTaskId, 1e3) || raw.workerAgentId !== void 0 && !textValid(raw.workerAgentId, 1e3) || raw.reviewerAgentId !== void 0 && !textValid(raw.reviewerAgentId, 1e3) || raw.workerRoute !== void 0 && !nullableRouteShapeValid(raw.workerRoute) || raw.reviewerRoute !== void 0 && !nullableRouteShapeValid(raw.reviewerRoute) || raw.routeReason !== void 0 && !textValid(raw.routeReason) || raw.policyRevision !== void 0 && (!Number.isInteger(raw.policyRevision) || Number(raw.policyRevision) < 0) || raw.routeSwitches !== void 0 && !Array.isArray(raw.routeSwitches)) return invalid("invalid mandate " + id);
		if (Array.isArray(raw.routeSwitches)) {
			for (const routeSwitch of raw.routeSwitches) if (!isRecord(routeSwitch) || !textValid(routeSwitch.id) || routeSwitch.mandateId !== id || !nullableRouteShapeValid(routeSwitch.from) || !nullableRouteShapeValid(routeSwitch.to) || !textValid(routeSwitch.failureCode) || ![
				"requested",
				"rejected",
				"exhausted"
			].includes(String(routeSwitch.status)) || !textValid(routeSwitch.reason) || routeSwitch.attempt !== raw.attempt || routeSwitch.generation !== raw.generation || !textValid(routeSwitch.actor) || !textValid(routeSwitch.createdAt, 100)) return invalid("invalid route switch in mandate " + id);
		}
		const item = workItems[raw.workItemId];
		if (item.currentMandateId === id && item.attempt !== raw.attempt) return invalid("current mandate attempt does not match work item");
	}
	const routeFailures = isRecord(value.routeFailures) ? value.routeFailures : {};
	for (const [id, raw] of Object.entries(routeFailures)) if (!isRecord(raw) || raw.id !== id || typeof raw.mandateId !== "string" || !mandates[raw.mandateId] || !nullableRouteShapeValid(raw.route) || ![
		"transient",
		"timeout",
		"rate_limit",
		"quota",
		"account_quota",
		"provider_unavailable",
		"route_incompatible",
		"authentication",
		"permission",
		"tool_input",
		"business_acceptance",
		"snapshot_proof",
		"write_scope",
		"identity",
		"unknown"
	].includes(String(raw.failureKind)) || !textValid(raw.failureCode) || ![
		"rejected",
		"retry_recorded",
		"switch_required"
	].includes(String(raw.action)) || !Number.isInteger(raw.sameRouteRetries) || Number(raw.sameRouteRetries) < 0 || !Number.isInteger(raw.routeSwitches) || Number(raw.routeSwitches) < 0 || !textValid(raw.createdAt, 100)) return invalid("invalid route failure " + id);
	if (run.modelPolicy !== void 0 && run.modelPolicy !== null) {
		const policy = run.modelPolicy;
		if (!isRecord(policy) || ![
			"locked",
			"balanced",
			"economy",
			"performance"
		].includes(String(policy.mode)) || !Array.isArray(policy.allowedRoutes) || !policy.allowedRoutes.every(routeShapeValid) || typeof policy.allowFailureSwitch !== "boolean" || !Number.isInteger(policy.maxSameRouteRetries) || Number(policy.maxSameRouteRetries) < 0 || !Number.isInteger(policy.maxRouteSwitches) || Number(policy.maxRouteSwitches) < 0 || policy.workerRoute !== void 0 && policy.workerRoute !== null && !routeShapeValid(policy.workerRoute) || policy.reviewerRoute !== void 0 && policy.reviewerRoute !== null && !routeShapeValid(policy.reviewerRoute) || policy.cooldownMs !== void 0 && (typeof policy.cooldownMs !== "number" || !Number.isFinite(policy.cooldownMs) || policy.cooldownMs < 0) || !Number.isInteger(policy.revision) || Number(policy.revision) < 1) return invalid("invalid run model policy");
	}
	for (const [id, raw] of Object.entries(evidence)) {
		if (!isRecord(raw) || raw.id !== id || typeof raw.workItemId !== "string" || !workItems[raw.workItemId] || typeof raw.mandateId !== "string" || !mandates[raw.mandateId] || !Number.isInteger(raw.attempt) || !Number.isInteger(raw.anchorVersion) || !Number.isInteger(raw.generation) || ![
			"build",
			"unit",
			"static",
			"simulated",
			"host_contract",
			"runtime_gui",
			"animation",
			"hover",
			"artifact",
			"source_hash",
			"build_hash",
			"loaded_hash",
			"host_receipt",
			"numeric_reconcile",
			"coverage",
			"user_feedback"
		].includes(String(raw.kind)) || ![
			"pass",
			"fail",
			"unknown"
		].includes(String(raw.result)) || !textValid(raw.sourceActor, 1e3) || ![
			"worker",
			"reviewer",
			"lead",
			"host",
			"user"
		].includes(String(raw.sourceRole)) || !isRecord(raw.receipt) || typeof raw.summary !== "string" || raw.summary.length > 1e3 || !textValid(raw.createdAt, 100)) return invalid("invalid evidence " + id);
		const receiptProblem = validateReceipt(raw.receipt);
		if (receiptProblem) return invalid("evidence receipt is invalid: " + receiptProblem);
		const mandate = mandates[raw.mandateId];
		if (mandate.workItemId !== raw.workItemId || mandate.attempt !== raw.attempt || mandate.anchorVersion !== raw.anchorVersion || mandate.generation !== raw.generation) return invalid("evidence/mandate binding mismatch");
	}
	for (const [id, raw] of Object.entries(decisions)) {
		if (!isRecord(raw) || raw.id !== id || typeof raw.workItemId !== "string" || !workItems[raw.workItemId] || typeof raw.mandateId !== "string" || !mandates[raw.mandateId] || !Number.isInteger(raw.attempt) || !Number.isInteger(raw.anchorVersion) || !Number.isInteger(raw.generation) || !textValid(raw.reviewerId) || ![
			"pass",
			"fail",
			"unknown"
		].includes(String(raw.result)) || !validStringArray(raw.evidenceIds) || !validStringArray(raw.reasons) || !textValid(raw.createdAt, 100) || typeof raw.invalidated !== "boolean") return invalid("invalid decision " + id);
		const mandate = mandates[raw.mandateId];
		if (mandate.workItemId !== raw.workItemId || mandate.reviewerId !== raw.reviewerId || mandate.attempt !== raw.attempt || mandate.anchorVersion !== raw.anchorVersion || mandate.generation !== raw.generation) return invalid("decision/mandate binding mismatch");
		for (const evidenceId of raw.evidenceIds) {
			const cited = evidence[evidenceId];
			if (!isRecord(cited) || cited.workItemId !== raw.workItemId || cited.mandateId !== raw.mandateId) return invalid("decision cites unknown or mismatched evidence");
		}
	}
	if (value.audit.length !== revision) return invalid("audit length must equal run revision");
	const auditIds = /* @__PURE__ */ new Set();
	let previousGeneration = 0;
	for (let index = 0; index < value.audit.length; index += 1) {
		const raw = value.audit[index];
		if (!isRecord(raw) || !textValid(raw.id) || auditIds.has(raw.id) || raw.runId !== runId || raw.revision !== index + 1 || !Number.isInteger(raw.generation) || Number(raw.generation) < 1 || Number(raw.generation) > generation || Number(raw.generation) < previousGeneration || !textValid(raw.type) || !isRecord(raw.payload) || !isRecord(raw.changes) || !textValid(raw.actor) || !textValid(raw.timestamp, 100)) return invalid("audit log is not append-only CAS-consistent");
		auditIds.add(raw.id);
		previousGeneration = Number(raw.generation);
	}
	if (run.status === "completed") {
		for (const raw of Object.values(workItems)) if (isRecord(raw) && raw.mandatory === true && raw.status !== "accepted") return invalid("completed run has unaccepted mandatory work");
		for (const obligationId of currentAnchor.obligationSnapshot) {
			const obligation = obligations[obligationId];
			if (obligation.status !== "met" && obligation.status !== "waived") return invalid("completed run has open obligations");
		}
		if (runProhibitionViolations(value).length > 0) return invalid("completed run has a prohibition violation");
	}
	const changeChain = validateAuditChanges(value);
	if (changeChain) return changeChain;
	return null;
}
var SuperAgentCore = class {
	state = null;
	drivers;
	constructor(drivers) {
		this.drivers = drivers;
	}
	normalizeRoute(value) {
		if (!isRecord(value) || !textValid(value.provider, 1e3) || !textValid(value.model, 1e3) || value.reasoningEffort !== void 0 && !textValid(value.reasoningEffort, 1e3)) return {
			ok: false,
			error: error("INVALID_INPUT", "route requires bounded provider/model and optional reasoningEffort")
		};
		return {
			ok: true,
			route: {
				provider: value.provider,
				model: value.model,
				...typeof value.reasoningEffort === "string" ? { reasoningEffort: value.reasoningEffort } : {}
			}
		};
	}
	routeKey(route) {
		return route ? route.provider + "/" + route.model + "/" + (route.reasoningEffort ?? "") : "inherit";
	}
	routeAllowed(route, allowed) {
		const key = this.routeKey(route);
		return allowed.some((candidate) => this.routeKey(candidate) === key);
	}
	setModelPolicy(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		if (!this.off("routing")) {
			if (!isRecord(input.policy) || ![
				"locked",
				"balanced",
				"economy",
				"performance"
			].includes(String(input.policy.mode)) || !Array.isArray(input.policy.allowedRoutes) || typeof input.policy.allowFailureSwitch !== "boolean") return this.reject(error("INVALID_INPUT", "model policy mode, allowedRoutes and allowFailureSwitch are invalid"));
			const retries = input.policy.maxSameRouteRetries;
			const switches = input.policy.maxRouteSwitches;
			if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || typeof switches !== "number" || !Number.isInteger(switches) || switches < 0 || input.policy.cooldownMs !== void 0 && (typeof input.policy.cooldownMs !== "number" || !Number.isFinite(input.policy.cooldownMs) || input.policy.cooldownMs < 0)) return this.reject(error("INVALID_INPUT", "route retry/switch/cooldown budgets must be finite non-negative integers"));
			const routes = [];
			const seen = /* @__PURE__ */ new Set();
			for (const raw of input.policy.allowedRoutes) {
				const normalized = this.normalizeRoute(raw);
				if (!normalized.ok) return this.reject(normalized.error);
				const key = this.routeKey(normalized.route);
				if (seen.has(key)) return this.reject(error("INVALID_INPUT", "allowedRoutes contains a duplicate route"));
				seen.add(key);
				routes.push(normalized.route);
			}
			if (input.policy.mode === "locked" && routes.length === 0) return this.reject(error("INVALID_INPUT", "locked model policy requires a non-empty allowed route pool"));
			for (const [key, raw] of [["workerRoute", input.policy.workerRoute], ["reviewerRoute", input.policy.reviewerRoute]]) {
				if (raw === void 0) continue;
				const normalized = this.normalizeRoute(raw);
				if (!normalized.ok) return this.reject(normalized.error);
				if (!this.routeAllowed(normalized.route, routes)) return this.reject(error("ROUTE_NOT_ALLOWED", key + " must be in the explicitly authorized allowedRoutes pool"));
			}
		}
		const next = clone(state);
		const policy = {
			...clone(input.policy),
			allowedRoutes: input.policy.allowedRoutes.map((route) => clone(route)),
			revision: (state.run.modelPolicy?.revision ?? 0) + 1
		};
		next.run.modelPolicy = policy;
		return this.commit(next, "route.policy.updated", "lead", {
			policyRevision: policy.revision,
			mode: policy.mode,
			allowedRouteCount: policy.allowedRoutes.length,
			allowFailureSwitch: policy.allowFailureSwitch,
			maxSameRouteRetries: policy.maxSameRouteRetries,
			maxRouteSwitches: policy.maxRouteSwitches
		}, policy);
	}
	recordRouteFailure(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		const mandate = state.mandates[input.mandateId];
		if (!mandate) return this.reject(error("MANDATE_REQUIRED", "route failure requires a mandate"));
		if (!this.off("generation") && mandate.generation !== state.run.generation) return this.reject(error("STALE_GENERATION", "route failure mandate belongs to an old generation"));
		const retryable = [
			"transient",
			"timeout",
			"rate_limit"
		];
		const switchable = [
			"quota",
			"account_quota",
			"provider_unavailable",
			"route_incompatible"
		];
		if (!textValid(input.failureCode) || !textValid(input.mandateId)) return this.reject(error("INVALID_INPUT", "failureCode and mandateId are required bounded text"));
		const retry = input.retrySameRoute === true;
		const canRetry = retryable.includes(input.failureKind);
		const canSwitch = switchable.includes(input.failureKind);
		const policy = state.run.modelPolicy;
		const targetRole = input.targetRole ?? "worker";
		if (targetRole !== "worker" && targetRole !== "reviewer") return this.reject(error("INVALID_INPUT", "failure targetRole must be worker or reviewer"));
		const targetRoute = targetRole === "reviewer" ? mandate.reviewerRoute : mandate.workerRoute;
		const sameRouteRetries = Object.values(state.routeFailures).filter((entry) => entry.mandateId === mandate.id && this.routeKey(entry.route) === this.routeKey(targetRoute) && entry.action === "retry_recorded").length;
		const routeSwitches = mandate.routeSwitches?.filter((entry) => entry.status === "requested").length ?? 0;
		const hasAlternateRoute = policy?.allowedRoutes.some((candidate) => this.routeKey(candidate) !== this.routeKey(targetRoute)) ?? false;
		let action = "rejected";
		if (retry && canRetry && sameRouteRetries < (policy?.maxSameRouteRetries ?? 0)) action = "retry_recorded";
		else if (canSwitch && policy?.allowFailureSwitch === true && hasAlternateRoute && routeSwitches < policy.maxRouteSwitches) action = "switch_required";
		const next = clone(state);
		const failure = {
			id: this.drivers.createId("route-failure"),
			mandateId: mandate.id,
			route: clone(targetRoute ?? null),
			failureKind: input.failureKind,
			failureCode: input.failureCode,
			action,
			sameRouteRetries: action === "retry_recorded" ? sameRouteRetries + 1 : sameRouteRetries,
			routeSwitches,
			createdAt: this.drivers.now()
		};
		next.routeFailures[failure.id] = failure;
		if (action === "rejected" && (canRetry || canSwitch)) next.run.status = "blocked";
		return this.commit(next, "route.failure.recorded", "host", {
			failureId: failure.id,
			mandateId: mandate.id,
			failureKind: failure.failureKind,
			failureCode: failure.failureCode,
			action,
			sameRouteRetries: failure.sameRouteRetries,
			routeSwitches: failure.routeSwitches,
			blocked: next.run.status === "blocked"
		}, failure);
	}
	switchMandateRoute(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		const mandate = state.mandates[input.mandateId];
		if (!mandate) return this.reject(error("MANDATE_REQUIRED", "route switch requires a mandate"));
		if (!this.off("generation") && mandate.generation !== state.run.generation) return this.reject(error("STALE_GENERATION", "route switch mandate belongs to an old generation"));
		if (!textValid(input.failureCode) || !textValid(input.reason)) return this.reject(error("INVALID_INPUT", "route switch failureCode and reason are required bounded text"));
		const normalized = this.normalizeRoute(input.to);
		if (!normalized.ok) return this.reject(normalized.error);
		const policy = state.run.modelPolicy;
		const prior = mandate.routeSwitches ?? [];
		if (!this.off("routing")) {
			if (!policy?.allowFailureSwitch) return this.reject(error("ROUTE_SWITCH_DISABLED", "failure switching is not enabled by model policy"));
			if (!this.routeAllowed(normalized.route, policy.allowedRoutes)) return this.reject(error("ROUTE_NOT_ALLOWED", "target route is not explicitly allowed"));
			if (!Object.values(state.routeFailures).filter((entry) => entry.mandateId === mandate.id && entry.failureCode === input.failureCode).some((entry) => entry.action === "switch_required")) return this.reject(error("ROUTE_FAILURE_REQUIRED", "route switch requires a classified switchable failure record"));
			if (prior.filter((entry) => entry.status === "requested").length >= policy.maxRouteSwitches) return this.reject(error("ROUTE_BUDGET_EXHAUSTED", "route switch budget is exhausted"));
			const targetKey = input.targetRole === "reviewer" ? "reviewerRoute" : "workerRoute";
			if (this.routeKey(mandate[targetKey]) === this.routeKey(normalized.route)) return this.reject(error("ROUTE_SWITCH_INVALID", "target route must differ from the current role route"));
		}
		const next = clone(state);
		const nextMandate = next.mandates[mandate.id];
		const targetKey = input.targetRole === "reviewer" ? "reviewerRoute" : "workerRoute";
		const previousRoute = nextMandate[targetKey] ?? null;
		nextMandate[targetKey] = normalized.route;
		const routeSwitch = {
			id: this.drivers.createId("route-switch"),
			mandateId: mandate.id,
			from: clone(previousRoute),
			to: clone(normalized.route),
			failureCode: input.failureCode,
			status: "requested",
			reason: input.reason,
			attempt: mandate.attempt,
			generation: mandate.generation,
			actor: "lead",
			createdAt: this.drivers.now()
		};
		nextMandate.routeSwitches = [...prior, routeSwitch];
		return this.commit(next, "route.switch.requested", "lead", {
			switchId: routeSwitch.id,
			mandateId: mandate.id,
			targetRole: input.targetRole,
			from: this.routeKey(previousRoute),
			to: this.routeKey(normalized.route),
			failureCode: input.failureCode,
			attempt: mandate.attempt,
			generation: mandate.generation,
			newExecutionRequiresNewMandate: true
		}, routeSwitch);
	}
	snapshot() {
		return this.state ? clone(this.state) : null;
	}
	off(_check) {
		return false;
	}
	reject(problem) {
		return {
			ok: false,
			state: this.state ? clone(this.state) : null,
			error: problem,
			events: []
		};
	}
	guard(input) {
		const state = this.state;
		if (!state) return error("RUN_NOT_FOUND", "run does not exist");
		if (!isRecord(input)) return error("INVALID_INPUT", "write guard must be an object");
		if (!this.off("revision") && input.expectedRevision !== state.run.revision) return error("STALE_REVISION", "expectedRevision does not match", {
			expectedRevision: input.expectedRevision,
			actualRevision: state.run.revision
		});
		if (!this.off("generation") && input.expectedGeneration !== state.run.generation) return error("STALE_GENERATION", "expectedGeneration does not match", {
			expectedGeneration: input.expectedGeneration,
			actualGeneration: state.run.generation
		});
		return null;
	}
	mutable() {
		if (this.state?.run.status === "paused" || this.state?.run.status === "completed") return error("INVALID_TRANSITION", "run is not writable in status " + this.state.run.status);
		return null;
	}
	commit(next, type, actor, payload, value, base = this.state) {
		next.run.revision += 1;
		next.run.updatedAt = this.drivers.now();
		const event = {
			id: this.drivers.createId("audit"),
			runId: next.run.id,
			revision: next.run.revision,
			generation: next.run.generation,
			type,
			payload: clone(payload),
			changes: computeChanges(base, next),
			actor,
			timestamp: next.run.updatedAt
		};
		next.audit.push(event);
		this.state = next;
		return {
			ok: true,
			state: clone(next),
			value: clone(value),
			events: [clone(event)]
		};
	}
	createRun(input) {
		if (this.state) return this.reject(error("INVALID_TRANSITION", "core instance already owns a run"));
		if (!isRecord(input) || !Array.isArray(input.obligations) || input.gatePolicy !== void 0 && !isRecord(input.gatePolicy)) return this.reject(error("INVALID_INPUT", "createRun requires an object, obligations array and optional gatePolicy object"));
		if (!textValid(input.sessionId) || !textValid(input.objective) || !textValid(input.definitionOfDone)) return this.reject(error("INVALID_TRANSITION", "sessionId, objective and definitionOfDone are required bounded text"));
		const ids = /* @__PURE__ */ new Set();
		for (const obligation of input.obligations) {
			if (!obligationValid(obligation) || ids.has(obligation.id)) return this.reject(error("INVALID_TRANSITION", "obligation ids must be unique and text must be bounded"));
			ids.add(obligation.id);
		}
		const maxAttempts = input.gatePolicy?.maxAttempts ?? 4;
		const maxSameFingerprint = input.gatePolicy?.maxSameFingerprint ?? 2;
		if (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || typeof maxSameFingerprint !== "number" || !Number.isInteger(maxSameFingerprint) || maxSameFingerprint < 1) return this.reject(error("INVALID_TRANSITION", "failure budgets must be positive integers"));
		const timestamp = this.drivers.now();
		const runId = this.drivers.createId("run");
		const anchorId = this.drivers.createId("anchor");
		const obligations = {};
		for (const source of input.obligations) obligations[source.id] = {
			...clone(source),
			status: "open",
			evidenceIds: []
		};
		const anchor = {
			id: anchorId,
			version: 1,
			latestInstruction: input.objective,
			definitionOfDone: input.definitionOfDone,
			constraints: [],
			obligationSnapshot: [...ids],
			createdAt: timestamp
		};
		const state = {
			schemaVersion: 2,
			run: {
				id: runId,
				sessionId: input.sessionId,
				objective: input.objective,
				definitionOfDone: input.definitionOfDone,
				status: "active",
				currentAnchorId: anchorId,
				revision: 1,
				generation: 1,
				gatePolicy: {
					maxAttempts,
					maxSameFingerprint
				},
				modelPolicy: null,
				createdAt: timestamp,
				updatedAt: timestamp
			},
			anchors: { [anchorId]: anchor },
			obligations,
			workItems: {},
			mandates: {},
			routeFailures: {},
			evidence: {},
			decisions: {},
			audit: []
		};
		this.state = state;
		const event = {
			id: this.drivers.createId("audit"),
			runId,
			revision: 1,
			generation: 1,
			type: "run.created",
			payload: {
				objective: input.objective,
				anchorVersion: 1
			},
			changes: computeChanges(null, state),
			actor: "lead",
			timestamp
		};
		state.audit.push(event);
		return {
			ok: true,
			state: clone(state),
			value: clone(state.run),
			events: [clone(event)]
		};
	}
	validateSnapshotSemantics(snapshot) {
		if (snapshot.run.status === "completed") {
			const completion = snapshot.audit[snapshot.audit.length - 1];
			if (!completion || completion.type !== "run.completed" || completion.revision !== snapshot.run.revision || completion.generation !== snapshot.run.generation) return error("SNAPSHOT_INVALID", "completed snapshot requires a final matching run.completed audit event");
		}
		const anchor = snapshot.anchors[snapshot.run.currentAnchorId];
		for (const obligationId of anchor.obligationSnapshot) {
			const obligation = snapshot.obligations[obligationId];
			if (obligation.status === "waived") {
				const waiverAudited = snapshot.audit.some((event) => event.type === "anchor.applied" && Array.isArray(event.payload.changedObligationIds) && event.payload.changedObligationIds.includes(obligationId));
				if (!obligation.userWaiver || !waiverAudited) return error("SNAPSHOT_INVALID", "waived obligation lacks bounded user waiver and anchor audit", { obligationId });
			}
			if (obligation.status === "met") {
				const acceptedProof = Object.values(snapshot.workItems).some((item) => item.status === "accepted" && item.obligationIds.includes(obligationId));
				if (obligation.evidenceIds.length === 0 || !acceptedProof) return error("SNAPSHOT_INVALID", "met obligation lacks evidence and accepted work proof", { obligationId });
			}
		}
		for (const item of Object.values(snapshot.workItems).filter((entry) => !entry.mandatory)) if (!snapshot.audit.some((event) => event.type === "work.planned" && isRecord(event.payload.mandatoryByItem) && event.payload.mandatoryByItem[item.id] === false)) return error("SNAPSHOT_INVALID", "non-mandatory work item lacks planning audit provenance", { workItemId: item.id });
		for (const item of Object.values(snapshot.workItems).filter((entry) => entry.status === "accepted")) {
			const mandate = item.currentMandateId ? snapshot.mandates[item.currentMandateId] : void 0;
			if (!mandate) return error("SNAPSHOT_INVALID", "accepted item lacks its mandate");
			const decisions = Object.values(snapshot.decisions).filter((decision) => decision.workItemId === item.id && decision.mandateId === mandate.id && !decision.invalidated);
			const decision = decisions[decisions.length - 1];
			if (!decision || decision.result !== "pass" || decision.reviewerId !== mandate.reviewerId || decision.attempt !== item.attempt || decision.anchorVersion !== mandate.anchorVersion || decision.generation !== mandate.generation || decision.evidenceIds.length === 0) return error("SNAPSHOT_INVALID", "accepted item lacks a complete current pass decision chain");
			if (!hasWorkerDoneProof(snapshot, mandate)) return error("SNAPSHOT_INVALID", "accepted item lacks its worker reported_done audit precursor");
			const historical = clone(snapshot);
			historical.run.generation = mandate.generation;
			const citedGate = this.evaluateOn(historical, item.id, decision.evidenceIds);
			const fullGate = this.evaluateOn(historical, item.id);
			if (citedGate.result !== "pass" || fullGate.result !== "pass") return error("SNAPSHOT_INVALID", "accepted item fails decision-evidence-gate semantic revalidation", {
				workItemId: item.id,
				citedReasons: citedGate.reasons,
				fullReasons: fullGate.reasons
			});
		}
		return null;
	}
	createRecoveryReviewMandate(state, historical) {
		const item = state.workItems[historical.workItemId];
		historical.status = "reported_done";
		historical.needsStop = false;
		const recovery = {
			...historical,
			id: this.drivers.createId("mandate"),
			generation: state.run.generation,
			attempt: item.attempt + 1,
			writeScopes: [...historical.writeScopes],
			acceptance: [...historical.acceptance],
			knownFailures: [...historical.knownFailures],
			status: "reported_done",
			needsStop: false
		};
		state.mandates[recovery.id] = recovery;
		item.currentMandateId = recovery.id;
		item.attempt = recovery.attempt;
		item.status = "reported_done";
		return recovery;
	}
	restoreSnapshot(snapshot, nativeReceipts = [], proof) {
		if (this.state) return this.reject(error("INVALID_TRANSITION", "restoreSnapshot requires a fresh core without a run"));
		const validation = this.off("restore") ? null : validateSnapshot(snapshot);
		if (validation) return this.reject(validation);
		if (!isRecord(snapshot)) return this.reject(error("SNAPSHOT_INVALID", "snapshot must be an object"));
		if (!this.off("proof")) {
			if (!proof) return this.reject(error("SNAPSHOT_PROOF_REQUIRED", "restore requires a native root Session snapshot proof"));
			if (!textValid(proof.runId, 1e3) || !textValid(proof.snapshotSha256, 256) || !Number.isInteger(proof.revision) || !Number.isInteger(proof.generation) || !Number.isInteger(proof.nativeEventSeq) || proof.nativeEventSeq < 1) return this.reject(error("SNAPSHOT_PROOF_MISMATCH", "snapshot proof fields are invalid"));
			const candidateRun = snapshot.run;
			let actualDigest;
			try {
				actualDigest = this.drivers.digestSnapshot(snapshot);
			} catch {
				return this.reject(error("SNAPSHOT_PROOF_MISMATCH", "snapshot digest could not be computed"));
			}
			if (proof.runId !== candidateRun.id || proof.revision !== candidateRun.revision || proof.generation !== candidateRun.generation || proof.snapshotSha256 !== actualDigest) return this.reject(error("SNAPSHOT_PROOF_MISMATCH", "snapshot proof does not match digest/revision/generation", {
				expectedRevision: proof.revision,
				actualRevision: candidateRun.revision,
				expectedGeneration: proof.generation,
				actualGeneration: candidateRun.generation
			}));
		}
		const next = clone(snapshot);
		const semanticValidation = this.off("restore") ? null : this.validateSnapshotSemantics(next);
		if (semanticValidation) return this.reject(semanticValidation);
		if (!Array.isArray(nativeReceipts)) return this.reject(error("INVALID_INPUT", "nativeReceipts must be an array"));
		next.routeFailures ??= {};
		const recoveryBaseline = clone(next);
		const previousGeneration = next.run.generation;
		const receipts = /* @__PURE__ */ new Map();
		for (const receipt of nativeReceipts) {
			if (!isRecord(receipt) || !textValid(receipt.mandateId, 1e3) || !next.mandates[receipt.mandateId] || receipts.has(receipt.mandateId) || ![
				"running",
				"reported_done",
				"unknown",
				"failed"
			].includes(receipt.status)) return this.reject(error("SNAPSHOT_INVALID", "native recovery receipt is invalid, duplicate or unknown"));
			receipts.set(receipt.mandateId, receipt);
		}
		next.run.generation += 1;
		if (next.run.status === "completed") next.run.status = "active";
		const unknownMandateIds = [];
		const nativeReportedDoneMandateIds = [];
		for (const mandate of Object.values(next.mandates)) {
			if (mandate.status !== "running") continue;
			const receipt = receipts.get(mandate.id);
			const item = next.workItems[mandate.workItemId];
			if (!receipt || receipt.status === "unknown" || receipt.status === "failed") {
				mandate.status = "unknown";
				mandate.needsStop = false;
				item.status = "verifying";
				unknownMandateIds.push(mandate.id);
			} else if (receipt.status === "reported_done") {
				const recovery = this.createRecoveryReviewMandate(next, mandate);
				nativeReportedDoneMandateIds.push(recovery.id);
			}
		}
		if (next.run.status === "paused") next.run.status = "active";
		const value = {
			...next.run,
			unknownMandateIds
		};
		return this.commit(next, "run.recovered", "host", {
			previousGeneration,
			generation: next.run.generation,
			unknownMandateIds,
			nativeReportedDoneMandateIds,
			restored: true,
			nativeEventSeq: proof?.nativeEventSeq ?? null,
			snapshotSha256: proof?.snapshotSha256 ?? null
		}, value, recoveryBaseline);
	}
	applyUserInstruction(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		if (input.runId !== state.run.id) return this.reject(error("RUN_NOT_FOUND", "runId does not belong to this core"));
		if (!textValid(input.instruction)) return this.reject(error("INVALID_TRANSITION", "instruction must be bounded non-empty text"));
		if (!Array.isArray(input.obligationDelta)) return this.reject(error("INVALID_INPUT", "obligationDelta must be an array"));
		const revisionInputs = input.workItemRevisions === void 0 ? [] : input.workItemRevisions;
		if (!Array.isArray(revisionInputs) || revisionInputs.some((revision) => !workItemInputValid(revision))) return this.reject(error("INVALID_INPUT", "workItemRevisions must contain complete valid work item contracts"));
		const revisions = [];
		const revisionAudits = [];
		const revisionIds = /* @__PURE__ */ new Set();
		for (const source of revisionInputs) {
			if (revisionIds.has(source.id)) return this.reject(error("INVALID_INPUT", "workItemRevisions contains a duplicate work item: " + source.id));
			const existing = state.workItems[source.id];
			if (!existing) return this.reject(error("INVALID_TRANSITION", "workItemRevisions requires an existing work item: " + source.id));
			const currentMandate = existing.currentMandateId ? state.mandates[existing.currentMandateId] : void 0;
			const hasValidPass = currentMandate !== void 0 && Object.values(state.decisions).some((decision) => decision.workItemId === existing.id && decision.mandateId === currentMandate.id && decision.reviewerId === currentMandate.reviewerId && decision.attempt === existing.attempt && decision.anchorVersion === currentMandate.anchorVersion && decision.generation === currentMandate.generation && decision.result === "pass" && !decision.invalidated) && this.evaluateOn(state, existing.id).result === "pass";
			if (existing.status === "accepted" || hasValidPass) return this.reject(error("INVALID_TRANSITION", "accepted work or a current valid pass cannot be replaced by workItemRevisions: " + source.id));
			const after = normalizedWorkItemContract(source);
			revisions.push(after);
			revisionAudits.push({
				before: normalizedWorkItemContract(existing),
				after
			});
			revisionIds.add(source.id);
		}
		for (const delta of input.obligationDelta) {
			if (!isRecord(delta) || ![
				"add",
				"amend",
				"waive",
				"supersede"
			].includes(String(delta.op))) return this.reject(error("INVALID_INPUT", "obligationDelta entries must be objects with a supported op"));
			if ((delta.op === "amend" || delta.op === "waive" || delta.op === "supersede") && !textValid(delta.id)) return this.reject(error("INVALID_INPUT", "obligation delta id must be bounded non-empty text"));
			if (delta.op === "add" && !isRecord(delta.obligation)) return this.reject(error("INVALID_INPUT", "add delta requires an obligation object"));
			if (delta.op === "amend" && !isRecord(delta.patch)) return this.reject(error("INVALID_INPUT", "amend delta requires a patch object"));
			if (delta.op === "supersede" && !isRecord(delta.replacement)) return this.reject(error("INVALID_INPUT", "supersede delta requires a replacement object"));
		}
		const next = clone(state);
		const oldAnchor = next.anchors[next.run.currentAnchorId];
		const changed = /* @__PURE__ */ new Set();
		for (const delta of input.obligationDelta) {
			if (delta.op === "add") {
				const source = delta.obligation;
				if (!this.off("input") && !obligationValid(source)) return this.reject(error("INVALID_TRANSITION", "added obligation fails text/schema bounds"));
				if (next.obligations[source.id] && next.obligations[source.id].status !== "superseded") return this.reject(error("INVALID_TRANSITION", "obligation already exists: " + source.id));
				next.obligations[source.id] = {
					...clone(source),
					status: "open",
					evidenceIds: []
				};
				changed.add(source.id);
				continue;
			}
			const current = next.obligations[delta.id];
			if (!current || !oldAnchor.obligationSnapshot.includes(delta.id) || current.status === "superseded") return this.reject(error("OBLIGATION_OPEN", "cannot change unknown or inactive obligation: " + delta.id));
			changed.add(delta.id);
			if (delta.op === "waive") {
				if (!textValid(delta.reason)) return this.reject(error("INVALID_TRANSITION", "waiver reason is required"));
				current.status = "waived";
				current.userWaiver = delta.reason;
			} else if (delta.op === "amend") {
				const preservedId = current.id;
				Object.assign(current, clone(delta.patch));
				current.id = preservedId;
				current.status = "open";
				current.userWaiver = void 0;
				current.evidenceIds = [];
				if (!this.off("input") && !obligationValid(current)) return this.reject(error("INVALID_TRANSITION", "amended obligation fails text/schema bounds"));
			} else {
				current.status = "superseded";
				const replacement = delta.replacement;
				if (!this.off("input") && !obligationValid(replacement)) return this.reject(error("INVALID_TRANSITION", "replacement obligation fails text/schema bounds"));
				if (next.obligations[replacement.id] && next.obligations[replacement.id].status !== "superseded") return this.reject(error("INVALID_TRANSITION", "replacement obligation already exists: " + replacement.id));
				next.obligations[replacement.id] = {
					...clone(replacement),
					status: "open",
					evidenceIds: []
				};
				changed.add(replacement.id);
			}
		}
		const anchorId = this.drivers.createId("anchor");
		const anchor = {
			id: anchorId,
			version: oldAnchor.version + 1,
			supersedes: oldAnchor.id,
			latestInstruction: input.instruction,
			definitionOfDone: oldAnchor.definitionOfDone,
			constraints: [...oldAnchor.constraints],
			obligationSnapshot: Object.values(next.obligations).filter((obligation) => obligation.status !== "superseded").map((obligation) => obligation.id),
			createdAt: this.drivers.now()
		};
		for (const revision of revisions) if (revision.obligationIds.some((id) => !anchor.obligationSnapshot.includes(id))) return this.reject(error("OBLIGATION_OPEN", "work item revision references an unknown obligation: " + revision.id));
		next.anchors[anchorId] = anchor;
		oldAnchor.supersededBy = anchorId;
		next.run.currentAnchorId = anchorId;
		const affected = new Set(revisionIds);
		if (!this.off("anchor")) {
			for (const item of Object.values(next.workItems)) if (item.obligationIds.some((id) => changed.has(id))) affected.add(item.id);
			let expanded = true;
			while (expanded) {
				expanded = false;
				for (const item of Object.values(next.workItems)) if (!affected.has(item.id) && item.dependencies.some((id) => affected.has(id))) {
					affected.add(item.id);
					expanded = true;
				}
			}
			for (const itemId of affected) {
				const item = next.workItems[itemId];
				item.status = "superseded";
				for (const decision of Object.values(next.decisions)) if (decision.workItemId === itemId) decision.invalidated = true;
				for (const mandate of Object.values(next.mandates)) if (mandate.workItemId === itemId && mandate.status !== "superseded") {
					mandate.needsStop = mandate.status === "running";
					mandate.status = "superseded";
				}
			}
		}
		if (next.run.status === "blocked" || next.run.status === "needs_user") next.run.status = "active";
		return this.commit(next, "anchor.applied", "user", {
			anchorId,
			anchorVersion: anchor.version,
			changedObligationIds: [...changed],
			affectedWorkItemIds: [...affected],
			revisedWorkItemIds: revisions.map((revision) => revision.id),
			workItemRevisions: clone(revisions),
			workItemRevisionAudits: clone(revisionAudits),
			classification: revisions.length > 0 ? "user_contract_revision" : input.obligationDelta.every((delta) => delta.op === "add") && input.obligationDelta.length > 0 ? "user_scope_expansion" : "user_instruction"
		}, anchor);
	}
	planWorkItems(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		if (!Array.isArray(input.items) || input.items.length === 0) return this.reject(error("INVALID_INPUT", "items must be a non-empty array"));
		if (input.items.some((item) => !workItemInputValid(item))) return this.reject(error("INVALID_INPUT", "work item has missing or invalid dependencies/scopes/acceptance/obligations/gateProfile/flags"));
		const next = clone(state);
		const all = { ...next.workItems };
		const anchor = next.anchors[next.run.currentAnchorId];
		const anchorEvents = next.audit.filter((event) => event.type === "anchor.applied" && event.payload.anchorId === anchor.id);
		const approvedRevisions = anchorEvents[anchorEvents.length - 1]?.payload.workItemRevisions;
		const batchIds = /* @__PURE__ */ new Set();
		for (const source of input.items) {
			if (!textValid(source.id) || !textValid(source.title) || source.acceptance.length === 0 || source.acceptance.some((entry) => !textValid(entry)) || source.writeScopes.some((scope) => !textValid(scope, 1e3))) return this.reject(error("INVALID_TRANSITION", "work item text, acceptance and write scopes must be valid"));
			const existing = next.workItems[source.id];
			const existingMandate = existing?.currentMandateId ? next.mandates[existing.currentMandateId] : void 0;
			const recoveryReplan = existing && existingMandate && existingMandate.generation !== next.run.generation && (existing.status === "accepted" || existing.status === "reported_done");
			const unknownReplan = existing?.status === "verifying" && existingMandate?.status === "unknown";
			const currentDecisions = existing && existingMandate ? Object.values(next.decisions).filter((decision) => decision.workItemId === existing.id && decision.mandateId === existingMandate.id && decision.reviewerId === existingMandate.reviewerId && decision.attempt === existing.attempt && decision.anchorVersion === existingMandate.anchorVersion && decision.generation === existingMandate.generation && !decision.invalidated) : [];
			const latestDecision = currentDecisions[currentDecisions.length - 1];
			const unknownDecisionReplan = existing?.status === "verifying" && existingMandate?.status === "verifying" && latestDecision?.result === "unknown";
			const contradictedPassReplan = existing?.status === "verifying" && existingMandate?.status === "verifying" && latestDecision?.result === "pass" && this.evaluateOn(next, existing.id).result !== "pass";
			const sameContractReplan = recoveryReplan || unknownReplan || unknownDecisionReplan || contradictedPassReplan;
			const replannable = existing && (existing.status === "superseded" || sameContractReplan);
			if (batchIds.has(source.id) || existing && !replannable) return this.reject(error("INVALID_TRANSITION", "duplicate active work item: " + source.id));
			batchIds.add(source.id);
			if (source.obligationIds.some((id) => !anchor.obligationSnapshot.includes(id))) return this.reject(error("OBLIGATION_OPEN", "work item references an unknown obligation: " + source.id));
			const previous = next.workItems[source.id];
			if (sameContractReplan && previous && !sameWorkItemContract(previous, source)) return this.reject(error("INVALID_TRANSITION", "same-contract replan must preserve title, dependencies, writeScopes, acceptance, obligationIds, gateProfile, hostContractRequired and mandatory"));
			const approvedRevisionValue = Array.isArray(approvedRevisions) ? approvedRevisions.find((candidate) => isRecord(candidate) && candidate.id === source.id) : void 0;
			const revisionDrivenReplan = existing?.status === "superseded" && Array.isArray(approvedRevisions) && approvedRevisions.length > 0;
			if (revisionDrivenReplan && workItemInputValid(approvedRevisionValue) && !sameWorkItemContract(approvedRevisionValue, source)) return this.reject(error("INVALID_TRANSITION", "replan must match the user-approved work item revision: " + source.id));
			if (revisionDrivenReplan && !workItemInputValid(approvedRevisionValue) && previous && !sameWorkItemContract(previous, source)) return this.reject(error("INVALID_TRANSITION", "unrevised downstream work item must preserve its complete contract: " + source.id));
			if (previous && replannable) for (const obligationId of previous.obligationIds) {
				const obligation = next.obligations[obligationId];
				if (obligation?.status === "met") obligation.status = "open";
			}
			const contract = normalizedWorkItemContract(source);
			all[source.id] = {
				...contract,
				nativeTaskId: previous?.nativeTaskId,
				status: "held",
				attempt: previous?.attempt ?? 0,
				failureFingerprints: clone(previous?.failureFingerprints ?? {})
			};
		}
		if (!this.off("dependency")) {
			for (const item of Object.values(all)) for (const dependency of item.dependencies) if (!all[dependency]) return this.reject(error("DEPENDENCY_NOT_ACCEPTED", "unknown dependency", {
				itemId: item.id,
				dependency
			}));
			const visiting = /* @__PURE__ */ new Set();
			const visited = /* @__PURE__ */ new Set();
			const visit = (id) => {
				if (visiting.has(id)) return true;
				if (visited.has(id)) return false;
				visiting.add(id);
				for (const dependency of all[id].dependencies) if (visit(dependency)) return true;
				visiting.delete(id);
				visited.add(id);
				return false;
			};
			for (const id of Object.keys(all)) if (visit(id)) return this.reject(error("DEPENDENCY_CYCLE", "dependency cycle includes " + id));
		}
		const reaches = (from, target, seen = /* @__PURE__ */ new Set()) => {
			if (seen.has(from)) return false;
			seen.add(from);
			for (const dependency of all[from]?.dependencies ?? []) if (dependency === target || reaches(dependency, target, seen)) return true;
			return false;
		};
		if (!this.off("writeScope")) {
			const items = Object.values(all).filter((item) => item.status !== "accepted" && item.status !== "superseded");
			for (let left = 0; left < items.length; left += 1) for (let right = left + 1; right < items.length; right += 1) {
				const a = items[left];
				const b = items[right];
				if (reaches(a.id, b.id) || reaches(b.id, a.id)) continue;
				for (const scopeA of a.writeScopes) for (const scopeB of b.writeScopes) if (scopeOverlap(scopeA, scopeB)) return this.reject(error("WRITE_SCOPE_OVERLAP", "parallel work items have overlapping write scopes", {
					leftItem: a.id,
					rightItem: b.id,
					leftScope: scopeA,
					rightScope: scopeB
				}));
			}
		}
		const planned = [];
		for (const source of input.items) {
			const item = all[source.id];
			item.status = item.dependencies.every((id) => next.workItems[id]?.status === "accepted") ? "ready" : "held";
			next.workItems[item.id] = item;
			planned.push(item);
		}
		const mandatoryByItem = {};
		for (const item of planned) mandatoryByItem[item.id] = item.mandatory;
		return this.commit(next, "work.planned", "lead", {
			itemIds: planned.map((item) => item.id),
			mandatoryByItem
		}, planned);
	}
	prepareMandate(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		const item = state.workItems[input.workItemId];
		if (!item) return this.reject(error("ITEM_NOT_FOUND", "work item does not exist"));
		if (!this.off("failureBudget")) {
			if (item.attempt >= state.run.gatePolicy.maxAttempts) return this.reject(error("MAX_ATTEMPTS", "work item attempt budget exhausted"));
			if (Object.values(item.failureFingerprints).some((count) => count >= state.run.gatePolicy.maxSameFingerprint)) return this.reject(error("REPEATED_FAILURE", "repeated failure fingerprint budget exhausted"));
		}
		if (!(item.status === "ready" || item.status === "rework" || this.off("failureBudget") && item.status === "blocked")) return this.reject(error("INVALID_TRANSITION", "mandate requires ready/rework work item"));
		if (!this.off("dependency") && !item.dependencies.every((id) => state.workItems[id]?.status === "accepted")) return this.reject(error("DEPENDENCY_NOT_ACCEPTED", "all dependencies must be accepted"));
		if (!this.off("actor") && input.workerId === input.reviewerId) return this.reject(error("REVIEWER_SAME_AS_WORKER", "worker and reviewer must be different identities"));
		if (!Array.isArray(input.knownFailures)) return this.reject(error("INVALID_INPUT", "knownFailures must be a string array"));
		if (!textValid(input.workerId) || !textValid(input.reviewerId) || input.knownFailures.some((entry) => !textValid(entry))) return this.reject(error("INVALID_TRANSITION", "worker, reviewer and knownFailures must be bounded text"));
		const next = clone(state);
		const nextItem = next.workItems[item.id];
		const anchor = next.anchors[next.run.currentAnchorId];
		const modelPolicy = next.run.modelPolicy;
		if (modelPolicy?.mode === "locked" && (!modelPolicy.workerRoute || !modelPolicy.reviewerRoute)) return this.reject(error("ROUTE_NOT_ALLOWED", "locked policy requires explicit workerRoute and reviewerRoute"));
		const attempt = nextItem.attempt + 1;
		const mandateId = this.drivers.createId("mandate");
		const mandateText = [
			"Super Agent Mandate",
			"Objective: " + next.run.objective,
			"Definition of done: " + anchor.definitionOfDone,
			"Work item: " + nextItem.title,
			"Anchor version: " + anchor.version,
			"Attempt: " + attempt,
			"Worker: " + input.workerId,
			"Reviewer (read-only, native standard tool preset): " + input.reviewerId,
			"Worker route: " + this.routeKey(modelPolicy?.workerRoute ?? null),
			"Reviewer route: " + this.routeKey(modelPolicy?.reviewerRoute ?? null),
			"Route reason: " + (input.routeReason ?? "inherit current native model pool"),
			"Write scopes: " + (nextItem.writeScopes.join(", ") || "none"),
			"Acceptance: " + nextItem.acceptance.join(" | "),
			"Known failures: " + (input.knownFailures.join(" | ") || "none"),
			"Worker execution contract (六条执行契约):",
			"1. 不静默改道 / No silent rerouting: execute only the current Mandate and ACTION NOW; if blocked or superseded, stop and report instead of changing task, scope, or route.",
			"2. 读后再改 / Read before edit: inspect every target and its current content before editing; never overwrite an unread file.",
			"3. 写域不外扩 / Stay within write scopes: do not create, modify, format, generate, or delete anything outside writeScopes; declare generated artifacts explicitly.",
			"4. 歧义分级 / Grade ambiguity: resolve discoverable facts by inspection; ask the Lead about material ambiguity and record minor assumptions instead of hiding them.",
			"5. 按验收自验 / Verify against acceptance: run the required checks, preserve real receipts, and label unrun or unsupported checks unknown; green tests do not prove live delegation.",
			"6. 报告自带证据 / Report with evidence: include changed files, commands, receipts, artifacts, assumptions, failures, unfinished work, and risks; use kind/result/sourceActor/sourceRole for evidence receipts.",
			"Return: structured summary plus evidence receipts with kind/result/sourceActor/sourceRole; worker done is not acceptance."
		].join(String.fromCharCode(10));
		const mandate = {
			id: mandateId,
			workItemId: nextItem.id,
			anchorVersion: anchor.version,
			generation: next.run.generation,
			attempt,
			workerId: input.workerId,
			reviewerId: input.reviewerId,
			writeScopes: [...nextItem.writeScopes],
			acceptance: [...nextItem.acceptance],
			knownFailures: [...input.knownFailures],
			status: "prepared",
			needsStop: false,
			mandateText,
			workerRoute: clone(modelPolicy?.workerRoute ?? null),
			reviewerRoute: clone(modelPolicy?.reviewerRoute ?? null),
			routeReason: input.routeReason ?? "inherit current native model pool",
			policyRevision: modelPolicy?.revision ?? 0,
			routeSwitches: []
		};
		next.mandates[mandateId] = mandate;
		nextItem.currentMandateId = mandateId;
		nextItem.attempt = attempt;
		nextItem.status = "mandated";
		next.run.status = "active";
		return this.commit(next, "mandate.prepared", "lead", {
			mandateId,
			workItemId: nextItem.id,
			attempt
		}, mandate);
	}
	bindExecution(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		const mandate = state.mandates[input.mandateId];
		if (!mandate) return this.reject(error("MANDATE_REQUIRED", "mandate does not exist"));
		if (mandate.status !== "prepared") return this.reject(error("INVALID_TRANSITION", "only prepared mandate can bind execution"));
		if (!this.off("anchor") && mandate.anchorVersion !== state.anchors[state.run.currentAnchorId].version && state.workItems[mandate.workItemId].status === "superseded") return this.reject(error("ANCHOR_STALE", "mandate belongs to a superseded anchor"));
		if (!this.off("generation") && mandate.generation !== state.run.generation) return this.reject(error("STALE_GENERATION", "mandate belongs to an old generation"));
		if (!this.off("input") && (input.nativeTaskId !== void 0 && !textValid(input.nativeTaskId, 1e3) || input.workerAgentId !== void 0 && !textValid(input.workerAgentId, 1e3))) return this.reject(error("INVALID_TRANSITION", "native execution identifiers must be bounded non-empty text"));
		const next = clone(state);
		const bound = next.mandates[mandate.id];
		bound.nativeTaskId = input.nativeTaskId;
		bound.workerAgentId = input.workerAgentId;
		bound.status = "running";
		const item = next.workItems[bound.workItemId];
		item.nativeTaskId = input.nativeTaskId ?? item.nativeTaskId;
		item.status = "running";
		return this.commit(next, "execution.bound", "lead", {
			mandateId: bound.id,
			nativeTaskId: input.nativeTaskId ?? null,
			workerAgentId: input.workerAgentId ?? null
		}, bound);
	}
	bindReviewer(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		const mandate = state.mandates[input.mandateId];
		if (!mandate) return this.reject(error("MANDATE_REQUIRED", "mandate does not exist"));
		if (!this.off("reviewState") && mandate.status !== "reported_done") return this.reject(error("INVALID_TRANSITION", "reviewer binding requires worker reported_done"));
		if (!this.off("generation") && mandate.generation !== state.run.generation) return this.reject(error("STALE_GENERATION", "reviewer binding belongs to an old generation"));
		if (!this.off("input") && !textValid(input.reviewerAgentId, 1e3)) return this.reject(error("INVALID_TRANSITION", "reviewerAgentId must be bounded non-empty text"));
		const next = clone(state);
		next.mandates[mandate.id].reviewerAgentId = input.reviewerAgentId;
		return this.commit(next, "reviewer.bound", "lead", {
			mandateId: mandate.id,
			reviewerAgentId: input.reviewerAgentId
		}, next.mandates[mandate.id]);
	}
	reportWorkerDone(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		if (!textValid(input.summary)) return this.reject(error("INVALID_TRANSITION", "summary must be bounded non-empty text"));
		const mandate = state.mandates[input.mandateId];
		if (!mandate) return this.reject(error("MANDATE_REQUIRED", "mandate does not exist"));
		if (!this.off("actor") && mandate.workerId !== input.workerId) return this.reject(error("ACTOR_MISMATCH", "workerId does not match mandate"));
		if (!this.off("generation") && mandate.generation !== state.run.generation) return this.reject(error("STALE_GENERATION", "worker report belongs to an old mandate generation"));
		if (mandate.status !== "running") return this.reject(error("INVALID_TRANSITION", "worker done requires running mandate"));
		if (!this.off("anchor") && mandate.anchorVersion !== state.anchors[state.run.currentAnchorId].version && state.workItems[mandate.workItemId].status === "superseded") return this.reject(error("ANCHOR_STALE", "worker report belongs to a superseded anchor"));
		const next = clone(state);
		next.mandates[mandate.id].status = "reported_done";
		next.workItems[mandate.workItemId].status = "reported_done";
		return this.commit(next, "worker.reported_done", input.workerId, {
			mandateId: mandate.id,
			summary: input.summary
		}, next.mandates[mandate.id]);
	}
	recordEvidence(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		if (!Number.isInteger(input.attempt) || !textValid(input.workItemId) || !textValid(input.mandateId) || ![
			"build",
			"unit",
			"static",
			"simulated",
			"host_contract",
			"runtime_gui",
			"animation",
			"hover",
			"artifact",
			"source_hash",
			"build_hash",
			"loaded_hash",
			"host_receipt",
			"numeric_reconcile",
			"coverage",
			"user_feedback"
		].includes(String(input.kind)) || ![
			"pass",
			"fail",
			"unknown"
		].includes(String(input.result)) || ![
			"worker",
			"reviewer",
			"lead",
			"host",
			"user"
		].includes(String(input.sourceRole)) || input.summary !== void 0 && (typeof input.summary !== "string" || input.summary.length > 1e3)) return this.reject(error("INVALID_INPUT", "evidence fields, enums, attempt or summary are invalid"));
		const item = state.workItems[input.workItemId];
		const mandate = state.mandates[input.mandateId];
		if (!item) return this.reject(error("ITEM_NOT_FOUND", "work item does not exist"));
		if (!mandate || mandate.workItemId !== item.id) return this.reject(error("MANDATE_REQUIRED", "mandate does not match work item"));
		if (!this.off("evidenceFreshness") && (input.attempt !== item.attempt || input.attempt !== mandate.attempt)) return this.reject(error("MANDATE_STALE", "evidence attempt is not current"));
		if (!this.off("anchor") && mandate.anchorVersion !== state.anchors[state.run.currentAnchorId].version && (mandate.status === "superseded" || item.status === "superseded")) return this.reject(error("ANCHOR_STALE", "evidence mandate belongs to a superseded anchor"));
		if (!this.off("generation") && mandate.generation !== state.run.generation) return this.reject(error("STALE_GENERATION", "evidence mandate belongs to an old generation"));
		if (!this.off("input") && !textValid(input.sourceActor, 1e3)) return this.reject(error("INVALID_TRANSITION", "evidence sourceActor must be bounded non-empty text"));
		const receiptProblem = this.off("receipt") ? null : validateReceipt(input.receipt);
		if (receiptProblem) return this.reject(error("INVALID_TRANSITION", receiptProblem));
		const next = clone(state);
		const evidenceId = this.drivers.createId("evidence");
		const degraded = input.receipt.timeout === true || input.receipt.unreadable === true || input.receipt.malformed === true;
		const evidence = {
			id: evidenceId,
			workItemId: item.id,
			mandateId: mandate.id,
			attempt: input.attempt,
			anchorVersion: mandate.anchorVersion,
			generation: mandate.generation,
			kind: input.kind,
			result: degraded ? "unknown" : input.result,
			sourceActor: input.sourceActor,
			sourceRole: input.sourceRole,
			receipt: clone(input.receipt),
			summary: input.summary ?? "",
			createdAt: this.drivers.now()
		};
		next.evidence[evidenceId] = evidence;
		const violatedObligationId = receiptString(evidence, "obligationId");
		if (!this.off("prohibition") && evidence.receipt.violated === true && violatedObligationId) {
			const obligation = next.obligations[violatedObligationId];
			if (obligation?.kind === "prohibition" && obligation.status !== "waived" && obligation.status !== "superseded") obligation.status = "violated";
		}
		return this.commit(next, "evidence.recorded", input.sourceActor, {
			evidenceId,
			workItemId: item.id,
			kind: evidence.kind,
			result: evidence.result
		}, evidence);
	}
	evaluationError(evaluation) {
		return error(evaluation.reasons[0] ?? (evaluation.result === "unknown" ? "EVIDENCE_UNKNOWN" : "RUN_NOT_COMPLETABLE"), "gate did not pass", {
			result: evaluation.result,
			missingEvidence: evaluation.missingEvidence,
			violatedObligations: evaluation.violatedObligations,
			staleEvidence: evaluation.staleEvidence,
			reasons: evaluation.reasons
		});
	}
	submitReview(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		if (!Number.isInteger(input.attempt) || !textValid(input.reviewerId) || ![
			"pass",
			"fail",
			"unknown"
		].includes(String(input.result)) || !Array.isArray(input.evidenceIds) || !input.evidenceIds.every((id) => textValid(id, 1e3))) return this.reject(error("INVALID_INPUT", "review result, reviewer, attempt and evidenceIds are invalid"));
		const item = state.workItems[input.workItemId];
		const mandate = state.mandates[input.mandateId];
		if (!item) return this.reject(error("ITEM_NOT_FOUND", "work item does not exist"));
		if (!mandate || mandate.workItemId !== item.id || item.currentMandateId !== mandate.id) return this.reject(error("MANDATE_REQUIRED", "current mandate is required"));
		if (!this.off("generation") && mandate.generation !== state.run.generation) return this.reject(error("STALE_GENERATION", "review mandate belongs to an old generation"));
		if (!this.off("actor") && (input.reviewerId !== mandate.reviewerId || input.reviewerId === mandate.workerId)) return this.reject(error(input.reviewerId === mandate.workerId ? "REVIEWER_SAME_AS_WORKER" : "ACTOR_MISMATCH", "reviewer identity is not independent"));
		if (!this.off("evidenceFreshness") && (input.attempt !== item.attempt || input.attempt !== mandate.attempt)) return this.reject(error("MANDATE_STALE", "review attempt is not current"));
		if (!this.off("anchor") && mandate.anchorVersion !== state.anchors[state.run.currentAnchorId].version && (mandate.status === "superseded" || item.status === "superseded")) return this.reject(error("ANCHOR_STALE", "review mandate belongs to a superseded anchor"));
		if (!this.off("reviewState") && (item.status !== "reported_done" || mandate.status !== "reported_done")) return this.reject(error("INVALID_TRANSITION", "review requires the same current mandate in reported_done state"));
		const currentEvidence = Object.values(state.evidence).filter((entry) => entry.workItemId === item.id && entry.attempt === item.attempt && entry.anchorVersion === mandate.anchorVersion && entry.generation === state.run.generation);
		if (!this.off("reviewerReadonly") && currentEvidence.some((entry) => entry.sourceActor === input.reviewerId && isMutationReceipt(entry.receipt))) return this.reject(error("REVIEWER_NOT_READONLY", "reviewer has a write receipt for this attempt"));
		for (const id of input.evidenceIds) {
			const evidence = state.evidence[id];
			if (!evidence) return this.reject(error("EVIDENCE_MISSING", "review references unknown evidence: " + id));
			if (!this.off("evidenceFreshness") && (evidence.workItemId !== item.id || evidence.mandateId !== mandate.id)) return this.reject(error("EVIDENCE_MISSING", "review references evidence from another work item or mandate: " + id));
			if (!this.off("evidenceFreshness") && (evidence.attempt !== item.attempt || evidence.anchorVersion !== mandate.anchorVersion || evidence.generation !== state.run.generation)) return this.reject(error("EVIDENCE_STALE", "review references stale evidence: " + id));
		}
		let evaluation;
		if (input.result === "pass") {
			if (input.evidenceIds.length === 0) return this.reject(error("EVIDENCE_MISSING", "pass review must cite evidence"));
			evaluation = this.evaluateOn(state, item.id, input.evidenceIds);
			if (evaluation.result !== "pass") return this.reject(this.evaluationError(evaluation));
		}
		const next = clone(state);
		const decisionId = this.drivers.createId("decision");
		const decision = {
			id: decisionId,
			workItemId: item.id,
			mandateId: mandate.id,
			attempt: item.attempt,
			anchorVersion: mandate.anchorVersion,
			generation: state.run.generation,
			reviewerId: input.reviewerId,
			result: input.result,
			evidenceIds: [...input.evidenceIds],
			reasons: evaluation?.reasons ?? [],
			createdAt: this.drivers.now(),
			invalidated: false
		};
		next.decisions[decisionId] = decision;
		next.workItems[item.id].status = input.result === "fail" ? "rework" : "verifying";
		next.mandates[mandate.id].status = input.result === "fail" ? "superseded" : "verifying";
		return this.commit(next, "review.submitted", input.reviewerId, {
			decisionId,
			workItemId: item.id,
			result: input.result,
			reasons: decision.reasons
		}, decision);
	}
	evaluateGate(workItemId) {
		if (!this.state) return {
			workItemId,
			attempt: 0,
			result: "unknown",
			missingEvidence: [],
			violatedObligations: [],
			staleEvidence: [],
			reasons: ["RUN_NOT_FOUND"]
		};
		return this.evaluateOn(this.state, workItemId);
	}
	evaluateOn(state, workItemId, citedIds) {
		const item = state.workItems[workItemId];
		if (!item) return {
			workItemId,
			attempt: 0,
			result: "unknown",
			missingEvidence: [],
			violatedObligations: [],
			staleEvidence: [],
			reasons: ["ITEM_NOT_FOUND"]
		};
		const anchor = state.anchors[state.run.currentAnchorId];
		const mandate = item.currentMandateId ? state.mandates[item.currentMandateId] : void 0;
		const allForItem = Object.values(state.evidence).filter((entry) => entry.workItemId === item.id);
		const expectedAnchorVersion = mandate?.anchorVersion ?? anchor.version;
		const staleEvidence = allForItem.filter((entry) => entry.attempt !== item.attempt || entry.anchorVersion !== expectedAnchorVersion || entry.generation !== state.run.generation).map((entry) => entry.id);
		const current = allForItem.filter((entry) => !staleEvidence.includes(entry.id));
		const cited = citedIds ? current.filter((entry) => citedIds.includes(entry.id)) : current;
		const missingEvidence = [];
		const violatedObligations = [];
		const reasons = [];
		let failed = false;
		let unknown = false;
		const fail = (code) => {
			failed = true;
			reasons.push(code);
		};
		const markUnknown = (code) => {
			unknown = true;
			reasons.push(code);
		};
		if (!mandate) markUnknown("MANDATE_REQUIRED");
		else {
			if (!this.off("anchor") && mandate.anchorVersion !== anchor.version && (mandate.status === "superseded" || item.status === "superseded")) fail("ANCHOR_STALE");
			if (!this.off("evidenceFreshness") && mandate.attempt !== item.attempt) fail("MANDATE_STALE");
			if (!this.off("generation") && mandate.generation !== state.run.generation) fail("STALE_GENERATION");
		}
		if (!this.off("dependency") && !item.dependencies.every((id) => state.workItems[id]?.status === "accepted")) fail("DEPENDENCY_NOT_ACCEPTED");
		if (!this.off("reviewState") && current.some((entry) => entry.kind === "user_feedback" && entry.result === "fail")) fail("USER_REJECTED");
		const linkedObligations = item.obligationIds.map((id) => state.obligations[id]).filter((obligation) => obligation && anchor.obligationSnapshot.includes(obligation.id));
		if (!this.off("prohibition")) for (const obligationId of runProhibitionViolations(state)) {
			violatedObligations.push(obligationId);
			fail("PROHIBITION_VIOLATED");
		}
		const required = /* @__PURE__ */ new Set();
		if (item.gateProfile === "code" || item.gateProfile === "visual") {
			required.add("build");
			required.add("unit");
			if (item.hostContractRequired) required.add("host_contract");
			if (item.gateProfile === "visual") required.add("runtime_gui");
		} else if (item.gateProfile === "deployment") {
			required.add("source_hash");
			required.add("build_hash");
			required.add("loaded_hash");
			required.add("host_receipt");
		} else if (item.gateProfile === "numeric_reconcile") required.add("numeric_reconcile");
		if (!this.off("evidence")) {
			for (const obligation of linkedObligations) {
				for (const kind of obligation.requiredEvidence ?? []) required.add(kind);
				if (obligation.animation && !this.off("animation")) required.add("animation");
				if (obligation.requiredEvidence?.includes("hover")) required.add("hover");
			}
			for (const kind of required) {
				const evidence = latestByKind(cited, kind);
				if (!evidence) {
					missingEvidence.push(kind);
					markUnknown(kind === "host_contract" ? "HOST_CONTRACT_UNKNOWN" : "EVIDENCE_MISSING");
					continue;
				}
				if (evidence.result === "fail") fail("EVIDENCE_FAIL");
				else if (evidence.result === "unknown") markUnknown("EVIDENCE_UNKNOWN");
				if (!this.off("actor") && mandate && !independentEvidenceSource(mandate, evidence)) fail("ACTOR_MISMATCH");
				if (kind === "build") {
					const exitCode = receiptNumber(evidence, "exitCode");
					if (exitCode === void 0) markUnknown("EVIDENCE_UNKNOWN");
					else if (exitCode !== 0) fail("EVIDENCE_FAIL");
				}
				if (kind === "unit") {
					const passed = receiptNumber(evidence, "passed");
					const failedUnits = receiptNumber(evidence, "failed");
					const total = receiptNumber(evidence, "total");
					if (passed === void 0 || failedUnits === void 0 || !Number.isInteger(passed) || !Number.isInteger(failedUnits) || passed < 0 || failedUnits < 0) markUnknown("EVIDENCE_UNKNOWN");
					else if (failedUnits !== 0 || total !== void 0 && total !== passed + failedUnits) fail("EVIDENCE_FAIL");
					else if (evidence.result === "pass" && passed === 0) markUnknown("EVIDENCE_UNKNOWN");
				}
				if (kind === "host_contract" && !this.off("hostProjection")) {
					if ((receiptNumber(evidence, "activityCount") ?? 0) > 0 && receiptString(evidence, "emptyReason") === "no_activity") fail("HOST_CONTRACT_UNKNOWN");
				}
			}
		}
		if (!this.off("animation")) for (const obligation of linkedObligations.filter((entry) => entry.animation && entry.status !== "waived")) {
			const evidence = latestByKind(cited, "animation");
			if (!evidence) {
				if (!missingEvidence.includes("animation")) missingEvidence.push("animation");
				markUnknown("OBLIGATION_OPEN");
			} else if (receiptString(evidence, "mode") !== obligation.animation || receiptString(evidence, "obligationId") !== obligation.id) fail("OBLIGATION_OPEN");
		}
		if (item.gateProfile === "deployment" && !this.off("evidence")) {
			const source = latestByKind(cited, "source_hash");
			const build = latestByKind(cited, "build_hash");
			const loaded = latestByKind(cited, "loaded_hash");
			const host = latestByKind(cited, "host_receipt");
			if (!this.off("deploymentHash") && source?.result === "pass" && build?.result === "pass" && loaded?.result === "pass") {
				const sourceHash = receiptString(source, "hash");
				const buildHash = receiptString(build, "hash");
				const loadedHash = receiptString(loaded, "hash");
				if (!sourceHash || !buildHash || sourceHash !== buildHash) fail("SOURCE_ARTIFACT_MISMATCH");
				if (!loadedHash || loadedHash !== buildHash) fail("RUNTIME_HASH_MISMATCH");
			}
			if (host && !this.off("hostReceipt")) {
				const application = receiptString(host, "application");
				const restartReason = receiptString(host, "restartReason");
				if (application === "restart-required" || restartReason === "unmanaged-plugin" || restartReason === "unmanaged") fail("RESTART_REQUIRED");
				else if (host.result === "pass" && application !== "applied" && application !== "loaded" && host.receipt.deployed !== true) markUnknown("HOST_CONTRACT_UNKNOWN");
			}
		}
		if (item.gateProfile === "numeric_reconcile" && !this.off("evidence")) {
			const numeric = latestByKind(cited, "numeric_reconcile");
			if (numeric) {
				const left = receiptNumber(numeric, "leftValue");
				const right = receiptNumber(numeric, "rightValue");
				const leftScope = receiptString(numeric, "leftScope");
				const rightScope = receiptString(numeric, "rightScope");
				if (left === void 0 || right === void 0 || !leftScope || !rightScope) markUnknown("EVIDENCE_UNKNOWN");
				else if (leftScope !== rightScope) markUnknown("EVIDENCE_UNKNOWN");
				else if (left !== right) fail("EVIDENCE_FAIL");
				const declaredDelta = receiptNumber(numeric, "delta");
				if (declaredDelta !== void 0 && left !== void 0 && right !== void 0 && declaredDelta !== right - left) fail("EVIDENCE_FAIL");
			}
		}
		if (item.gateProfile === "coverage" && !this.off("coverage")) for (const obligation of linkedObligations.filter((entry) => entry.kind === "coverage")) {
			if (obligation.status === "waived") continue;
			const candidates = cited.filter((entry) => entry.kind === "coverage" && coverageMatches(entry, obligation));
			const evidence = candidates[candidates.length - 1];
			if (!evidence) {
				missingEvidence.push("coverage:" + obligation.id);
				markUnknown("COVERAGE_INCOMPLETE");
				continue;
			}
			const fromObservedHost = evidence.sourceRole === "host" && evidence.receipt.hostObserved === true;
			if (!this.off("actor") && (!independentEvidenceSource(mandate, evidence) || obligation.verification === "mandate_delivery" && !fromObservedHost)) fail("ACTOR_MISMATCH");
			if (receiptString(evidence, "verification") !== obligation.verification) fail("EVIDENCE_VERIFICATION_MISMATCH");
			const coverage = receiptString(evidence, "coverage");
			if (evidence.result === "fail" || coverage === "partial" || coverage === "substitute") fail("COVERAGE_INCOMPLETE");
			else if (evidence.result === "unknown" || coverage === "unknown" || coverage !== "full") markUnknown("COVERAGE_INCOMPLETE");
		}
		return {
			workItemId,
			attempt: item.attempt,
			result: failed ? "fail" : unknown ? "unknown" : "pass",
			missingEvidence: unique(missingEvidence),
			violatedObligations: unique(violatedObligations),
			staleEvidence: unique(staleEvidence),
			reasons: unique(reasons)
		};
	}
	releaseWorkItem(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		const item = state.workItems[input.workItemId];
		if (!item) return this.reject(error("ITEM_NOT_FOUND", "work item does not exist"));
		const mandate = item.currentMandateId ? state.mandates[item.currentMandateId] : void 0;
		if (!mandate) return this.reject(error("MANDATE_REQUIRED", "release requires current mandate"));
		if (!this.off("actor") && (input.reviewerId !== mandate.reviewerId || input.reviewerId === mandate.workerId)) return this.reject(error("ACTOR_MISMATCH", "release reviewer is not the independent mandate reviewer"));
		if (!this.off("reviewState") && (item.status !== "verifying" || mandate.status !== "verifying")) return this.reject(error("INVALID_TRANSITION", "release requires the same current mandate in verifying state"));
		if (!this.off("generation") && mandate.generation !== state.run.generation) return this.reject(error("STALE_GENERATION", "release mandate belongs to an old generation"));
		const decisions = Object.values(state.decisions).filter((decision) => decision.workItemId === item.id && decision.mandateId === mandate.id && decision.reviewerId === input.reviewerId && !decision.invalidated);
		const decision = decisions[decisions.length - 1];
		if (!decision || decision.result !== "pass") return this.reject(error("EVIDENCE_MISSING", "release requires a passing review decision"));
		if (!this.off("evidenceFreshness") && (decision.attempt !== item.attempt || decision.anchorVersion !== mandate.anchorVersion || decision.generation !== state.run.generation)) return this.reject(error("EVIDENCE_STALE", "passing decision is stale"));
		if (!this.off("reviewState") && !hasWorkerDoneProof(state, mandate)) return this.reject(error("INVALID_TRANSITION", "release lacks the current worker reported_done audit precursor"));
		const reviewerWrite = Object.values(state.evidence).some((entry) => entry.workItemId === item.id && entry.attempt === item.attempt && entry.anchorVersion === mandate.anchorVersion && entry.generation === state.run.generation && entry.sourceActor === input.reviewerId && isMutationReceipt(entry.receipt));
		if (!this.off("reviewerReadonly") && reviewerWrite) return this.reject(error("REVIEWER_NOT_READONLY", "reviewer write receipt invalidates release"));
		const evaluation = this.evaluateOn(state, item.id);
		if (evaluation.result !== "pass") return this.reject(this.evaluationError(evaluation));
		const next = clone(state);
		const accepted = next.workItems[item.id];
		accepted.status = "accepted";
		next.mandates[mandate.id].status = "accepted";
		const currentEvidence = Object.values(next.evidence).filter((entry) => entry.workItemId === item.id && entry.attempt === item.attempt && entry.anchorVersion === decision.anchorVersion && entry.generation === next.run.generation);
		for (const obligationId of accepted.obligationIds) {
			const obligation = next.obligations[obligationId];
			if (!obligation || obligation.status === "waived" || obligation.status === "superseded") continue;
			if (obligation.kind === "coverage") {
				if (currentEvidence.some((entry) => {
					if (entry.kind !== "coverage" || entry.result !== "pass" || receiptString(entry, "coverage") !== "full" || !coverageMatches(entry, obligation) || receiptString(entry, "verification") !== obligation.verification) return false;
					if (this.off("actor")) return true;
					if (obligation.verification === "mandate_delivery") return entry.sourceRole === "host" && entry.receipt.hostObserved === true;
					return independentEvidenceSource(mandate, entry);
				}) || this.off("coverage")) obligation.status = "met";
			} else obligation.status = "met";
			obligation.evidenceIds = unique([...obligation.evidenceIds, ...currentEvidence.filter((entry) => entry.result === "pass").map((entry) => entry.id)]);
		}
		for (const successor of Object.values(next.workItems)) if (successor.status === "held" && successor.dependencies.includes(item.id) && successor.dependencies.every((id) => next.workItems[id]?.status === "accepted")) successor.status = "ready";
		return this.commit(next, "work.released", input.reviewerId, {
			workItemId: item.id,
			decisionId: decision.id,
			unlockedItemIds: Object.values(next.workItems).filter((entry) => entry.status === "ready" && entry.dependencies.includes(item.id)).map((entry) => entry.id)
		}, accepted);
	}
	recordUserFeedback(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input) ?? this.mutable();
		if (guard) return this.reject(guard);
		if (!["accepted", "rejected"].includes(String(input.verdict)) || input.note !== void 0 && !textValid(input.note)) return this.reject(error("INVALID_INPUT", "feedback verdict or note is invalid"));
		const item = state.workItems[input.workItemId];
		if (!item) return this.reject(error("ITEM_NOT_FOUND", "work item does not exist"));
		if (input.instructionId !== void 0 && !textValid(input.instructionId, 1e3)) return this.reject(error("INVALID_TRANSITION", "instructionId must be bounded non-empty text"));
		const originalMandate = item.currentMandateId ? state.mandates[item.currentMandateId] : void 0;
		if (input.verdict === "rejected" && originalMandate && item.status !== "accepted" && !this.off("generation") && originalMandate.generation !== state.run.generation) return this.reject(error("STALE_GENERATION", "feedback mandate belongs to an old generation"));
		const next = clone(state);
		const nextItem = next.workItems[item.id];
		if (input.verdict === "accepted") return this.commit(next, "feedback.accepted", "user", {
			workItemId: item.id,
			instructionId: input.instructionId ?? null
		}, nextItem);
		const fingerprint = input.fingerprint ?? input.note ?? "";
		if (!textValid(fingerprint)) return this.reject(error("INVALID_TRANSITION", "rejected feedback requires a failure fingerprint"));
		for (const decision of Object.values(next.decisions)) if (decision.workItemId === item.id && decision.attempt === nextItem.attempt) decision.invalidated = true;
		const evidenceId = this.drivers.createId("evidence");
		const mandate = nextItem.currentMandateId ? next.mandates[nextItem.currentMandateId] : void 0;
		if (mandate) {
			mandate.needsStop = mandate.status === "running";
			mandate.status = "superseded";
			next.evidence[evidenceId] = {
				id: evidenceId,
				workItemId: item.id,
				mandateId: mandate.id,
				attempt: nextItem.attempt,
				anchorVersion: mandate.anchorVersion,
				generation: mandate.generation,
				kind: "user_feedback",
				result: "fail",
				sourceActor: "user",
				sourceRole: "user",
				receipt: {
					fingerprint,
					rejected: true
				},
				summary: input.note ?? "",
				createdAt: this.drivers.now()
			};
		}
		nextItem.failureFingerprints[fingerprint] = (nextItem.failureFingerprints[fingerprint] ?? 0) + 1;
		const repeated = nextItem.failureFingerprints[fingerprint] >= next.run.gatePolicy.maxSameFingerprint;
		if (!this.off("failureBudget") && (repeated || nextItem.attempt >= next.run.gatePolicy.maxAttempts)) {
			nextItem.status = "blocked";
			next.run.status = "blocked";
		} else {
			nextItem.status = "rework";
			next.run.status = "active";
		}
		const revoked = /* @__PURE__ */ new Set([item.id]);
		if (!this.off("dependency")) {
			let expanded = true;
			while (expanded) {
				expanded = false;
				for (const successor of Object.values(next.workItems)) if (!revoked.has(successor.id) && successor.dependencies.some((id) => revoked.has(id))) {
					revoked.add(successor.id);
					expanded = true;
				}
			}
		}
		const affectedObligations = /* @__PURE__ */ new Set();
		for (const revokedId of revoked) {
			const revokedItem = next.workItems[revokedId];
			if (revokedId !== item.id) revokedItem.status = "superseded";
			for (const obligationId of revokedItem.obligationIds) affectedObligations.add(obligationId);
			for (const decision of Object.values(next.decisions)) if (decision.workItemId === revokedId) decision.invalidated = true;
			for (const affectedMandate of Object.values(next.mandates)) if (affectedMandate.workItemId === revokedId && affectedMandate.status !== "superseded") {
				affectedMandate.needsStop = affectedMandate.status === "running";
				affectedMandate.status = "superseded";
			}
		}
		for (const obligationId of affectedObligations) {
			const obligation = next.obligations[obligationId];
			if (obligation?.status === "met") obligation.status = "open";
		}
		return this.commit(next, "feedback.rejected", "user", {
			workItemId: item.id,
			fingerprint,
			count: nextItem.failureFingerprints[fingerprint],
			status: nextItem.status,
			affectedWorkItemIds: [...revoked],
			reopenedObligationIds: [...affectedObligations]
		}, nextItem);
	}
	completeRun(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input);
		if (guard) return this.reject(guard);
		if (state.run.status !== "active") return this.reject(error("RUN_NOT_COMPLETABLE", "only active run can complete"));
		const active = state.anchors[state.run.currentAnchorId].obligationSnapshot.map((id) => state.obligations[id]);
		if (!this.off("completion")) {
			const prohibitionViolations = this.off("prohibition") ? [] : runProhibitionViolations(state);
			if (prohibitionViolations.length > 0) return this.reject(error("PROHIBITION_VIOLATED", "run-level prohibition violation blocks completion", { obligationIds: prohibitionViolations }));
			const incompleteCoverage = active.filter((obligation) => obligation.kind === "coverage" && obligation.status !== "met" && obligation.status !== "waived");
			if (!this.off("coverage") && incompleteCoverage.length > 0) return this.reject(error("COVERAGE_INCOMPLETE", "mandatory coverage is incomplete", { obligationIds: incompleteCoverage.map((entry) => entry.id) }));
			const open = active.filter((obligation) => obligation.status !== "met" && obligation.status !== "waived" && (obligation.kind !== "coverage" || !this.off("coverage")));
			if (open.length > 0) return this.reject(error("OPEN_OBLIGATIONS", "unwaived obligations remain open", { obligationIds: open.map((entry) => entry.id) }));
			const unaccepted = Object.values(state.workItems).filter((item) => item.mandatory && item.status !== "accepted");
			if (unaccepted.length > 0) return this.reject(error("UNACCEPTED_ITEMS", "mandatory work items are not accepted", { itemIds: unaccepted.map((entry) => entry.id) }));
			for (const item of Object.values(state.workItems).filter((entry) => entry.mandatory)) {
				const mandate = item.currentMandateId ? state.mandates[item.currentMandateId] : void 0;
				const historical = item.status === "accepted" && mandate && mandate.generation !== state.run.generation;
				const evaluationState = historical && mandate ? clone(state) : state;
				if (historical && mandate) evaluationState.run.generation = mandate.generation;
				const evaluation = this.evaluateOn(evaluationState, item.id);
				if (evaluation.result === "unknown") return this.reject(error("GATE_UNKNOWN", "a mandatory item gate remains unknown", { itemId: item.id }));
				if (evaluation.result === "fail") return this.reject(error("RUN_NOT_COMPLETABLE", "a mandatory item gate fails", { itemId: item.id }));
			}
		}
		const next = clone(state);
		next.run.status = "completed";
		return this.commit(next, "run.completed", "lead", {}, next.run);
	}
	pauseRun(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input);
		if (guard) return this.reject(guard);
		if (state.run.status !== "active" && state.run.status !== "blocked" && state.run.status !== "needs_user") return this.reject(error("INVALID_TRANSITION", "run cannot be paused from " + state.run.status));
		const next = clone(state);
		next.run.status = "paused";
		return this.commit(next, "run.paused", "user", {}, next.run);
	}
	resumeRun(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input);
		if (guard) return this.reject(guard);
		if (state.run.status !== "paused") return this.reject(error("INVALID_TRANSITION", "only paused run can resume"));
		const next = clone(state);
		next.run.status = "active";
		return this.commit(next, "run.resumed", "user", {}, next.run);
	}
	reconcileRecovery(input) {
		const state = this.state;
		if (!state) return this.reject(error("RUN_NOT_FOUND", "run does not exist"));
		const guard = this.guard(input);
		if (guard) return this.reject(guard);
		if (state.run.status === "completed") return this.reject(error("INVALID_TRANSITION", "completed run cannot recover"));
		if (!Array.isArray(input.nativeReceipts) || input.nativeReceipts.some((receipt) => !isRecord(receipt) || !textValid(receipt.mandateId, 1e3) || ![
			"running",
			"reported_done",
			"unknown",
			"failed"
		].includes(String(receipt.status)))) return this.reject(error("INVALID_INPUT", "nativeReceipts must be an array of valid recovery receipts"));
		const next = clone(state);
		next.run.generation += 1;
		const receipts = new Map(input.nativeReceipts.map((receipt) => [receipt.mandateId, receipt]));
		const unknownMandateIds = [];
		const nativeReportedDoneMandateIds = [];
		for (const mandate of Object.values(next.mandates)) {
			if (mandate.status !== "running") continue;
			const receipt = receipts.get(mandate.id);
			const item = next.workItems[mandate.workItemId];
			if (!receipt || receipt.status === "unknown" || receipt.status === "failed") {
				mandate.status = "unknown";
				mandate.needsStop = false;
				item.status = "verifying";
				unknownMandateIds.push(mandate.id);
			} else if (receipt.status === "reported_done") {
				const recovery = this.createRecoveryReviewMandate(next, mandate);
				nativeReportedDoneMandateIds.push(recovery.id);
			}
		}
		if (next.run.status === "paused") next.run.status = "active";
		const value = {
			...next.run,
			unknownMandateIds
		};
		return this.commit(next, "run.recovered", "host", {
			previousGeneration: state.run.generation,
			generation: next.run.generation,
			unknownMandateIds,
			nativeReportedDoneMandateIds
		}, value);
	}
};
// src/host/digest.ts
/** Canonical JSON matching the durable JSON boundary: optional undefined object fields are omitted. */
function canonicalSnapshotJson(value) {
	const seen = /* @__PURE__ */ new Set();
	const visit = (entry) => {
		if (entry === void 0) return void 0;
		if (entry === null || typeof entry === "string" || typeof entry === "boolean") return JSON.stringify(entry);
		if (typeof entry === "number") {
			if (!Number.isFinite(entry)) throw new TypeError("snapshot contains a non-finite number");
			return JSON.stringify(Object.is(entry, -0) ? 0 : entry);
		}
		if (typeof entry !== "object") throw new TypeError("snapshot contains a non-JSON value");
		const object = entry;
		if (seen.has(object)) throw new TypeError("snapshot contains a circular reference");
		seen.add(object);
		try {
			if (Array.isArray(entry)) return "[" + entry.map((item) => {
				const encoded = visit(item);
				if (encoded === void 0) throw new TypeError("snapshot array contains undefined");
				return encoded;
			}).join(",") + "]";
			const prototype = Object.getPrototypeOf(entry);
			if (prototype !== Object.prototype && prototype !== null) throw new TypeError("snapshot contains an exotic object");
			const parts = [];
			for (const [key, child] of Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
				const encoded = visit(child);
				if (encoded !== void 0) parts.push(JSON.stringify(key) + ":" + encoded);
			}
			return "{" + parts.join(",") + "}";
		} finally {
			seen.delete(object);
		}
	};
	const encoded = visit(value);
	if (encoded === void 0) throw new TypeError("snapshot root is undefined");
	return encoded;
}
function snapshotDigest(snapshot) {
	return createHash("sha256").update(canonicalSnapshotJson(snapshot), "utf8").digest("hex");
}
function withoutModelPolicy(state) {
	const { modelPolicy: _currentPolicy, ...run } = state.run;
	const audit = state.audit.map((event) => {
		if (!event.changes.run) return event;
		const { modelPolicy: _afterPolicy, ...runAfter } = event.changes.run;
		return {
			...event,
			changes: {
				...event.changes,
				run: runAfter
			}
		};
	});
	return {
		...state,
		run,
		audit
	};
}
function withoutEmptyRouteFailures(state) {
	const { routeFailures: _routes, ...rest } = state;
	const audit = state.audit.map((event) => {
		const changes = event.changes.routeFailures;
		if (!changes || Object.keys(changes).length > 0) return event;
		const { routeFailures: _changes, ...remaining } = event.changes;
		return {
			...event,
			changes: remaining
		};
	});
	return {
		...rest,
		audit
	};
}
/** Known v2 proof shapes differ only by routing fields' absence versus semantic defaults. */
function snapshotVariantsForProof(state) {
	const normalized = normalizeSnapshotForStorage(state);
	const withoutPolicy = withoutModelPolicy(normalized);
	const candidates = [
		normalized,
		withoutPolicy,
		withoutEmptyRouteFailures(withoutPolicy),
		withoutEmptyRouteFailures(normalized)
	];
	const unique = /* @__PURE__ */ new Map();
	for (const candidate of candidates) unique.set(canonicalSnapshotJson(candidate), candidate);
	return [...unique.values()];
}
function snapshotMatchingProof(state, proof, digest = snapshotDigest) {
	return snapshotVariantsForProof(state).find((candidate) => digest(candidate) === proof.snapshotSha256);
}
function normalizeSnapshotForStorage(state) {
	const normalized = structuredClone(state);
	normalized.routeFailures ??= {};
	normalized.run.modelPolicy ??= null;
	for (const event of normalized.audit) if (event.changes.run) event.changes.run.modelPolicy ??= null;
	return normalized;
}
// src/host/store.ts
const hostDrivers = {
	createId: (kind) => `${kind}_${randomUUID()}`,
	now: () => (/* @__PURE__ */ new Date()).toISOString(),
	digestSnapshot: snapshotDigest
};
function copy(value) {
	return structuredClone(value);
}
/** Durable snapshots are authoritative; core instances are disposable write engines. */
var RunRepository = class {
	cores = /* @__PURE__ */ new Map();
	queues = /* @__PURE__ */ new Map();
	quarantined = /* @__PURE__ */ new Map();
	table;
	drivers;
	recoveryReader;
	proofStore;
	constructor(table, drivers = hostDrivers, recoveryReader, proofStore) {
		this.table = table;
		this.drivers = drivers;
		this.recoveryReader = recoveryReader;
		this.proofStore = proofStore;
	}
	hasLiveCore(sessionId) {
		return this.cores.has(sessionId);
	}
	evaluate(sessionId) {
		const state = this.read(sessionId);
		if (!state) return [];
		const core = this.cores.get(sessionId);
		if (!core) return Object.values(state.workItems).map((item) => ({
			workItemId: item.id,
			attempt: item.attempt,
			result: "unknown",
			missingEvidence: [],
			violatedObligations: [],
			staleEvidence: [],
			reasons: ["CORE_RESTORE_UNAVAILABLE"]
		}));
		return Object.keys(state.workItems).map((id) => core.evaluateGate(id));
	}
	read(sessionId) {
		const record = this.table.get(sessionId);
		if (!record) return null;
		const parsed = record;
		if (parsed.state.run.sessionId !== sessionId) throw new HostError("SESSION_RUN_MISMATCH", "stored run does not belong to the requested root SessionId");
		return copy(parsed.state);
	}
	async persist(sessionId, state, recoveredAt) {
		state = normalizeSnapshotForStorage(state);
		let proof;
		try {
			if (!this.proofStore) throw new HostError("SNAPSHOT_PROOF_UNAVAILABLE", "no native SnapshotProof store is configured; storage/live state is not advanced");
			proof = await this.proofStore.append(sessionId, state);
		} catch (error) {
			this.cores.delete(sessionId);
			const message = error instanceof Error ? error.message : String(error);
			this.quarantined.set(sessionId, message);
			if (error instanceof HostError) throw error;
			throw new HostError("SNAPSHOT_PROOF_FAILED", "snapshot proof failed before storage commit", { cause: message });
		}
		try {
			await this.table.put(sessionId, copy({
				schemaVersion: 1,
				state,
				proof,
				...recoveredAt ? { recoveredAt } : {}
			}));
		} catch (error) {
			this.cores.delete(sessionId);
			const message = error instanceof Error ? error.message : String(error);
			this.quarantined.set(sessionId, message);
			throw new HostError("STORAGE_COMMIT_FAILED", "proof is durable but storage checkpoint failed; root is quarantined and the orphan proof is not a success receipt", { cause: message });
		}
	}
	async verifyProof(sessionId) {
		const record = this.table.get(sessionId);
		if (!record) throw new HostError("RUN_NOT_FOUND", "no stored run/proof exists for this root");
		this.read(sessionId);
		if (!this.proofStore) throw new HostError("SNAPSHOT_PROOF_UNAVAILABLE", "no native SnapshotProof reader is configured");
		return this.proofStore.verify(sessionId, record.state, record.proof);
	}
	provenSnapshot(state, proof) {
		const snapshot = snapshotMatchingProof(state, proof, this.drivers.digestSnapshot);
		if (!snapshot) throw new HostError("SNAPSHOT_PROOF_MISMATCH", "no known v2 snapshot shape matches the verified proof digest");
		return snapshot;
	}
	async coreForWrite(sessionId) {
		const quarantined = this.quarantined.get(sessionId);
		if (quarantined) throw new HostError("STORAGE_QUARANTINED", "root requires reload after an uncertain storage commit", { cause: quarantined });
		const live = this.cores.get(sessionId);
		if (live) return live;
		const existing = this.read(sessionId);
		if (!existing) return new SuperAgentCore(this.drivers);
		const core = new SuperAgentCore(this.drivers);
		if (typeof core.restoreSnapshot !== "function") throw new HostError("CORE_RESTORE_UNAVAILABLE", "stored snapshot is readable, but this core has no public restoreSnapshot; writes fail closed");
		const record = this.table.get(sessionId);
		if (!this.proofStore) throw new HostError("SNAPSHOT_PROOF_UNAVAILABLE", "stored snapshot cannot restore without native proof verification");
		const proof = await this.proofStore.verify(sessionId, existing, record.proof);
		const receipts = this.recoveryReader ? await this.recoveryReader(existing) : [];
		const restored = core.restoreSnapshot(this.provenSnapshot(existing, proof), receipts, proof);
		if (!restored.ok) throw new HostError(restored.error.code, restored.error.message, restored.error.details);
		if (restored.state.run.generation <= existing.run.generation) throw new HostError("CORE_RESTORE_CONTRACT_MISMATCH", "restoreSnapshot must advance generation during recovery; refusing an unrestored generation");
		await this.persist(sessionId, restored.state, this.drivers.now());
		this.cores.set(sessionId, core);
		return core;
	}
	async create(sessionId, input) {
		return this.write(sessionId, async () => {
			const quarantined = this.quarantined.get(sessionId);
			if (quarantined) throw new HostError("STORAGE_QUARANTINED", "root requires reload after an uncertain storage commit", { cause: quarantined });
			if (this.read(sessionId)) throw new HostError("INVALID_TRANSITION", "this root session already has a run");
			const core = new SuperAgentCore(this.drivers);
			const result = core.createRun({
				...input,
				sessionId
			});
			if (result.ok) {
				await this.persist(sessionId, result.state);
				this.cores.set(sessionId, core);
			}
			return result;
		});
	}
	/** Explicit quarantine recovery from the last natively proven storage record. */
	async recover(sessionId) {
		return this.write(sessionId, async () => {
			const hadQuarantine = this.quarantined.has(sessionId);
			try {
				const record = this.table.get(sessionId);
				if (!record && !hadQuarantine) return {
					ok: false,
					state: null,
					error: {
						code: "RUN_NOT_FOUND",
						message: "no stored run/proof exists; fresh root remains available for create"
					},
					events: []
				};
				this.cores.delete(sessionId);
				if (!record) throw new HostError("RUN_NOT_FOUND", "cannot recover without a stored snapshot/proof; existing quarantine is retained");
				const existing = this.read(sessionId);
				if (!this.proofStore) throw new HostError("SNAPSHOT_PROOF_UNAVAILABLE", "cannot recover without native proof verification; quarantine is retained");
				const proof = await this.proofStore.verify(sessionId, existing, record.proof);
				const receipts = this.recoveryReader ? await this.recoveryReader(existing) : [];
				const core = new SuperAgentCore(this.drivers);
				const restored = core.restoreSnapshot(this.provenSnapshot(existing, proof), receipts, proof);
				if (!restored.ok) {
					this.quarantined.set(sessionId, restored.error.message);
					return restored;
				}
				if (restored.state.run.generation <= existing.run.generation) throw new HostError("CORE_RESTORE_CONTRACT_MISMATCH", "recover must advance generation; quarantine is retained");
				await this.persist(sessionId, restored.state, this.drivers.now());
				this.cores.set(sessionId, core);
				this.quarantined.delete(sessionId);
				return restored;
			} catch (error) {
				this.cores.delete(sessionId);
				this.quarantined.set(sessionId, error instanceof Error ? error.message : String(error));
				throw error;
			}
		});
	}
	async transact(sessionId, operation) {
		return this.write(sessionId, async () => {
			const core = await this.coreForWrite(sessionId);
			this.cores.delete(sessionId);
			let result;
			try {
				result = operation(core);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.quarantined.set(sessionId, message);
				throw new HostError("OPERATION_FAILED", "operation threw outside CoreResult; live core remains quarantined", { cause: message });
			}
			if (result.ok) await this.persist(sessionId, result.state);
			if (!this.quarantined.has(sessionId)) this.cores.set(sessionId, core);
			return result;
		});
	}
	async write(sessionId, operation) {
		const result = (this.queues.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(operation);
		const tail = result.then(() => {}, () => {});
		this.queues.set(sessionId, tail);
		try {
			return await result;
		} finally {
			if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId);
		}
	}
};
// src/host/proof.ts
const SNAPSHOT_PROOF_RECORD = "plugin:dsh-super-agent-mode/proof";
function sameProof(left, right) {
	return left.runId === right.runId && left.snapshotSha256 === right.snapshotSha256 && left.revision === right.revision && left.generation === right.generation && left.nativeEventSeq === right.nativeEventSeq;
}
function errorCode(error) {
	return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : void 0;
}
/** Experimental native plugin-record seam confirmed for task-29. Proof loss is never treated as success. */
var NativeSnapshotProofStore = class {
	ctx;
	digest;
	constructor(ctx, digest = snapshotDigest) {
		this.ctx = ctx;
		this.digest = digest;
	}
	root(sessionId) {
		const agent = this.ctx.agents.get(sessionId);
		if (!agent) throw new HostError("SNAPSHOT_PROOF_UNAVAILABLE", "proof writer requires the exact live native root Agent");
		const root = this.ctx.subagents.rootOf(agent);
		if (root.id !== sessionId) throw new HostError("SESSION_NOT_ROOT", "proof records belong only to the native root Session");
		return root;
	}
	async append(sessionId, state) {
		const root = this.root(sessionId);
		const proof = {
			runId: state.run.id,
			snapshotSha256: this.digest(state),
			revision: state.run.revision,
			generation: state.run.generation,
			nativeEventSeq: Number(root.session.seq)
		};
		const validated = snapshotProofSchema.parse(proof);
		let seq;
		try {
			seq = Number(appendPluginRecord(root.session, SNAPSHOT_PROOF_RECORD, validated));
		} catch (error) {
			throw new HostError("SNAPSHOT_PROOF_WRITE_FAILED", "native snapshot proof append failed before storage commit", { cause: errorMessage(error) });
		}
		if (seq !== validated.nativeEventSeq) throw new HostError("SNAPSHOT_PROOF_WRITE_FAILED", "native proof seq changed at append; storage commit is refused", {
			expectedSeq: validated.nativeEventSeq,
			actualSeq: seq
		});
		let participated;
		try {
			participated = await this.ctx.sessions.flush(root.session);
		} catch (error) {
			throw new HostError("SNAPSHOT_PROOF_PERSISTENCE_UNCONFIRMED", "proof is visible but durability is unconfirmed; storage/live state is not advanced", { cause: errorMessage(error) });
		}
		if (!participated) throw new HostError("SNAPSHOT_PROOF_PERSISTENCE_UNCONFIRMED", "no Session durability listener confirmed the proof; storage/live state is not advanced");
		return this.verify(sessionId, state, validated);
	}
	async verify(sessionId, state, expected) {
		const proof = snapshotProofSchema.safeParse(expected);
		if (!proof.success) throw new HostError("SNAPSHOT_PROOF_MISMATCH", "stored proof does not match the SnapshotProof schema");
		if (state.run.sessionId !== sessionId) throw new HostError("SESSION_RUN_MISMATCH", "snapshot proof verification requires matching native root and Run sessionId");
		let event;
		try {
			const window = await this.ctx.sessionQuery.readEvent({
				sessionId,
				seq: proof.data.nativeEventSeq
			});
			if (window.session.id !== sessionId) throw new HostError("SESSION_RUN_MISMATCH", "proof readback returned a different native Session");
			event = window.target;
		} catch (error) {
			throw new HostError(errorCode(error) === "SESSION_QUERY_EVENT_NOT_FOUND" ? "SNAPSHOT_PROOF_REQUIRED" : "SNAPSHOT_PROOF_UNAVAILABLE", "native snapshot proof could not be read back; restore/commit fails closed", { cause: errorMessage(error) });
		}
		const record = pluginRecordOf(event);
		if (!record || record.type !== "plugin:dsh-super-agent-mode/proof") throw new HostError("SNAPSHOT_PROOF_REQUIRED", "the referenced native event is not a Super Agent snapshot proof");
		const actual = snapshotProofSchema.safeParse(record.data);
		if (!actual.success || actual.data.nativeEventSeq !== Number(record.seq) || !sameProof(actual.data, proof.data)) throw new HostError("SNAPSHOT_PROOF_MISMATCH", "native proof payload/seq differs from the stored checkpoint proof");
		if (actual.data.runId !== state.run.id || actual.data.revision !== state.run.revision || actual.data.generation !== state.run.generation || !snapshotMatchingProof(state, actual.data, this.digest)) throw new HostError("SNAPSHOT_PROOF_MISMATCH", "native proof does not match the canonical snapshot/run/revision/generation");
		return actual.data;
	}
};
const superAgentStorageSpec = defineDomain({
	name: "super_agent_mode",
	version: 1,
	layout: "single",
	tables: { runs: domainTable(storedRunRecordSchema) }
});
async function openRunRepository(ctx, recoveryReader) {
	const domain = await ctx.storageDomain.open(superAgentStorageSpec);
	ctx.effect(() => () => domain.close(), "super-agent:storage");
	return new RunRepository(domain.table("runs"), hostDrivers, recoveryReader, new NativeSnapshotProofStore(ctx));
}
// src/host/reviewer.ts
const REVIEWER_PRESET = "standard";
const REVIEWER_COMPOSITION_GUIDANCE = "Worker inherits super-agent; launch Reviewer as native standard with agent_preset=standard. A super-agent/PTC Reviewer is not accepted.";
/** Read the current Session projection, never the frozen creation header alone. */
async function readCurrentPreset(ctx, agent, signal) {
	let observation;
	try {
		observation = await ctx.sessionQuery.observeSession(agent.id, { ...signal ? { signal } : {} });
	} catch (error) {
		throw new HostError("REVIEWER_PRESET_UNAVAILABLE", "cannot read the current agentPreset projection", { cause: errorMessage(error) });
	}
	try {
		const values = observation.projections?.values;
		const preset = values !== null && typeof values === "object" && "agentPreset" in values ? values.agentPreset : void 0;
		return typeof preset === "string" && preset.length > 0 ? preset : null;
	} finally {
		observation[Symbol.dispose]();
	}
}
async function assertNativeStandardReviewer(ctx, agent, signal) {
	const preset = await readCurrentPreset(ctx, agent, signal);
	if (preset === "standard") return;
	if (preset === null) throw new HostError("REVIEWER_PRESET_UNKNOWN", "Reviewer current agentPreset projection is missing; launch with native agent_preset=standard");
	throw new HostError("REVIEWER_PRESET_REQUIRED", `Reviewer must run under native standard preset with agent_preset=standard; actual current preset is ${preset}. super-agent/PTC run_code is not a read-only Reviewer path.`, {
		actualPreset: preset,
		requiredPreset: REVIEWER_PRESET
	});
}
function isBoundReviewer(ctx, repository, agent) {
	try {
		const root = rootOf(ctx, agent);
		const state = repository.read(root.id);
		return Object.values(state?.workItems ?? {}).some((item) => {
			const mandate = item.currentMandateId ? state?.mandates[item.currentMandateId] : void 0;
			return mandate?.workItemId === item.id && mandate.attempt === item.attempt && mandate.generation === state?.run.generation && (mandate.status === "reported_done" || mandate.status === "verifying") && mandate.reviewerAgentId !== void 0 && mandate.reviewerAgentId === agent.id;
		});
	} catch {
		return false;
	}
}
/** Native dispatch/declaration gate: super-agent members or a proof-verified bound standard Reviewer only. */
async function canUseSuperTools(ctx, repository, agent, signal) {
	try {
		const preset = await readCurrentPreset(ctx, agent, signal);
		if (preset === "super-agent") return true;
		if (preset !== "standard" || !isBoundReviewer(ctx, repository, agent)) return false;
		const root = rootOf(ctx, agent);
		const before = repository.read(root.id);
		await repository.verifyProof(root.id);
		const after = repository.read(root.id);
		return before?.run.revision === after?.run.revision && before?.run.generation === after?.run.generation && isBoundReviewer(ctx, repository, agent);
	} catch {
		return false;
	}
}
/** PromptSection.text is synchronous; this registry method reads the same live agentPreset Session projection. */
function shouldRenderSuperPrompt(ctx, repository, agent) {
	try {
		const candidate = ctx.agentPresets;
		if (!candidate || typeof candidate !== "object" || !("presetForSession" in candidate) || typeof candidate.presetForSession !== "function") return false;
		const preset = candidate.presetForSession(agent.session);
		if (preset === "super-agent") return true;
		return preset === "standard" && isBoundReviewer(ctx, repository, agent);
	} catch {
		return false;
	}
}
// src/host/prompt.ts
function renderRunPrompt(state, gates) {
	if (!state) return "Super Agent: no Run exists for the current native root session. Use super_run create before planning or delegation; do not invent obligations or execution state. " + REVIEWER_COMPOSITION_GUIDANCE;
	const anchor = state.anchors[state.run.currentAnchorId];
	const active = new Set(anchor?.obligationSnapshot ?? []);
	const open = Object.values(state.obligations).filter((item) => active.has(item.id) && item.status === "open");
	return [
		`Super Agent Run ${state.run.id}: status=${state.run.status}, revision=${state.run.revision}, generation=${state.run.generation}.`,
		`Current anchor v${anchor?.version ?? "unknown"}: ${anchor?.latestInstruction ?? "missing"}`,
		`Definition of done: ${anchor?.definitionOfDone ?? state.run.definitionOfDone}`,
		"Open obligations: " + (open.length ? open.map((item) => `${item.id} [${item.kind}] ${item.text}`).join(" | ") : "none"),
		"Gates: " + (gates.length ? gates.map((gate) => `${gate.workItemId}#${gate.attempt}=${gate.result} (${gate.reasons.join(",") || "no reasons"})`).join(" | ") : "no work items"),
		REVIEWER_COMPOSITION_GUIDANCE,
		"Only the current root Run above is in scope. reported_done is not accepted; unknown/missing/stale evidence never releases a gate."
	].join("\n");
}
function registerSuperPrompt(ctx, repository) {
	return ctx.systemPrompt.section({
		name: "super-agent:current-run",
		order: ctx.systemPrompt.getSectionOrder("TEAM_POLICY") + 1,
		interpolate: false,
		text: (assembly) => {
			const scope = assembly.scope;
			const candidate = scope && typeof scope === "object" && "id" in scope ? scope : void 0;
			const agent = candidate?.id ? ctx.agents.get(candidate.id) ?? candidate : void 0;
			if (!agent) return "";
			try {
				if (!shouldRenderSuperPrompt(ctx, repository, agent)) return "";
				const root = ctx.subagents.rootOf(agent);
				return renderRunPrompt(repository.read(root.id), repository.evaluate(root.id));
			} catch {
				return "";
			}
		}
	});
}
// src/host/evidence.ts
const asRecord$1 = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
const nonEmpty = (value) => typeof value === "string" && value.length > 0 && value.length <= 2e3 ? value : void 0;
const bool = (value) => typeof value === "boolean" ? value : void 0;
function toolCallName(event) {
	const data = asRecord$1(event.data);
	if (event.type !== "tool/call" || !data) return {};
	return {
		callId: nonEmpty(data.callId),
		name: nonEmpty(data.name) ?? nonEmpty(data.toolName),
		arguments: data.arguments ?? data.args
	};
}
function targetCallId(event) {
	const data = asRecord$1(event.data);
	const message = asRecord$1(data?.message);
	const source = asRecord$1(message?.source);
	return nonEmpty(source?.callId) ?? nonEmpty(data?.callId);
}
function directToolName(event) {
	const data = asRecord$1(event.data);
	const message = asRecord$1(data?.message);
	const source = asRecord$1(message?.source);
	return nonEmpty(data?.name) ?? nonEmpty(data?.toolName) ?? nonEmpty(source?.name) ?? nonEmpty(source?.toolName);
}
function collectJsonCandidates(value, output, depth = 0) {
	if (depth > 7) return;
	const record = asRecord$1(value);
	if (record) {
		output.push(record);
		for (const [key, child] of Object.entries(record)) {
			if (key === "content" || key === "body" || key === "transcript") continue;
			collectJsonCandidates(child, output, depth + 1);
		}
		return;
	}
	if (Array.isArray(value)) for (const child of value.slice(0, 100)) collectJsonCandidates(child, output, depth + 1);
}
function collectArgumentCandidates(value, output) {
	if (typeof value === "string" && value.length <= 1e5) {
		try {
			collectJsonCandidates(JSON.parse(value), output);
		} catch {}
		return;
	}
	collectJsonCandidates(value, output);
}
function collectContentCandidates(content, output) {
	const blocks = Array.isArray(content) ? content.slice(0, 30) : [content];
	for (const block of blocks) {
		const text = typeof block === "string" ? block : asRecord$1(block)?.text;
		if (typeof text !== "string" || text.length > 1e5) continue;
		try {
			collectJsonCandidates(JSON.parse(text), output);
		} catch {}
	}
}
function first(candidates, keys, pick) {
	for (const candidate of candidates) for (const key of keys) {
		const value = pick(candidate[key]);
		if (value !== void 0) return value;
	}
}
/** Extract bounded facts from real Session events; raw content is parsed but never persisted. */
function extractNativeFacts(events, targetSeq) {
	const target = events.find((event) => event.seq === targetSeq);
	if (!target || typeof target.type !== "string") throw new HostError("EVIDENCE_EVENT_NOT_FOUND", "native event seq is not readable in the requested session");
	const data = asRecord$1(target.data);
	const message = asRecord$1(data?.message);
	const calls = /* @__PURE__ */ new Map();
	for (const event of events) {
		const call = toolCallName(event);
		if (call.callId) calls.set(call.callId, {
			name: call.name,
			arguments: call.arguments
		});
	}
	const callId = targetCallId(target);
	const call = callId ? calls.get(callId) : void 0;
	const toolName = directToolName(target) ?? call?.name;
	const candidates = [];
	collectJsonCandidates(data, candidates);
	if (call?.arguments !== void 0) collectArgumentCandidates(call.arguments, candidates);
	collectContentCandidates(message?.content, candidates);
	if (data?.content !== message?.content) collectContentCandidates(data?.content, candidates);
	const error = data?.error !== void 0 || message?.isError === true || data?.isError === true;
	const result = first(candidates, ["result"], (value) => value === "pass" || value === "fail" || value === "unknown" ? value : void 0);
	return {
		eventType: target.type,
		toolName,
		isError: error,
		exitCode: first(candidates, ["exitCode", "exit_code"], finite),
		passed: first(candidates, ["passed"], finite),
		failed: first(candidates, ["failed"], finite),
		total: first(candidates, ["total"], finite),
		hash: first(candidates, ["hash"], nonEmpty),
		sourceHash: first(candidates, ["sourceHash", "source_hash"], nonEmpty),
		buildHash: first(candidates, ["buildHash", "build_hash"], nonEmpty),
		loadedHash: first(candidates, ["loadedHash", "loaded_hash"], nonEmpty),
		result,
		coverage: first(candidates, ["coverage"], nonEmpty),
		obligationId: first(candidates, ["obligationId"], nonEmpty),
		sourceId: first(candidates, ["sourceId"], nonEmpty),
		operation: first(candidates, ["operation"], nonEmpty),
		activityCount: first(candidates, ["activityCount"], finite),
		emptyReason: first(candidates, ["emptyReason"], nonEmpty),
		restartRequired: first(candidates, ["restartRequired"], bool),
		deploymentStatus: first(candidates, ["deploymentStatus"], nonEmpty),
		mode: first(candidates, ["mode"], nonEmpty),
		action: first(candidates, ["action"], nonEmpty),
		verification: first(candidates, ["verification"], nonEmpty)
	};
}
function resultFromNativeFacts(kind, facts) {
	if (facts.isError || facts.result === "fail") return "fail";
	if (kind === "build") return facts.exitCode === 0 ? "pass" : facts.exitCode !== void 0 ? "fail" : "unknown";
	if (kind === "unit") {
		if (facts.failed === void 0 || facts.passed === void 0) return "unknown";
		if (facts.failed > 0 || facts.total !== void 0 && facts.total !== facts.passed + facts.failed) return "fail";
		return facts.failed === 0 ? "pass" : "unknown";
	}
	if (kind === "source_hash") return facts.sourceHash ?? facts.hash ? "pass" : "unknown";
	if (kind === "build_hash") return facts.buildHash ?? facts.hash ? "pass" : "unknown";
	if (kind === "loaded_hash") return facts.loadedHash ?? facts.hash ? "pass" : "unknown";
	if (kind === "coverage") {
		if (facts.coverage === "partial" || facts.coverage === "substitute") return "fail";
		if (facts.coverage !== "full" || !facts.obligationId && !facts.sourceId) return "unknown";
		return "pass";
	}
	return facts.result ?? (kind === "host_receipt" ? "pass" : "unknown");
}
function hostObservedReceipt(sessionId, seq, facts) {
	return {
		hostObserved: true,
		provenance: "host_observed",
		nativeAgentId: sessionId,
		eventSeq: seq,
		eventType: facts.eventType,
		...facts.toolName ? { toolName: facts.toolName } : {},
		isError: facts.isError,
		...facts.exitCode !== void 0 ? { exitCode: facts.exitCode } : {},
		...facts.passed !== void 0 ? { passed: facts.passed } : {},
		...facts.failed !== void 0 ? { failed: facts.failed } : {},
		...facts.total !== void 0 ? { total: facts.total } : {},
		...facts.hash ? { hash: facts.hash } : {},
		...facts.sourceHash ? { sourceHash: facts.sourceHash } : {},
		...facts.buildHash ? { buildHash: facts.buildHash } : {},
		...facts.loadedHash ? { loadedHash: facts.loadedHash } : {},
		...facts.coverage ? { coverage: facts.coverage } : {},
		...facts.obligationId ? { obligationId: facts.obligationId } : {},
		...facts.sourceId ? { sourceId: facts.sourceId } : {},
		...facts.operation ? { operation: facts.operation } : {},
		...facts.activityCount !== void 0 ? { activityCount: facts.activityCount } : {},
		...facts.emptyReason ? { emptyReason: facts.emptyReason } : {},
		...facts.restartRequired !== void 0 ? { restartRequired: facts.restartRequired } : {},
		...facts.deploymentStatus ? { deploymentStatus: facts.deploymentStatus } : {},
		...facts.mode ? { mode: facts.mode } : {}
	};
}
function eventSeq(event) {
	return typeof event.seq === "number" && Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : void 0;
}
function argumentRecord(value) {
	if (typeof value === "string" && value.length <= 1e5) try {
		return asRecord$1(JSON.parse(value));
	} catch {
		return;
	}
	return asRecord$1(value);
}
function successfulNativeResult(data) {
	const message = asRecord$1(data?.message);
	return data?.error === void 0 && data?.isError !== true && message?.isError !== true;
}
function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.slice(0, 100).map((block) => {
		const text = asRecord$1(block)?.text;
		return typeof text === "string" ? text : "";
	}).join("");
}
function agentMessageText(text) {
	const markerAt = text.indexOf(" sent a message: ");
	if (text.startsWith("Agent ") && markerAt > 6 && markerAt < 200) return text.slice(markerAt + 17);
	return text;
}
function currentMandateText(text, mandate, workerId) {
	if (text.includes(mandate.mandateText) || text.includes(mandate.id)) return true;
	return text.startsWith("Super Agent Mandate\n") && text.includes(`\nAttempt: ${mandate.attempt}\n`) && text.includes(`\nWorker: ${workerId}\n`);
}
function validDeliveryText(text, mandate) {
	for (const separator of ["\n\n", "\n"]) {
		const prefix = `${mandate.mandateText}${separator}ACTION NOW:`;
		if (!text.startsWith(prefix)) continue;
		const actionNow = text.slice(prefix.length);
		if (actionNow.trim().length > 0 && !/[\r\n]/u.test(actionNow)) return true;
	}
	return false;
}
/**
* Match the real Lead send_message call to the current Worker's durable inbound user/message.
* No raw Mandate text is returned or persisted by this verification path.
*/
function verifyMandateDelivery(input) {
	const { mandate, rootNativeAgentId, workerNativeAgentId, workerAddresses } = input;
	const leadSends = [];
	const ordinaryCalls = /* @__PURE__ */ new Map();
	for (const event of input.rootEvents) {
		if (event.type !== "tool/call") continue;
		const data = asRecord$1(event.data);
		const name = nonEmpty(data?.name) ?? nonEmpty(data?.toolName);
		const callId = nonEmpty(data?.callId);
		if (name === "send_message" && callId) ordinaryCalls.set(callId, { arguments: argumentRecord(data?.arguments ?? data?.args) });
	}
	const appendLeadSend = (eventType, seq, args, callId) => {
		leadSends.push({
			nativeAgentId: rootNativeAgentId,
			eventSeq: seq,
			eventType,
			...callId ? { callId } : {},
			target: typeof args?.agent === "string" ? args.agent : "",
			text: typeof args?.message === "string" ? args.message : ""
		});
	};
	for (const event of input.rootEvents) {
		const seq = eventSeq(event);
		if (seq === void 0) continue;
		const data = asRecord$1(event.data);
		const name = nonEmpty(data?.name) ?? nonEmpty(data?.toolName);
		if (event.type === "tool/ptc-dispatch") {
			if (name === "send_message" && data?.isError === false && data?.error === void 0) appendLeadSend(event.type, seq, argumentRecord(data?.arguments ?? data?.args), nonEmpty(data?.subCallId) ?? nonEmpty(data?.callId));
			continue;
		}
		if (event.type !== "tool/result" || !successfulNativeResult(data)) continue;
		const message = asRecord$1(data?.message);
		const source = asRecord$1(message?.source);
		const callId = nonEmpty(source?.callId) ?? nonEmpty(data?.callId);
		const call = callId ? ordinaryCalls.get(callId) : void 0;
		if (!callId || !call) continue;
		if ([
			data?.name,
			data?.toolName,
			source?.name,
			source?.toolName
		].map(nonEmpty).filter((value) => value !== void 0).some((resultName) => resultName !== "send_message")) continue;
		appendLeadSend(event.type, seq, argumentRecord(data?.arguments ?? data?.args) ?? call.arguments, callId);
	}
	const workerMessages = [];
	const appendWorkerMessage = (eventType, seq, message) => {
		if (!message) return;
		const source = asRecord$1(message.source);
		const messageId = nonEmpty(message.id);
		workerMessages.push({
			nativeAgentId: workerNativeAgentId,
			eventSeq: seq,
			eventType,
			...messageId ? { messageId } : {},
			senderId: nonEmpty(source?.senderSessionId),
			sourceKind: nonEmpty(source?.kind),
			text: agentMessageText(messageText(message.content))
		});
	};
	for (const event of input.workerEvents) {
		const seq = eventSeq(event);
		if (seq === void 0) continue;
		const data = asRecord$1(event.data);
		if (event.type === "agent/inbox/spliced") {
			const inserted = Array.isArray(data?.inserted) ? data.inserted : [];
			for (const entry of inserted) appendWorkerMessage(event.type, seq, asRecord$1(entry));
			continue;
		}
		if (event.type !== "user/message") continue;
		appendWorkerMessage(event.type, seq, asRecord$1(data?.message) ?? data);
	}
	const relevantLead = leadSends.filter((send) => currentMandateText(send.text, mandate, workerNativeAgentId) || validDeliveryText(send.text, mandate));
	const relevantWorker = workerMessages.filter((message) => currentMandateText(message.text, mandate, workerNativeAgentId) || validDeliveryText(message.text, mandate));
	const validLead = relevantLead.filter((send) => validDeliveryText(send.text, mandate));
	const validWorker = relevantWorker.filter((message) => validDeliveryText(message.text, mandate));
	let incomplete;
	for (const lead of validLead) {
		if (!workerAddresses.has(lead.target)) continue;
		for (const worker of validWorker) {
			if (worker.sourceKind !== "agent-message" || worker.senderId !== rootNativeAgentId || worker.text !== lead.text) continue;
			if (lead.callId && worker.messageId) return {
				result: "pass",
				reason: "mandate_delivery_verified",
				lead,
				worker
			};
			incomplete ??= {
				lead,
				worker
			};
		}
	}
	const wrongTarget = validLead.find((send) => !workerAddresses.has(send.target));
	if (wrongTarget) return {
		result: "fail",
		reason: "worker_target_mismatch",
		lead: wrongTarget,
		worker: relevantWorker[0]
	};
	const wrongSender = validWorker.find((message) => message.sourceKind !== "agent-message" || message.senderId !== rootNativeAgentId);
	if (wrongSender) return {
		result: "fail",
		reason: "lead_sender_mismatch",
		lead: relevantLead[0],
		worker: wrongSender
	};
	if (relevantLead.some((send) => !validDeliveryText(send.text, mandate)) || relevantWorker.some((message) => !validDeliveryText(message.text, mandate))) return {
		result: "fail",
		reason: "mandate_text_or_action_now_mismatch",
		lead: relevantLead[0],
		worker: relevantWorker[0]
	};
	const rootWorkerMessages = relevantWorker.filter((message) => message.sourceKind === "agent-message" && message.senderId === rootNativeAgentId);
	if (relevantLead.length > 0 && rootWorkerMessages.length > 0 && !relevantLead.some((lead) => rootWorkerMessages.some((worker) => worker.text === lead.text))) return {
		result: "fail",
		reason: "lead_worker_message_mismatch",
		lead: relevantLead[0],
		worker: rootWorkerMessages[0]
	};
	if (incomplete) return {
		result: "unknown",
		reason: "native_reference_incomplete",
		lead: incomplete.lead,
		worker: incomplete.worker
	};
	if (validLead.some((send) => workerAddresses.has(send.target))) return {
		result: "unknown",
		reason: "worker_receipt_missing",
		lead: validLead[0],
		worker: relevantWorker[0]
	};
	if (validWorker.some((message) => message.sourceKind === "agent-message" && message.senderId === rootNativeAgentId)) return {
		result: "unknown",
		reason: "lead_send_missing",
		lead: relevantLead[0],
		worker: validWorker[0]
	};
	return {
		result: "unknown",
		reason: "mandate_delivery_not_found",
		lead: relevantLead[0],
		worker: relevantWorker[0]
	};
}
function mandateDeliveryReceipt(input) {
	const { mandate, observation } = input;
	const lead = observation.lead;
	const worker = observation.worker;
	const activityCount = (lead ? 1 : 0) + (worker ? 1 : 0);
	if (input.kind === "coverage" && !input.obligationId) throw new HostError("COVERAGE_OBLIGATION_REQUIRED", "coverage mandate_delivery evidence requires an obligation binding");
	if (input.kind === "host_contract" && observation.result === "pass" && activityCount < 1) throw new HostError("HOST_CONTRACT_UNKNOWN", "host_contract pass requires real native delivery activity");
	return {
		hostObserved: true,
		provenance: "host_observed",
		verification: "mandate_delivery",
		...input.kind === "coverage" ? {
			coverage: observation.result === "pass" ? "full" : "unknown",
			obligationId: input.obligationId,
			...input.sourceId ? { sourceId: input.sourceId } : {}
		} : { activityCount },
		mandateId: mandate.id,
		attempt: mandate.attempt,
		generation: mandate.generation,
		workerId: input.workerNativeAgentId,
		operation: "verify",
		reason: observation.reason,
		nativeAgentId: input.workerNativeAgentId,
		leadNativeAgentId: input.rootNativeAgentId,
		workerNativeAgentId: input.workerNativeAgentId,
		...lead ? {
			leadEventSeq: lead.eventSeq,
			leadEventType: lead.eventType
		} : {},
		...lead?.callId ? { leadCallId: lead.callId } : {},
		...worker ? {
			workerEventSeq: worker.eventSeq,
			workerEventType: worker.eventType
		} : {},
		...worker?.messageId ? { workerMessageId: worker.messageId } : {}
	};
}
const MODEL_RECEIPT_KEYS = /* @__PURE__ */ new Set([
	"exitCode",
	"passed",
	"failed",
	"total",
	"hash",
	"sourceHash",
	"buildHash",
	"loadedHash",
	"operation",
	"write",
	"coverage",
	"obligationId",
	"sourceId",
	"mode",
	"timeout",
	"unreadable",
	"malformed",
	"restartRequired",
	"deploymentStatus",
	"activityCount",
	"emptyReason",
	"actual",
	"expected",
	"left",
	"right",
	"delta",
	"scope",
	"artifactId",
	"status",
	"reason",
	"fingerprint",
	"violated",
	"observed"
]);
const SENSITIVE = /(password|passwd|secret|token|cookie|api[_-]?key|authorization|credential|private[_-]?key|body|content|transcript|source[_-]?text)/i;
function sanitizeModelReceipt(receipt) {
	if (JSON.stringify(receipt).length > 8e3) throw new HostError("EVIDENCE_RECEIPT_INVALID", "model receipt exceeds 8000 characters");
	const clean = {};
	for (const [key, value] of Object.entries(receipt)) {
		if (SENSITIVE.test(key) || !MODEL_RECEIPT_KEYS.has(key)) throw new HostError("EVIDENCE_RECEIPT_INVALID", "receipt key is sensitive or outside the host allowlist", { key });
		clean[key] = value;
	}
	return {
		...clean,
		hostObserved: false,
		provenance: "model_reported"
	};
}
async function readNativeEvents(ctx, sessionId) {
	return (await ctx.sessionQuery.readSession(sessionId)).events;
}
async function observeNativeEvent(ctx, sessionId, seq) {
	if (!Number.isSafeInteger(seq) || seq < 0) throw new HostError("EVIDENCE_EVENT_NOT_FOUND", "eventSeq must be a non-negative safe integer");
	const events = await readNativeEvents(ctx, sessionId);
	const facts = extractNativeFacts(events, seq);
	if (!["tool/result", "tool/ptc-dispatch"].includes(facts.eventType)) throw new HostError("EVIDENCE_EVENT_UNSUPPORTED", "only native tool result or PTC dispatch events can become host-observed evidence");
	return {
		events,
		facts,
		receipt: hostObservedReceipt(sessionId, seq, facts)
	};
}
// src/host/guard.ts
const READ_TOOLS = /* @__PURE__ */ new Set([
	"read",
	"read_image",
	"grep",
	"glob",
	"list_agents",
	"get_goal",
	"session_search",
	"session_event_search",
	"session_event_read",
	"session_event_trace",
	"session_trace",
	"web_fetch",
	"web_search",
	"deja_recall",
	"deja_session",
	"deja_blame",
	"deja_how"
]);
const WRITE_TOOLS = /* @__PURE__ */ new Set([
	"write",
	"edit",
	"pwsh",
	"bash",
	"run_code",
	"terminal_open",
	"terminal_send",
	"terminal_signal",
	"terminal_close",
	"create_worktree",
	"job_kill",
	"team_task_create",
	"team_task_update",
	"send_message",
	"subagent",
	"subagent_fork",
	"subagent_claude_code",
	"subagent_codex",
	"create_goal",
	"update_goal",
	"schedule_create",
	"schedule_edit",
	"image_generate",
	"video_generate",
	"present",
	"evolve_add",
	"evolve_remove"
]);
const SESSIONGRAPH_READ_OPERATIONS = /* @__PURE__ */ new Set([
	"search",
	"session",
	"event",
	"trace",
	"timeline",
	"workspaces",
	"status",
	"touched"
]);
function asRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function parseArguments(args) {
	if (typeof args === "string") try {
		return asRecord(JSON.parse(args));
	} catch {
		return;
	}
	return asRecord(args);
}
function actionOf(args) {
	return parseArguments(args)?.action;
}
const POWERSHELL_READ_COMMANDS = /* @__PURE__ */ new Set([
	"get-content",
	"get-item",
	"get-childitem",
	"get-location",
	"get-process",
	"get-service",
	"get-computerinfo",
	"get-date",
	"get-host",
	"get-variable",
	"get-psdrive",
	"get-command",
	"get-help",
	"get-history",
	"get-itemproperty",
	"get-itempropertyvalue",
	"get-acl",
	"get-executionpolicy",
	"get-module",
	"get-package",
	"test-path",
	"resolve-path",
	"select-string",
	"select-object",
	"measure-object",
	"compare-object",
	"get-filehash",
	"get-member",
	"get-winevent",
	"get-eventlog",
	"get-counter",
	"get-culture",
	"get-uiculture"
]);
const POWERSHELL_ENV_READ = [
	/^\$env:[A-Za-z_][A-Za-z0-9_]*$/u,
	/^write-output\s+\$env:[A-Za-z_][A-Za-z0-9_]*$/iu,
	/^echo\s+\$env:[A-Za-z_][A-Za-z0-9_]*$/iu,
	/^get-item\s+env:[A-Za-z_][A-Za-z0-9_]*$/iu,
	/^get-childitem\s+env:[A-Za-z_][A-Za-z0-9_]*$/iu,
	/^get-childitem\s+env:\s*$/iu,
	/^get-variable\s+[A-Za-z_][A-Za-z0-9_]*$/iu
];
function isPowerShellEnvironmentRead(command) {
	const trimmed = command.trim();
	return POWERSHELL_ENV_READ.some((pattern) => pattern.test(trimmed));
}
const POWERSHELL_DOTNET_READONLY = [
	/^\[Environment\]::GetEnvironmentVariable\(/iu,
	/^\[Environment\]::UserName$/iu,
	/^\[Environment\]::MachineName$/iu,
	/^\[Environment\]::CurrentDirectory$/iu,
	/^\[Environment\]::OSVersion$/iu,
	/^\[System\.Environment\]::GetEnvironmentVariable\(/iu
];
function isPowerShellDotNetReadonly(command) {
	return POWERSHELL_DOTNET_READONLY.some((pattern) => pattern.test(command.trim()));
}
const BASH_READ_COMMANDS = /* @__PURE__ */ new Set([
	"cat",
	"ls",
	"pwd",
	"stat",
	"wc",
	"head",
	"tail",
	"grep",
	"rg",
	"find",
	"file",
	"which",
	"type",
	"ps",
	"id",
	"whoami",
	"date",
	"hostname",
	"uname",
	"env",
	"printenv",
	"du",
	"df",
	"sha256sum"
]);
function shellSafety(args, name) {
	const input = parseArguments(args);
	if (input && Object.keys(input).some((key) => ![
		"command",
		"description",
		"workdir",
		"timeoutMs",
		"run_in_background",
		"signal"
	].includes(key))) return "write";
	const command = input?.command;
	if (typeof command !== "string" || command.trim().length === 0 || command.length > 4e3) return "unknown";
	if (/[<>|;&`]/u.test(command) || /\$(?:\()/u.test(command)) return "write";
	if (name === "pwsh" && isPowerShellEnvironmentRead(command)) return "read";
	if (name === "pwsh" && isPowerShellDotNetReadonly(command)) return "read";
	if (/\b(?:Invoke|Start|Stop|Restart|Suspend|Resume|New|Set|Add|Remove|Clear|Move|Copy|Rename|Delete|Kill|Format|Install|Uninstall|Register|Unregister|Grant|Revoke|Enable|Disable|Update|Write|Edit|Create|Mount|Dismount|Initialize|Restore|Repair|Push|Publish|Commit|Checkout|Clean|Reset|Rebase|Merge|Apply|Net|IEX|IWR|IRM)-/i.test(command)) return "write";
	const executable = command.trim().split(/\s+/u, 1)[0]?.toLowerCase().replace(/\.exe$/u, "");
	if (!executable) return "unknown";
	if (!(name === "pwsh" ? POWERSHELL_READ_COMMANDS : BASH_READ_COMMANDS).has(executable)) return "write";
	if (name === "bash" && /\s-[a-zA-Z]*[wim]/u.test(command)) return "write";
	return "read";
}
function isReadOnlyResultNarrative(target, text) {
	if (target !== "lead" || text.length > 8e3 || /[@]/u.test(text) || !/(?:\breport(?:ed|ing)?\b|\breceipts?\b|\bverdict\b|\bresult\b|\baccepted\b|\breview(?:er|ing)?\b|结果|回执|验收|核验|复核|已放行|未放行)/iu.test(text)) return false;
	for (const line of text.split(/\r?\n/u)) {
		if (!/(?:\bread\b|\bwrite\b|\bedit\b|\bopen\b|\battach(?:ing)?\b|\bsend\b|\bmodify\b|\bdelete\b|\bcreate\b|读取|修改|编辑|附件|删除|创建|写入|打开)/iu.test(line)) continue;
		if (/(?:\bplease\s+(?:write|edit|create|delete|modify|open|send|attach)\b|\bmust\s+(?:write|edit|create|delete|modify|open|send|attach)\b|\bnext\s*:?\s*(?:write|edit|create|delete|modify|open|send|attach)\b|请(?:\s*)(?:写入|创建|删除|修改|编辑|打开|发送|write\b|edit\b|create\b|delete\b|modify\b|open\b|send\b|attach\b)|必须(?:\s*)(?:写入|创建|删除|修改|编辑)|下一步(?:\s*)(?:写入|创建|删除|修改|编辑)|继续(?:\s*)(?:写入|创建|删除|修改|编辑))/iu.test(line)) return false;
		if (!/(?:→|只读|零写入|exactly|逐字|核对|描述|\bok\b|\bpass\b|\baccepted\b|已|过|成功|完成)/iu.test(line)) return false;
	}
	return true;
}
function messageSafety(args) {
	const input = parseArguments(args);
	const target = input?.agent;
	const text = input?.message;
	if (typeof target !== "string" || target.trim().length === 0 || typeof text !== "string" || text.trim().length === 0 || text.length > 8e3) return "unknown";
	if (Object.keys(input).some((key) => !["agent", "message"].includes(key))) return "unknown";
	if (/(?:[a-zA-Z]:[\\/]|\.(?:\/|\\)(?:[^\s]+\/)|(?:file|attachment|image|video|document)s?\s*[:=]|https?:\/\/|\/mnt\/|\/tmp\/)/i.test(text) && !isReadOnlyResultNarrative(target, text)) return "write";
	if (/\b(?:grant|allow|elevate|approve|bypass|escalat(?:e|ion)|permission|write access|full access|sandbox(?:ing)?)\b/i.test(text)) return "write";
	return "supervisory";
}
function classifyToolSafety(name, args) {
	if (name === "working_directory") {
		if (args === void 0) return "read";
		const input = parseArguments(args);
		if (!input) return "unknown";
		const keys = Object.keys(input);
		if (keys.length === 0 || keys.length === 1 && keys[0] === "cd" && input.cd === void 0) return "read";
		return keys.length === 1 && keys[0] === "cd" && typeof input.cd === "string" && input.cd.trim().length > 0 ? "read" : "unknown";
	}
	if (name === "sessiongraph") {
		if (args === void 0) return "read";
		const input = parseArguments(args);
		if (!input) return "unknown";
		const operation = input.operation ?? "search";
		if (operation === "index") return "write";
		return typeof operation === "string" && SESSIONGRAPH_READ_OPERATIONS.has(operation) ? "read" : "unknown";
	}
	if (name === "codeflow_map") {
		const action = actionOf(args);
		return action === "init" ? "write" : action === "status" || action === "graph" ? "read" : "unknown";
	}
	if (name === "super_snapshot") return "supervisory";
	if (name === "super_run" || name === "super_anchor" || name === "super_mandate" || name === "super_evidence" || name === "super_review" || name === "super_route") {
		const action = actionOf(args);
		if (name === "super_run") return action === "show" ? "supervisory" : "write";
		if (name === "super_anchor") return action === "show" || action === "history" ? "supervisory" : "write";
		if (name === "super_mandate") return action === "show" ? "supervisory" : "write";
		if (name === "super_evidence") return [
			"record",
			"observe",
			"verify",
			"list"
		].includes(String(action)) ? "supervisory" : "unknown";
		if (name === "super_review") return [
			"evaluate",
			"decide",
			"release"
		].includes(String(action)) ? "supervisory" : "unknown";
		if (name === "super_route") return ["show", "inspect"].includes(String(action)) ? "read" : action === "set" || action === "switch" ? "write" : "unknown";
	}
	if (name === "pwsh" || name === "bash") return shellSafety(args, name);
	if (name === "send_message") return messageSafety(args);
	if (READ_TOOLS.has(name)) return "read";
	if (WRITE_TOOLS.has(name)) return "write";
	return "unknown";
}
function reviewerToolDenial(name, args) {
	const safety = classifyToolSafety(name, args);
	if (safety === "read" || safety === "supervisory") return void 0;
	if (name === "run_code") return `Forbidden Reviewer PTC run_code; do not retry through super-agent. ${REVIEWER_COMPOSITION_GUIDANCE}`;
	return `Reviewer is read-only; ${name} is ${safety}. ${REVIEWER_COMPOSITION_GUIDANCE}`;
}
function successfulMutatingEvents(events) {
	const calls = /* @__PURE__ */ new Map();
	for (const event of events) {
		if (event.type !== "tool/call") continue;
		const data = asRecord(event.data);
		const name = typeof data?.name === "string" ? data.name : typeof data?.toolName === "string" ? data.toolName : void 0;
		if (typeof data?.callId === "string" && name) calls.set(data.callId, {
			name,
			arguments: data.arguments ?? data.args
		});
	}
	const violations = [];
	for (const event of events) {
		if (event.type !== "tool/result" && event.type !== "tool/ptc-dispatch") continue;
		const data = asRecord(event.data);
		const message = asRecord(data?.message);
		if (data?.error !== void 0 || data?.isError === true || message?.isError === true) continue;
		const source = asRecord(message?.source);
		const callId = [
			source?.callId,
			data?.callId,
			data?.subCallId
		].find((value) => typeof value === "string" && value.length > 0);
		const call = callId ? calls.get(callId) : void 0;
		const names = [
			data?.name,
			data?.toolName,
			source?.name,
			source?.toolName,
			call?.name
		].filter((value) => typeof value === "string" && value.length > 0);
		const name = names[0];
		const identityConflict = new Set(names).size > 1;
		const args = data?.arguments ?? data?.args ?? call?.arguments;
		const safety = name && !identityConflict ? classifyToolSafety(name, args) : "unknown";
		if (safety === "write" || safety === "unknown") violations.push({
			seq: Number(event.seq),
			toolName: name ?? "unknown",
			operation: safety
		});
	}
	return violations;
}
// src/host/routing.ts
function routesEqual(left, right) {
	return left === null || left === void 0 ? right === null || right === void 0 : right !== null && right !== void 0 && left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort;
}
function routeFrom(value) {
	if (value === null || typeof value !== "object") return null;
	const candidate = value;
	if (typeof candidate.provider !== "string" || candidate.provider.length === 0 || typeof candidate.model !== "string" || candidate.model.length === 0) return null;
	return {
		provider: candidate.provider,
		model: candidate.model,
		...typeof candidate.reasoningEffort === "string" && candidate.reasoningEffort.length > 0 ? { reasoningEffort: candidate.reasoningEffort } : {}
	};
}
function mandateForNativeAgent(state, agentId) {
	if (!state) return null;
	for (const item of Object.values(state.workItems)) {
		const mandate = item.currentMandateId ? state.mandates[item.currentMandateId] : void 0;
		if (!mandate || mandate.status === "superseded" || mandate.status === "accepted" || mandate.status === "unknown") continue;
		if ((mandate.workerAgentId ?? mandate.workerId) === agentId) return {
			mandate,
			role: "worker"
		};
		if ((mandate.reviewerAgentId ?? mandate.reviewerId) === agentId) return {
			mandate,
			role: "reviewer"
		};
	}
	return null;
}
function classifyModelFailure(failure) {
	const code = failure.code.toUpperCase().replaceAll("-", "_");
	if (/^(AUTH|AUTHENTICATION|UNAUTHORIZED|INVALID_API_KEY|INVALID_TOKEN)$/.test(code) || failure.status === 401) return "authentication";
	if (/^(PERMISSION|PERMISSION_DENIED|FORBIDDEN)$/.test(code) || failure.status === 403) return "permission";
	if (/^(INVALID_ARGS|TOOL_ARGS_ERROR|TOOL_INPUT)$/.test(code)) return "tool_input";
	if (/^(BUSINESS_ACCEPTANCE|EVIDENCE_FAIL|GATE_FAIL)$/.test(code)) return "business_acceptance";
	if (/^SNAPSHOT_PROOF/.test(code)) return "snapshot_proof";
	if (/^(WRITE_SCOPE|WRITE_SCOPE_OVERLAP)$/.test(code)) return "write_scope";
	if (/^(ACTOR_MISMATCH|IDENTITY|REVIEWER_SAME_AS_WORKER)$/.test(code)) return "identity";
	if (/^(TIMEOUT|ETIMEDOUT|REQUEST_TIMEOUT)$/.test(code) || failure.status === 408) return "timeout";
	if (/^(RATE_LIMIT|RATE_LIMITED|TOO_MANY_REQUESTS)$/.test(code) || failure.status === 429) return "rate_limit";
	if (/^(QUOTA|QUOTA_EXCEEDED|ACCOUNT_QUOTA|ACCOUNT_QUOTA_EXCEEDED|INSUFFICIENT_QUOTA)$/.test(code)) return code.startsWith("ACCOUNT_") ? "account_quota" : "quota";
	if (/^(PROVIDER_UNAVAILABLE|MODEL_UNAVAILABLE|ROUTE_UNAVAILABLE)$/.test(code)) return "provider_unavailable";
	if (/^(ROUTE_INCOMPATIBLE|MODEL_INCOMPATIBLE|MODEL_NOT_SUPPORTED|UNSUPPORTED_MODEL)$/.test(code)) return "route_incompatible";
	if (/^(TRANSIENT|NETWORK_ERROR|CONNECTION_ERROR|ECONNRESET|ECONNREFUSED|EAI_AGAIN|SOCKET_ERROR|UPSTREAM_UNAVAILABLE)$/.test(code) || failure.status === 502 || failure.status === 503 || failure.status === 504) return "transient";
	return "unknown";
}
function retryable(kind) {
	return kind === "transient" || kind === "timeout" || kind === "rate_limit";
}
function switchable(kind) {
	return kind === "quota" || kind === "account_quota" || kind === "provider_unavailable" || kind === "route_incompatible";
}
function assertRouteSwitchAllowsWork(mandate) {
	if ((mandate.routeSwitches ?? []).some((entry) => entry.status === "requested")) throw new HostError("ROUTE_SWITCH_REQUIRES_NEW_MANDATE", "route-switched execution results require a new Mandate/attempt; old evidence and review cannot release the switched route");
}
function routePolicyView(state) {
	return {
		modelPolicy: state?.run.modelPolicy ?? null,
		routeFailures: Object.values(state?.routeFailures ?? {})
	};
}
async function inspectMandateRoute(ctx, state, mandateId, targetRole, signal) {
	const mandate = state?.mandates[mandateId];
	if (!mandate) throw new HostError("MANDATE_REQUIRED", "route inspection requires an existing mandate in the current root Run");
	const nativeAgentId = targetRole === "worker" ? mandate.workerAgentId : mandate.reviewerAgentId ?? mandate.reviewerId;
	if (!nativeAgentId) throw new HostError("ROUTE_UNKNOWN", "mandate has no native Agent binding for this role");
	const agent = ctx.agents.get(nativeAgentId);
	if (!agent) return {
		mandateId,
		targetRole,
		nativeAgentId,
		expectedRoute: null,
		currentRoute: null,
		lastRequestRoute: null,
		status: "unknown",
		reason: "ROUTE_AGENT_UNAVAILABLE"
	};
	const expectedRoute = (targetRole === "worker" ? mandate.workerRoute : mandate.reviewerRoute) ?? null;
	const currentRoute = routeFrom(agent.model.current());
	let lastRequestRoute = null;
	let requestReadError;
	try {
		lastRequestRoute = routeFrom(await ctx.sessionQuery.inspectSession(agent.id, (session) => session.requestHeader()?.config, signal));
	} catch {
		requestReadError = "ROUTE_REQUEST_HEADER_UNAVAILABLE";
	}
	const base = {
		mandateId,
		targetRole,
		nativeAgentId,
		expectedRoute,
		currentRoute,
		lastRequestRoute,
		status: "unknown",
		...requestReadError ? { reason: requestReadError } : {}
	};
	if (expectedRoute === null) return {
		...base,
		status: "inherited"
	};
	if (currentRoute !== null && !routesEqual(currentRoute, expectedRoute) || lastRequestRoute !== null && !routesEqual(lastRequestRoute, expectedRoute) || currentRoute !== null && lastRequestRoute !== null && !routesEqual(currentRoute, lastRequestRoute)) return {
		...base,
		status: "unknown",
		reason: "ROUTE_MISMATCH"
	};
	if (routesEqual(currentRoute, expectedRoute) || routesEqual(lastRequestRoute, expectedRoute)) return {
		...base,
		status: "matched"
	};
	return base;
}
function nativeSelection(route) {
	return {
		provider: route.provider,
		model: route.model,
		...route.reasoningEffort !== void 0 ? { reasoningEffort: route.reasoningEffort } : {}
	};
}
async function switchMandateRoute(ctx, repository, sessionId, input) {
	const state = repository.read(sessionId);
	const mandate = state?.mandates[input.mandateId];
	if (!state || !mandate) throw new HostError("MANDATE_REQUIRED", "route switch requires a mandate in the current root Run");
	const nativeAgentId = input.targetRole === "worker" ? mandate.workerAgentId : mandate.reviewerAgentId ?? mandate.reviewerId;
	const agent = nativeAgentId ? ctx.agents.get(nativeAgentId) : void 0;
	if (!agent) throw new HostError("ROUTE_AGENT_UNAVAILABLE", "the bound native Agent is not live; no Core switch or model selection was attempted");
	const guard = {
		expectedRevision: state.run.revision,
		expectedGeneration: state.run.generation
	};
	const result = await repository.transact(sessionId, (core) => core.switchMandateRoute({
		...guard,
		...input
	}));
	if (!result.ok) return result;
	try {
		agent.model.select(nativeSelection(input.to));
	} catch (error) {
		throw new HostError("ROUTE_SELECT_FAILED_AFTER_COMMIT", "Core route switch is durable, but native model.select failed; inspect before retrying", {
			switchId: result.value.id,
			cause: error instanceof Error ? error.message : String(error)
		});
	}
	const current = routeFrom(agent.model.current());
	if (!current || !routesEqual(current, input.to)) throw new HostError("ROUTE_MISMATCH", "native model.current did not read back the committed route switch", { switchId: result.value.id });
	return {
		...result,
		value: {
			...result.value,
			nativeSelection: current
		}
	};
}
async function waitForRetry(delayMs, signal) {
	if (delayMs <= 0) return !signal.aborted;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve(true);
		}, delayMs);
		const abort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}
async function adaptNativeModelFailure(ctx, repository, agent, failure, signal) {
	if (!await canUseSuperTools(ctx, repository, agent, signal)) return "unhandled";
	const root = rootOf(ctx, agent);
	const state = repository.read(root.id);
	const policy = state?.run.modelPolicy;
	if (!state || !policy) return "delegate";
	const binding = mandateForNativeAgent(state, agent.id);
	if (!binding) return "unhandled";
	const kind = classifyModelFailure(failure);
	const failureCode = failure.code.trim() || "UNKNOWN";
	const guard = {
		expectedRevision: state.run.revision,
		expectedGeneration: state.run.generation
	};
	const recorded = await repository.transact(root.id, (core) => core.recordRouteFailure({
		...guard,
		mandateId: binding.mandate.id,
		targetRole: binding.role,
		failureKind: kind,
		failureCode,
		retrySameRoute: retryable(kind)
	}));
	if (!recorded.ok) return "blocked";
	const delay = Math.max(policy.cooldownMs ?? 0, failure.providerRetryAfterMs ?? 0);
	if (recorded.value.action === "retry_recorded") {
		if (!await waitForRetry(delay, signal)) return "blocked";
		return "retry";
	}
	if (recorded.value.action === "switch_required" && switchable(kind)) {
		const actual = routeFrom(agent.model.current());
		const target = policy.allowedRoutes.find((route) => !routesEqual(route, actual));
		if (!target) return "blocked";
		if (!(await switchMandateRoute(ctx, repository, root.id, {
			mandateId: binding.mandate.id,
			targetRole: binding.role,
			to: target,
			failureCode,
			reason: "bounded native model failure switch: " + kind
		})).ok) return "blocked";
		if (!await waitForRetry(delay, signal)) return "blocked";
		return "switch";
	}
	if (recorded.value.action === "rejected" && (retryable(kind) || switchable(kind))) return "blocked";
	return "delegate";
}
/** Native next-attempt adapter. No Agent creation and no mutation of an already-dispatched request. */
function registerModelFailureAdapter(ctx, repository) {
	return ctx.on("agent/request-error", async (payload, next) => {
		if (payload.signal.aborted) return void 0;
		const outcome = await adaptNativeModelFailure(ctx, repository, payload.agent, payload.failure, payload.signal);
		if (outcome === "retry" || outcome === "switch") return { kind: "retry" };
		if (outcome === "delegate" || outcome === "unhandled") return next();
	});
}
// src/host/tool-schemas.ts
const TOOL_OUTPUT = {
	schema: {
		type: "object",
		additionalProperties: false,
		properties: {
			ok: {
				type: "boolean",
				required: true
			},
			state: {
				type: "json",
				required: true
			},
			value: { type: "json" },
			error: {
				type: "object",
				additionalProperties: false,
				properties: {
					code: {
						type: "string",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					details: { type: "json" }
				}
			}
		}
	},
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value, null, 2)
	}]
};
const obligationDelta = {
	type: "array",
	items: { type: "json" },
	description: "Structured add/amend/waive/supersede deltas; no actor identity fields."
};
const common = {
	expectedRevision: {
		type: "number",
		description: "Current Run revision for CAS writes."
	},
	expectedGeneration: {
		type: "number",
		description: "Current Run generation for recovery-safe writes."
	}
};
const workItem = {
	type: "object",
	additionalProperties: false,
	properties: {
		id: {
			type: "string",
			required: true
		},
		title: {
			type: "string",
			required: true
		},
		dependencies: {
			type: "array",
			items: { type: "string" },
			required: true
		},
		writeScopes: {
			type: "array",
			items: { type: "string" },
			required: true
		},
		acceptance: {
			type: "array",
			items: { type: "string" },
			required: true
		},
		obligationIds: {
			type: "array",
			items: { type: "string" },
			required: true
		},
		gateProfile: {
			type: "string",
			enum: [
				"code",
				"visual",
				"deployment",
				"numeric_reconcile",
				"coverage"
			],
			required: true
		},
		hostContractRequired: { type: "boolean" },
		mandatory: { type: "boolean" }
	}
};
const runParameters = {
	action: {
		type: "string",
		enum: [
			"create",
			"show",
			"plan",
			"pause",
			"resume",
			"replan",
			"recover",
			"complete"
		],
		required: true
	},
	...common,
	objective: { type: "string" },
	definitionOfDone: { type: "string" },
	gatePolicy: {
		type: "object",
		additionalProperties: false,
		properties: {
			maxAttempts: { type: "number" },
			maxSameFingerprint: { type: "number" }
		}
	},
	obligations: {
		type: "array",
		items: {
			type: "object",
			additionalProperties: false,
			properties: {
				id: {
					type: "string",
					required: true
				},
				kind: {
					type: "string",
					enum: [
						"requirement",
						"prohibition",
						"coverage"
					],
					required: true
				},
				text: {
					type: "string",
					required: true
				},
				requiredEvidence: {
					type: "array",
					items: {
						type: "string",
						enum: [
							"build",
							"unit",
							"static",
							"simulated",
							"host_contract",
							"runtime_gui",
							"animation",
							"hover",
							"artifact",
							"source_hash",
							"build_hash",
							"loaded_hash",
							"host_receipt",
							"numeric_reconcile",
							"coverage",
							"user_feedback"
						]
					}
				},
				animation: { type: "string" },
				coverage: {
					type: "string",
					enum: [
						"full",
						"partial",
						"substitute",
						"unknown"
					]
				},
				verification: {
					type: "string",
					enum: ["mandate_delivery"]
				},
				sourceId: { type: "string" }
			}
		},
		description: "ObligationInput array; every item requires id/kind/text and rejects unknown fields."
	},
	items: {
		type: "array",
		items: workItem,
		description: "WorkItemInput array; use dependencies (not dependsOn) and provide every required field."
	},
	workItemRevisions: {
		type: "array",
		items: workItem,
		description: "Optional user-authorized complete WorkItemInput revisions for replan; passed through to Core."
	},
	instruction: { type: "string" },
	obligationDelta
};
const anchorParameters = {
	action: {
		type: "string",
		enum: [
			"create",
			"show",
			"history"
		],
		required: true
	},
	...common,
	instruction: { type: "string" },
	obligationDelta
};
const mandateParameters = {
	action: {
		type: "string",
		enum: [
			"prepare",
			"bind",
			"bindReviewer",
			"report",
			"show"
		],
		required: true
	},
	...common,
	workItemId: { type: "string" },
	mandateId: { type: "string" },
	workerAgentId: {
		type: "string",
		description: "Exact native descendant SessionId, not a display alias."
	},
	reviewerAgentId: {
		type: "string",
		description: "Exact independent native descendant SessionId launched with agent_preset=standard, not a display alias or super-agent/PTC Reviewer."
	},
	nativeTaskId: { type: "string" },
	knownFailures: {
		type: "array",
		items: { type: "string" }
	},
	summary: { type: "string" },
	routeReason: {
		type: "string",
		description: "Why the policy-selected Worker/Reviewer routes apply to this Mandate."
	}
};
const modelRoute = {
	type: "object",
	additionalProperties: false,
	properties: {
		provider: {
			type: "string",
			required: true
		},
		model: {
			type: "string",
			required: true
		},
		reasoningEffort: { type: "string" }
	}
};
const modelPolicy = {
	type: "object",
	additionalProperties: false,
	properties: {
		mode: {
			type: "string",
			enum: [
				"locked",
				"balanced",
				"economy",
				"performance"
			],
			required: true
		},
		allowedRoutes: {
			type: "array",
			items: modelRoute,
			required: true
		},
		workerRoute: modelRoute,
		reviewerRoute: modelRoute,
		allowFailureSwitch: {
			type: "boolean",
			required: true
		},
		maxSameRouteRetries: {
			type: "number",
			required: true
		},
		maxRouteSwitches: {
			type: "number",
			required: true
		},
		cooldownMs: { type: "number" }
	}
};
const routeParameters = {
	action: {
		type: "string",
		enum: [
			"show",
			"set",
			"inspect",
			"switch"
		],
		required: true
	},
	...common,
	policy: modelPolicy,
	mandateId: { type: "string" },
	targetRole: {
		type: "string",
		enum: ["worker", "reviewer"]
	},
	to: modelRoute,
	failureCode: { type: "string" },
	reason: { type: "string" }
};
const SUPER_TOOL_PARAMETERS = {
	super_run: runParameters,
	super_anchor: anchorParameters,
	super_mandate: mandateParameters,
	super_evidence: {
		action: {
			type: "string",
			enum: [
				"observe",
				"record",
				"verify",
				"list"
			],
			required: true
		},
		...common,
		workItemId: { type: "string" },
		mandateId: { type: "string" },
		kind: {
			type: "string",
			enum: [
				"build",
				"unit",
				"static",
				"simulated",
				"host_contract",
				"runtime_gui",
				"animation",
				"hover",
				"artifact",
				"source_hash",
				"build_hash",
				"loaded_hash",
				"host_receipt",
				"numeric_reconcile",
				"coverage",
				"user_feedback"
			],
			description: "For action=verify only coverage (default) or host_contract is supported."
		},
		result: {
			type: "string",
			enum: [
				"pass",
				"fail",
				"unknown"
			],
			description: "Only action=record; host observation derives this from native evidence."
		},
		receipt: {
			type: "object",
			additionalProperties: false,
			properties: Object.fromEntries([
				"exitCode",
				"passed",
				"failed",
				"total",
				"hash",
				"sourceHash",
				"buildHash",
				"loadedHash",
				"operation",
				"write",
				"coverage",
				"obligationId",
				"sourceId",
				"mode",
				"timeout",
				"unreadable",
				"malformed",
				"restartRequired",
				"deploymentStatus",
				"activityCount",
				"emptyReason",
				"actual",
				"expected",
				"left",
				"right",
				"delta",
				"scope",
				"artifactId",
				"status",
				"reason",
				"fingerprint",
				"violated",
				"observed"
			].map((key) => [key, { type: "json" }])),
			description: "Allowlisted model_reported facts; hostObserved is not in the model schema."
		},
		summary: { type: "string" },
		sessionId: {
			type: "string",
			description: "Exact native root/descendant SessionId owning eventSeq."
		},
		eventSeq: { type: "number" },
		verification: {
			type: "string",
			enum: ["mandate_delivery"],
			description: "Only action=verify; Host reads the real Lead/Worker native Sessions and records coverage or host_contract directly."
		},
		obligationId: {
			type: "string",
			description: "Coverage obligation linked to the current WorkItem; optional only when it is unambiguous."
		},
		sourceId: {
			type: "string",
			description: "Optional coverage source binding; must match the linked obligation."
		}
	},
	super_review: {
		action: {
			type: "string",
			enum: [
				"evaluate",
				"decide",
				"release"
			],
			required: true
		},
		...common,
		workItemId: { type: "string" },
		mandateId: { type: "string" },
		result: {
			type: "string",
			enum: [
				"pass",
				"fail",
				"unknown"
			]
		},
		evidenceIds: {
			type: "array",
			items: { type: "string" }
		}
	},
	super_route: routeParameters,
	super_snapshot: {}
};
// src/host/tools.ts
const toJson = (value) => JSON.parse(JSON.stringify(value));
const record = (args) => args;
const stringArg = (args, key) => {
	const value = args[key];
	if (typeof value !== "string" || value.trim() === "") throw new HostError("INVALID_TRANSITION", `${key} is required`);
	return value;
};
const guardArgs = (args) => ({
	expectedRevision: args.expectedRevision,
	expectedGeneration: args.expectedGeneration
});
function success(result) {
	if (!result.ok) return failure(result.error, result.state);
	return {
		ok: true,
		state: toJson(result.state),
		value: toJson(result.value)
	};
}
function okValue(state, value) {
	return {
		ok: true,
		state: toJson(state),
		value: toJson(value)
	};
}
function failure(error, state = null) {
	return {
		ok: false,
		state: toJson(state),
		error: {
			code: error.code,
			message: error.message,
			...error.details ? { details: toJson(error.details) } : {}
		}
	};
}
function currentMandate(state, mandateId) {
	const mandate = state?.mandates[mandateId];
	if (!mandate) throw new HostError("MANDATE_REQUIRED", "mandate does not exist in the current root run");
	const item = state?.workItems[mandate.workItemId];
	if (!state || !item || item.currentMandateId !== mandate.id || item.status === "superseded" || mandate.status === "superseded" || mandate.generation !== state.run.generation || mandate.attempt !== item.attempt) throw new HostError("MANDATE_STALE", "mandate is rejected, superseded, unknown, or outside the current attempt/generation");
	return mandate;
}
function coverageTarget(state, mandate, args) {
	const candidates = state.workItems[mandate.workItemId].obligationIds.flatMap((id) => {
		const obligation = state.obligations[id];
		return obligation?.kind === "coverage" && obligation.verification === "mandate_delivery" && obligation.status !== "superseded" && obligation.status !== "waived" ? [obligation] : [];
	});
	const obligationId = args.obligationId === void 0 ? void 0 : stringArg(args, "obligationId");
	const sourceId = args.sourceId === void 0 ? void 0 : stringArg(args, "sourceId");
	let matches = candidates;
	if (obligationId) matches = matches.filter((obligation) => obligation.id === obligationId);
	if (sourceId) matches = matches.filter((obligation) => obligation.sourceId === sourceId);
	if (matches.length !== 1 || candidates.length > 1 && !obligationId && !sourceId) throw new HostError("COVERAGE_OBLIGATION_REQUIRED", "coverage verify requires one unambiguous active obligation explicitly marked verification=mandate_delivery", {
		workItemId: mandate.workItemId,
		candidateIds: candidates.map((obligation) => obligation.id)
	});
	const obligation = matches[0];
	return {
		obligationId: obligation.id,
		...obligation.sourceId ? { sourceId: obligation.sourceId } : {}
	};
}
function assertRoot(actorId, rootId) {
	if (actorId !== rootId) throw new HostError("ACTOR_MISMATCH", "only the native root Lead may perform this operation");
}
async function assertReviewerReadonly(ctx, reviewerId, sinceSeq) {
	const events = await readNativeEvents(ctx, reviewerId);
	const violations = successfulMutatingEvents(sinceSeq === void 0 ? events : events.filter((event) => Number(event.seq) >= sinceSeq));
	if (violations.length) throw new HostError("REVIEWER_NOT_READONLY", "reviewer has successful mutating or unknown native tool receipts", { receipts: violations.slice(0, 20).map((item) => ({
		seq: item.seq,
		toolName: item.toolName,
		operation: item.operation
	})) });
}
async function executeSuperTool(name, ctx, repository, raw, exec) {
	const args = record(raw);
	const actorId = exec.agent?.id;
	const root = rootOf(ctx, exec.agent);
	if (!actorId) throw new HostError("TOOL_CONTEXT_UNAVAILABLE", "calling Agent has no native SessionId");
	const sessionId = root.id;
	if (name === "super_snapshot") return okValue(repository.read(sessionId), await projectRoot(ctx, repository, root, exec.signal));
	if (name === "super_run") {
		const action = stringArg(args, "action");
		if (action === "show") return okValue(repository.read(sessionId), repository.read(sessionId));
		assertRoot(actorId, sessionId);
		if (action === "create") {
			const input = {
				sessionId,
				objective: stringArg(args, "objective"),
				definitionOfDone: stringArg(args, "definitionOfDone"),
				obligations: args.obligations ?? [],
				...args.gatePolicy ? { gatePolicy: args.gatePolicy } : {}
			};
			return success(await repository.create(sessionId, input));
		}
		if (action === "recover") return success(await repository.recover(sessionId));
		return success(await repository.transact(sessionId, (core) => {
			if (action === "plan") return core.planWorkItems({
				...guardArgs(args),
				items: args.items
			});
			if (action === "pause") return core.pauseRun(guardArgs(args));
			if (action === "resume") return core.resumeRun(guardArgs(args));
			if (action === "complete") return core.completeRun(guardArgs(args));
			if (action === "replan") return core.applyUserInstruction({
				...guardArgs(args),
				runId: repository.read(sessionId)?.run.id ?? "",
				instruction: stringArg(args, "instruction"),
				obligationDelta: args.obligationDelta ?? [],
				...args.workItemRevisions !== void 0 ? { workItemRevisions: args.workItemRevisions } : {}
			});
			throw new HostError("INVALID_TRANSITION", `unknown super_run action ${action}`);
		}));
	}
	if (name === "super_anchor") {
		const action = stringArg(args, "action");
		const state = repository.read(sessionId);
		if (action === "show") return okValue(state, state?.anchors[state.run.currentAnchorId] ?? null);
		if (action === "history") return okValue(state, Object.values(state?.anchors ?? {}).sort((a, b) => a.version - b.version));
		assertRoot(actorId, sessionId);
		if (action !== "create") throw new HostError("INVALID_TRANSITION", `unknown super_anchor action ${action}`);
		return success(await repository.transact(sessionId, (core) => core.applyUserInstruction({
			...guardArgs(args),
			runId: state?.run.id ?? "",
			instruction: stringArg(args, "instruction"),
			obligationDelta: args.obligationDelta ?? []
		})));
	}
	if (name === "super_route") {
		const action = stringArg(args, "action");
		const state = repository.read(sessionId);
		assertRoot(actorId, sessionId);
		if (action === "show") return okValue(state, routePolicyView(state));
		if (action === "inspect") return okValue(state, await inspectMandateRoute(ctx, state, stringArg(args, "mandateId"), stringArg(args, "targetRole"), exec.signal));
		if (action === "set") return success(await repository.transact(sessionId, (core) => core.setModelPolicy({
			...guardArgs(args),
			policy: args.policy
		})));
		if (action === "switch") return success(await switchMandateRoute(ctx, repository, sessionId, {
			mandateId: stringArg(args, "mandateId"),
			targetRole: stringArg(args, "targetRole"),
			to: args.to,
			failureCode: stringArg(args, "failureCode"),
			reason: stringArg(args, "reason")
		}));
		throw new HostError("INVALID_TRANSITION", `unknown super_route action ${action}`);
	}
	if (name === "super_mandate") {
		const action = stringArg(args, "action");
		const state = repository.read(sessionId);
		if (action === "show") {
			const mandateId = typeof args.mandateId === "string" ? args.mandateId : void 0;
			return okValue(state, mandateId ? state?.mandates[mandateId] ?? null : Object.values(state?.mandates ?? {}));
		}
		if (action === "report") {
			const mandate = currentMandate(state, stringArg(args, "mandateId"));
			assertRouteSwitchAllowsWork(mandate);
			if (actorId !== (mandate.workerAgentId ?? mandate.workerId)) throw new HostError("ACTOR_MISMATCH", "calling native Agent is not the bound Worker");
			return success(await repository.transact(sessionId, (core) => core.reportWorkerDone({
				...guardArgs(args),
				mandateId: mandate.id,
				workerId: mandate.workerId,
				summary: stringArg(args, "summary")
			})));
		}
		assertRoot(actorId, sessionId);
		if (action === "prepare") {
			const workerAgentId = stringArg(args, "workerAgentId");
			const reviewerAgentId = stringArg(args, "reviewerAgentId");
			if (workerAgentId === sessionId || reviewerAgentId === sessionId || workerAgentId === reviewerAgentId) throw new HostError("REVIEWER_SAME_AS_WORKER", "Worker and Reviewer must be distinct native descendants, not root or aliases");
			await assertNativeMember(ctx, root, workerAgentId, exec.signal);
			await assertNativeMember(ctx, root, reviewerAgentId, exec.signal);
			return success(await repository.transact(sessionId, (core) => core.prepareMandate({
				...guardArgs(args),
				workItemId: stringArg(args, "workItemId"),
				workerId: workerAgentId,
				reviewerId: reviewerAgentId,
				knownFailures: args.knownFailures ?? [],
				...typeof args.routeReason === "string" ? { routeReason: args.routeReason } : {}
			})));
		}
		if (action === "bind") {
			const mandate = currentMandate(state, stringArg(args, "mandateId"));
			const workerAgentId = stringArg(args, "workerAgentId");
			if (workerAgentId !== mandate.workerId) throw new HostError("ACTOR_MISMATCH", "native Worker binding differs from prepared Mandate");
			await assertNativeMember(ctx, root, workerAgentId, exec.signal);
			const nativeTaskId = typeof args.nativeTaskId === "string" ? args.nativeTaskId : void 0;
			if (nativeTaskId) {
				if (!ctx.agentTeams.isEnabled(root)) throw new HostError("TEAM_DISABLED", "cannot bind a native Team task while Team is disabled");
				ctx.agentTeams.getTask(root, nativeTaskId);
			}
			return success(await repository.transact(sessionId, (core) => core.bindExecution({
				...guardArgs(args),
				mandateId: mandate.id,
				workerAgentId,
				...nativeTaskId ? { nativeTaskId } : {}
			})));
		}
		if (action === "bindReviewer") {
			const mandate = currentMandate(state, stringArg(args, "mandateId"));
			if (mandate.status !== "reported_done") throw new HostError("INVALID_TRANSITION", "Reviewer binding and wake require the current Worker to be reported_done", {
				mandateId: mandate.id,
				status: mandate.status
			});
			const reviewerAgentId = stringArg(args, "reviewerAgentId");
			if (reviewerAgentId === (mandate.workerAgentId ?? mandate.workerId)) throw new HostError("REVIEWER_SAME_AS_WORKER", "Reviewer cannot be the Worker");
			if (reviewerAgentId !== mandate.reviewerId) throw new HostError("ACTOR_MISMATCH", "this adapter binds the prepared native Reviewer; reassignment requires a new Mandate");
			await assertNativeMember(ctx, root, reviewerAgentId, exec.signal);
			const bound = await repository.transact(sessionId, (core) => core.bindReviewer({
				...guardArgs(args),
				mandateId: mandate.id,
				reviewerAgentId
			}));
			if (!bound.ok) return success(bound);
			const instruction = [
				"You are the bound native standard Reviewer. Work read-only; Lead must not review on your behalf.",
				`Mandate: ${mandate.id}; Reviewer: ${reviewerAgentId}; WorkItem: ${mandate.workItemId}; attempt: ${mandate.attempt}; generation: ${mandate.generation}; anchorVersion: ${mandate.anchorVersion}.`,
				`Acceptance: ${mandate.acceptance.join(" | ")}`,
				"Available tool declarations in your next native request: super_snapshot, super_evidence, super_review, super_run, super_anchor, super_mandate, super_route.",
				"FIRST ACTION: actually invoke super_snapshot({}) and read the returned JSON. Do not inventory, infer, or discuss tool availability before this call, and do not reply that the tools are unavailable.",
				"NEXT ACTIONS AFTER SNAPSHOT: for this exact Mandate/attempt, record or observe evidence with super_evidence, then super_review evaluate, decide, and release only when every required gate passes. If super_snapshot fails, return its real error and stop.",
				"Use only native read/sessionQuery plus super_snapshot, super_evidence and super_review for your Reviewer work. Do not write/edit files, use shell/run_code, spawn agents, or claim additional permissions.",
				`Next write starts at expectedRevision=${bound.state.run.revision}, expectedGeneration=${bound.state.run.generation}; refresh super_snapshot({}) after every committed action and use current CAS values.`,
				"Worker reported_done is not accepted. Missing/stale/unknown evidence or any write/unknown operation blocks release."
			].join("\n");
			try {
				await ctx.subagents.sendMessage(root, reviewerAgentId, [{
					type: "text",
					text: instruction
				}], { signal: exec.signal });
			} catch (error) {
				throw new HostError("REVIEWER_WAKE_FAILED", "Reviewer binding is durable, but native sendMessage failed; the Reviewer was not confirmed awake", {
					mandateId: mandate.id,
					reviewerAgentId,
					cause: error instanceof Error ? error.message : String(error)
				});
			}
			return success(bound);
		}
		throw new HostError("INVALID_TRANSITION", `unknown super_mandate action ${action}`);
	}
	if (name === "super_evidence") {
		const action = stringArg(args, "action");
		const state = repository.read(sessionId);
		if (action === "list") return okValue(state, Object.values(state?.evidence ?? {}));
		const mandate = currentMandate(state, stringArg(args, "mandateId"));
		assertRouteSwitchAllowsWork(mandate);
		const workItemId = stringArg(args, "workItemId");
		if (mandate.workItemId !== workItemId) throw new HostError("MANDATE_REQUIRED", "mandate does not belong to workItemId");
		if (action === "verify") {
			if (actorId !== sessionId && actorId !== mandate.workerAgentId && actorId !== mandate.reviewerAgentId) throw new HostError("ACTOR_MISMATCH", "mandate_delivery verify requires the root Lead or the formally bound current Worker/Reviewer");
			if (stringArg(args, "verification") !== "mandate_delivery") throw new HostError("EVIDENCE_VERIFICATION_UNSUPPORTED", "only verification=mandate_delivery is supported");
			const kind = args.kind === void 0 ? "coverage" : stringArg(args, "kind");
			if (kind !== "coverage" && kind !== "host_contract") throw new HostError("EVIDENCE_VERIFICATION_UNSUPPORTED", "mandate_delivery verify supports only kind=coverage or kind=host_contract");
			const target = kind === "coverage" ? coverageTarget(state, mandate, args) : void 0;
			const workerNativeAgentId = mandate.workerAgentId;
			if (!workerNativeAgentId) throw new HostError("ACTOR_MISMATCH", "mandate_delivery requires a formally bound current Worker");
			const workerAddresses = await nativeMemberAddresses(ctx, root, workerNativeAgentId, exec.signal);
			const [rootEvents, workerEvents] = await Promise.all([readNativeEvents(ctx, sessionId), readNativeEvents(ctx, workerNativeAgentId)]);
			const observation = verifyMandateDelivery({
				mandate,
				rootNativeAgentId: sessionId,
				workerNativeAgentId,
				workerAddresses,
				rootEvents,
				workerEvents
			});
			const input = {
				...guardArgs(args),
				workItemId,
				mandateId: mandate.id,
				attempt: mandate.attempt,
				kind,
				result: observation.result,
				sourceActor: "host",
				sourceRole: "host",
				receipt: mandateDeliveryReceipt({
					mandate,
					rootNativeAgentId: sessionId,
					workerNativeAgentId,
					kind,
					...target ? {
						obligationId: target.obligationId,
						...target.sourceId ? { sourceId: target.sourceId } : {}
					} : {},
					observation
				}),
				summary: `Host mandate_delivery ${observation.result}: ${observation.reason}; lead=${sessionId}#${observation.lead?.eventSeq ?? "missing"}; worker=${workerNativeAgentId}#${observation.worker?.eventSeq ?? "missing"}`
			};
			return success(await repository.transact(sessionId, (core) => core.recordEvidence(input)));
		}
		let input;
		if (action === "observe") {
			const observedSessionId = typeof args.sessionId === "string" ? args.sessionId : actorId;
			await assertNativeMember(ctx, root, observedSessionId, exec.signal);
			const eventSeq = args.eventSeq;
			if (typeof eventSeq !== "number") throw new HostError("EVIDENCE_EVENT_NOT_FOUND", "eventSeq is required");
			const observed = await observeNativeEvent(ctx, observedSessionId, eventSeq);
			const kind = stringArg(args, "kind");
			if (observed.facts.toolName === "super_evidence" && observed.facts.action === "verify") throw new HostError("EVIDENCE_EVENT_UNSUPPORTED", "a super_evidence verify receipt cannot be observed again as evidence");
			if (kind === "coverage" || kind === "host_contract") throw new HostError("EVIDENCE_VERIFICATION_REQUIRED", "coverage and host_contract require a dedicated trusted Host verification, not generic shell/tool result text");
			const reviewerId = mandate.reviewerAgentId;
			const violations = reviewerId && observedSessionId === reviewerId ? successfulMutatingEvents(observed.events).filter((item) => item.seq === eventSeq) : [];
			const receipt = {
				...observed.receipt,
				...violations.length ? {
					write: true,
					operation: violations[0].operation
				} : {}
			};
			input = {
				...guardArgs(args),
				workItemId,
				mandateId: mandate.id,
				attempt: mandate.attempt,
				kind,
				result: violations.length ? "fail" : resultFromNativeFacts(kind, observed.facts),
				sourceActor: "host",
				sourceRole: "host",
				receipt,
				summary: `Host observed ${observed.facts.toolName ?? "native tool"} at ${observedSessionId}#${eventSeq}`
			};
		} else if (action === "record") {
			const isWorker = mandate.workerAgentId !== void 0 && actorId === mandate.workerAgentId;
			const isReviewer = mandate.reviewerAgentId !== void 0 && actorId === mandate.reviewerAgentId;
			if (!isWorker && !isReviewer) throw new HostError("ACTOR_MISMATCH", "model evidence requires the formally bound current native Worker or Reviewer");
			const modelKind = stringArg(args, "kind");
			if (isWorker && modelKind === "coverage") throw new HostError("EVIDENCE_VERIFICATION_REQUIRED", "Worker self-reported coverage is forbidden; use an independent Reviewer or dedicated Host verification");
			if (modelKind === "host_receipt" || modelKind === "host_contract" || modelKind === "user_feedback") throw new HostError("ACTOR_MISMATCH", "host receipts/contracts and user feedback cannot be model-recorded; use their authentic source");
			const result = stringArg(args, "result");
			const receipt = sanitizeModelReceipt(args.receipt ?? {});
			if (isReviewer && (receipt.write === true || receipt.operation !== void 0 && receipt.operation !== "read")) throw new HostError("REVIEWER_NOT_READONLY", "Reviewer write/unknown operation receipt fails closed");
			input = {
				...guardArgs(args),
				workItemId,
				mandateId: mandate.id,
				attempt: mandate.attempt,
				kind: modelKind,
				result,
				sourceActor: actorId,
				sourceRole: isWorker ? "worker" : "reviewer",
				receipt,
				...typeof args.summary === "string" ? { summary: args.summary } : {}
			};
		} else throw new HostError("INVALID_TRANSITION", `unknown super_evidence action ${action}`);
		return success(await repository.transact(sessionId, (core) => core.recordEvidence(input)));
	}
	if (name === "super_review") {
		const action = stringArg(args, "action");
		const state = repository.read(sessionId);
		if (action === "evaluate") {
			const workItemId = stringArg(args, "workItemId");
			const currentId = state?.workItems[workItemId]?.currentMandateId;
			const current = currentId ? state?.mandates[currentId] : void 0;
			if (actorId !== sessionId) {
				if (!current?.reviewerAgentId || actorId !== current.reviewerAgentId) throw new HostError("ACTOR_MISMATCH", "Reviewer evaluation requires the formally bound current Reviewer");
				await assertNativeStandardReviewer(ctx, exec.agent, exec.signal);
			}
			const gate = repository.evaluate(sessionId).find((item) => item.workItemId === workItemId);
			if (!gate) throw new HostError("ITEM_NOT_FOUND", "work item does not exist");
			return okValue(state, gate);
		}
		const mandate = currentMandate(state, stringArg(args, "mandateId"));
		assertRouteSwitchAllowsWork(mandate);
		const reviewerId = mandate.reviewerAgentId;
		if (!reviewerId || actorId !== reviewerId || actorId === mandate.workerAgentId) throw new HostError("ACTOR_MISMATCH", "calling native Agent is not the independent formally bound current Reviewer");
		await assertNativeStandardReviewer(ctx, exec.agent, exec.signal);
		await assertReviewerReadonly(ctx, reviewerId);
		if (action === "decide") return success(await repository.transact(sessionId, (core) => core.submitReview({
			...guardArgs(args),
			workItemId: stringArg(args, "workItemId"),
			mandateId: mandate.id,
			attempt: mandate.attempt,
			reviewerId: mandate.reviewerId,
			result: stringArg(args, "result"),
			evidenceIds: args.evidenceIds ?? []
		})));
		if (action === "release") return success(await repository.transact(sessionId, (core) => core.releaseWorkItem({
			...guardArgs(args),
			workItemId: stringArg(args, "workItemId"),
			reviewerId: mandate.reviewerId
		})));
		throw new HostError("INVALID_TRANSITION", `unknown super_review action ${action}`);
	}
	throw new HostError("INVALID_TRANSITION", `unknown tool ${name}`);
}
function safeState(repository, ctx, exec) {
	try {
		return repository.read(rootOf(ctx, exec.agent).id);
	} catch {
		return null;
	}
}
function register(ctx, repository, name, description, parameters, readAction) {
	return ctx.tools.register(defineTool({
		name,
		description,
		parameters,
		output: TOOL_OUTPUT,
		...readAction ? { isConcurrencySafe: readAction } : {},
		execute: (async (args, exec) => {
			try {
				return await executeSuperTool(name, ctx, repository, args, exec);
			} catch (error) {
				if (error instanceof HostError) return failure(error, safeState(repository, ctx, exec));
				return failure(new HostError("HOST_CONTRACT_UNKNOWN", errorMessage(error)), safeState(repository, ctx, exec));
			}
		})
	}), { when: ({ agent, signal }) => canUseSuperTools(ctx, repository, agent, signal) });
}
function registerSuperTools(ctx, repository) {
	const disposers = [
		register(ctx, repository, "super_run", "Operate only the current native root Run. Create/show/plan/pause/resume/replan/recover/complete. Recover verifies the last native SnapshotProof before replacing quarantined state.", SUPER_TOOL_PARAMETERS.super_run, (args) => record(args).action === "show"),
		register(ctx, repository, "super_anchor", "Create/show/list versioned user-instruction anchors for the current root Run.", SUPER_TOOL_PARAMETERS.super_anchor, (args) => ["show", "history"].includes(String(record(args).action))),
		register(ctx, repository, "super_mandate", "Prepare/bind native execution and Reviewer SessionIds; bound Worker reports done. No aliases or self-reported roles. " + REVIEWER_COMPOSITION_GUIDANCE, SUPER_TOOL_PARAMETERS.super_mandate, (args) => record(args).action === "show"),
		register(ctx, repository, "super_evidence", "Record model_reported evidence, observe supported native tool facts, or verify mandate_delivery from real Lead/Worker Sessions and directly record host_observed coverage or host_contract; list current-root evidence.", SUPER_TOOL_PARAMETERS.super_evidence, (args) => record(args).action === "list"),
		register(ctx, repository, "super_review", "Bound read-only Reviewer evaluates/decides/releases the current attempt using valid evidence. " + REVIEWER_COMPOSITION_GUIDANCE, SUPER_TOOL_PARAMETERS.super_review, (args) => record(args).action === "evaluate"),
		register(ctx, repository, "super_route", "Root Lead sets/shows the Run model policy, inspects actual native child routes, or performs an authorized bounded switch. Does not create Agents or bypass model pools/permissions.", SUPER_TOOL_PARAMETERS.super_route, (args) => ["show", "inspect"].includes(String(record(args).action))),
		register(ctx, repository, "super_snapshot", "Read the current native root supervision and native execution projection.", {}, () => true)
	];
	return () => {
		for (const dispose of disposers.reverse()) dispose();
	};
}
// src/host/index.ts
const name = "dsh-superagent-ptc-host";
const inject = [
	"tools",
	"systemPrompt",
	"storageDomain",
	"subagents",
	"agentTeams",
	"goals",
	"sessionQuery",
	"agents",
	"agentPresets",
	"sessions"
];
async function apply(ctx) {
	const repository = await openRunRepository(ctx, async (state) => {
		const agent = ctx.agents.get(state.run.sessionId);
		if (!agent || ctx.subagents.rootOf(agent).id !== state.run.sessionId) return Object.values(state.mandates).filter((item) => item.status === "running").map((item) => ({
			mandateId: item.id,
			status: "unknown"
		}));
		return nativeRecoveryReader(ctx, agent)(state);
	});
	const disposeTools = registerSuperTools(ctx, repository);
	const disposePrompt = registerSuperPrompt(ctx, repository);
	const disposeGuard = ctx.tools.guard((execution) => {
		const agent = execution.agent;
		if (!agent) return void 0;
		try {
			if (!isBoundReviewer(ctx, repository, agent)) return void 0;
			const reason = reviewerToolDenial(execution.name, execution.arguments);
			return reason ? {
				reason,
				info: {
					name: execution.name,
					code: "REVIEWER_NOT_READONLY"
				}
			} : void 0;
		} catch {
			return {
				reason: "Reviewer/Run identity could not be verified; fail closed.",
				info: {
					name: execution.name,
					code: "REVIEWER_NOT_READONLY"
				}
			};
		}
	});
	registerProjectionRpc(ctx, repository);
	const disposeFailureAdapter = registerModelFailureAdapter(ctx, repository);
	ctx.effect(() => () => {
		disposeFailureAdapter();
		disposeGuard();
		disposePrompt();
		disposeTools();
	}, "super-agent:host");
}
export { apply, inject, name };
