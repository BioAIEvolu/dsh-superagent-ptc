import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session-query";
import type { EvidenceKind, EvidenceResult, JsonValue, Mandate } from "../core/index.ts";
import { HostError as EvidenceError } from "./errors.ts";

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const nonEmpty = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 && value.length <= 2000 ? value : undefined;
const bool = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;

export interface NativeEventLike {
  type?: unknown;
  seq?: unknown;
  time?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

export interface NativeFacts {
  eventType: string;
  toolName?: string;
  isError: boolean;
  exitCode?: number;
  passed?: number;
  failed?: number;
  total?: number;
  hash?: string;
  sourceHash?: string;
  buildHash?: string;
  loadedHash?: string;
  result?: EvidenceResult;
  coverage?: string;
  obligationId?: string;
  sourceId?: string;
  operation?: string;
  activityCount?: number;
  emptyReason?: string;
  restartRequired?: boolean;
  deploymentStatus?: string;
  mode?: string;
  action?: string;
  verification?: string;
}

function toolCallName(event: NativeEventLike): { callId?: string; name?: string; arguments?: unknown } {
  const data = asRecord(event.data);
  if (event.type !== "tool/call" || !data) return {};
  return {
    callId: nonEmpty(data.callId),
    name: nonEmpty(data.name) ?? nonEmpty(data.toolName),
    arguments: data.arguments ?? data.args,
  };
}

function targetCallId(event: NativeEventLike): string | undefined {
  const data = asRecord(event.data);
  const message = asRecord(data?.message);
  const source = asRecord(message?.source);
  return nonEmpty(source?.callId) ?? nonEmpty(data?.callId);
}

function directToolName(event: NativeEventLike): string | undefined {
  const data = asRecord(event.data);
  const message = asRecord(data?.message);
  const source = asRecord(message?.source);
  return nonEmpty(data?.name) ?? nonEmpty(data?.toolName) ?? nonEmpty(source?.name) ?? nonEmpty(source?.toolName);
}

function collectJsonCandidates(value: unknown, output: RecordValue[], depth = 0): void {
  if (depth > 7) return;
  const record = asRecord(value);
  if (record) {
    output.push(record);
    for (const [key, child] of Object.entries(record)) {
      if (key === "content" || key === "body" || key === "transcript") continue;
      collectJsonCandidates(child, output, depth + 1);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 100)) collectJsonCandidates(child, output, depth + 1);
  }
}

function collectArgumentCandidates(value: unknown, output: RecordValue[]): void {
  if (typeof value === "string" && value.length <= 100_000) {
    try { collectJsonCandidates(JSON.parse(value), output); } catch { /* non-JSON arguments carry no receipt facts */ }
    return;
  }
  collectJsonCandidates(value, output);
}

function collectContentCandidates(content: unknown, output: RecordValue[]): void {
  const blocks = Array.isArray(content) ? content.slice(0, 30) : [content];
  for (const block of blocks) {
    const text = typeof block === "string" ? block : asRecord(block)?.text;
    if (typeof text !== "string" || text.length > 100_000) continue;
    try { collectJsonCandidates(JSON.parse(text), output); } catch { /* plain tool text is not receipt JSON */ }
  }
}

function first<T>(candidates: RecordValue[], keys: string[], pick: (value: unknown) => T | undefined): T | undefined {
  for (const candidate of candidates) for (const key of keys) {
    const value = pick(candidate[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Extract bounded facts from real Session events; raw content is parsed but never persisted. */
export function extractNativeFacts(events: readonly NativeEventLike[], targetSeq: number): NativeFacts {
  const target = events.find(event => event.seq === targetSeq);
  if (!target || typeof target.type !== "string") throw new EvidenceError("EVIDENCE_EVENT_NOT_FOUND", "native event seq is not readable in the requested session");
  const data = asRecord(target.data);
  const message = asRecord(data?.message);
  const calls = new Map<string, { name?: string; arguments?: unknown }>();
  for (const event of events) {
    const call = toolCallName(event);
    if (call.callId) calls.set(call.callId, { name: call.name, arguments: call.arguments });
  }
  const callId = targetCallId(target);
  const call = callId ? calls.get(callId) : undefined;
  const toolName = directToolName(target) ?? call?.name;
  const candidates: RecordValue[] = [];
  collectJsonCandidates(data, candidates);
  if (call?.arguments !== undefined) collectArgumentCandidates(call.arguments, candidates);
  collectContentCandidates(message?.content, candidates);
  if (data?.content !== message?.content) collectContentCandidates(data?.content, candidates);
  const error = data?.error !== undefined || message?.isError === true || data?.isError === true;
  const result = first(candidates, ["result"], value => value === "pass" || value === "fail" || value === "unknown" ? value : undefined);
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
    verification: first(candidates, ["verification"], nonEmpty),
  };
}

export function resultFromNativeFacts(kind: EvidenceKind, facts: NativeFacts): EvidenceResult {
  if (facts.isError || facts.result === "fail") return "fail";
  if (kind === "build") return facts.exitCode === 0 ? "pass" : facts.exitCode !== undefined ? "fail" : "unknown";
  if (kind === "unit") {
    if (facts.failed === undefined || facts.passed === undefined) return "unknown";
    if (facts.failed > 0 || (facts.total !== undefined && facts.total !== facts.passed + facts.failed)) return "fail";
    return facts.failed === 0 ? "pass" : "unknown";
  }
  if (kind === "source_hash") return (facts.sourceHash ?? facts.hash) ? "pass" : "unknown";
  if (kind === "build_hash") return (facts.buildHash ?? facts.hash) ? "pass" : "unknown";
  if (kind === "loaded_hash") return (facts.loadedHash ?? facts.hash) ? "pass" : "unknown";
  if (kind === "coverage") {
    if (facts.coverage === "partial" || facts.coverage === "substitute") return "fail";
    if (facts.coverage !== "full" || (!facts.obligationId && !facts.sourceId)) return "unknown";
    return "pass";
  }
  return facts.result ?? (kind === "host_receipt" ? "pass" : "unknown");
}

export function hostObservedReceipt(sessionId: string, seq: number, facts: NativeFacts): Record<string, JsonValue> {
  return {
    hostObserved: true,
    provenance: "host_observed",
    nativeAgentId: sessionId,
    eventSeq: seq,
    eventType: facts.eventType,
    ...(facts.toolName ? { toolName: facts.toolName } : {}),
    isError: facts.isError,
    ...(facts.exitCode !== undefined ? { exitCode: facts.exitCode } : {}),
    ...(facts.passed !== undefined ? { passed: facts.passed } : {}),
    ...(facts.failed !== undefined ? { failed: facts.failed } : {}),
    ...(facts.total !== undefined ? { total: facts.total } : {}),
    ...(facts.hash ? { hash: facts.hash } : {}),
    ...(facts.sourceHash ? { sourceHash: facts.sourceHash } : {}),
    ...(facts.buildHash ? { buildHash: facts.buildHash } : {}),
    ...(facts.loadedHash ? { loadedHash: facts.loadedHash } : {}),
    ...(facts.coverage ? { coverage: facts.coverage } : {}),
    ...(facts.obligationId ? { obligationId: facts.obligationId } : {}),
    ...(facts.sourceId ? { sourceId: facts.sourceId } : {}),
    ...(facts.operation ? { operation: facts.operation } : {}),
    ...(facts.activityCount !== undefined ? { activityCount: facts.activityCount } : {}),
    ...(facts.emptyReason ? { emptyReason: facts.emptyReason } : {}),
    ...(facts.restartRequired !== undefined ? { restartRequired: facts.restartRequired } : {}),
    ...(facts.deploymentStatus ? { deploymentStatus: facts.deploymentStatus } : {}),
    ...(facts.mode ? { mode: facts.mode } : {}),
  };
}

export interface MandateDeliveryReference {
  nativeAgentId: string;
  eventSeq: number;
  eventType: string;
  callId?: string;
  messageId?: string;
}

export interface MandateDeliveryObservation {
  result: EvidenceResult;
  reason: string;
  lead?: MandateDeliveryReference;
  worker?: MandateDeliveryReference;
}

interface LeadSendCandidate extends MandateDeliveryReference {
  target: string;
  text: string;
}
interface WorkerMessageCandidate extends MandateDeliveryReference {
  senderId?: string;
  sourceKind?: string;
  text: string;
}

function eventSeq(event: NativeEventLike): number | undefined {
  return typeof event.seq === "number" && Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : undefined;
}

function argumentRecord(value: unknown): RecordValue | undefined {
  if (typeof value === "string" && value.length <= 100_000) {
    try { return asRecord(JSON.parse(value)); } catch { return undefined; }
  }
  return asRecord(value);
}

function successfulNativeResult(data: RecordValue | undefined): boolean {
  const message = asRecord(data?.message);
  return data?.error === undefined && data?.isError !== true && message?.isError !== true;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.slice(0, 100).map(block => {
    const text = asRecord(block)?.text;
    return typeof text === "string" ? text : "";
  }).join("");
}

function agentMessageText(text: string): string {
  const marker = " sent a message: ";
  const markerAt = text.indexOf(marker);
  if (text.startsWith("Agent ") && markerAt > 6 && markerAt < 200) return text.slice(markerAt + marker.length);
  return text;
}

function currentMandateText(text: string, mandate: Mandate, workerId: string): boolean {
  if (text.includes(mandate.mandateText) || text.includes(mandate.id)) return true;
  return text.startsWith("Super Agent Mandate\n") &&
    text.includes(`\nAttempt: ${mandate.attempt}\n`) && text.includes(`\nWorker: ${workerId}\n`);
}

function validDeliveryText(text: string, mandate: Mandate): boolean {
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
export function verifyMandateDelivery(input: {
  mandate: Mandate;
  rootNativeAgentId: string;
  workerNativeAgentId: string;
  workerAddresses: ReadonlySet<string>;
  rootEvents: readonly NativeEventLike[];
  workerEvents: readonly NativeEventLike[];
}): MandateDeliveryObservation {
  const { mandate, rootNativeAgentId, workerNativeAgentId, workerAddresses } = input;
  const leadSends: LeadSendCandidate[] = [];
  const ordinaryCalls = new Map<string, { arguments?: RecordValue }>();
  for (const event of input.rootEvents) {
    if (event.type !== "tool/call") continue;
    const data = asRecord(event.data);
    const name = nonEmpty(data?.name) ?? nonEmpty(data?.toolName);
    const callId = nonEmpty(data?.callId);
    if (name === "send_message" && callId) {
      ordinaryCalls.set(callId, { arguments: argumentRecord(data?.arguments ?? data?.args) });
    }
  }
  const appendLeadSend = (eventType: string, seq: number, args: RecordValue | undefined, callId?: string): void => {
    leadSends.push({
      nativeAgentId: rootNativeAgentId,
      eventSeq: seq,
      eventType,
      ...(callId ? { callId } : {}),
      target: typeof args?.agent === "string" ? args.agent : "",
      text: typeof args?.message === "string" ? args.message : "",
    });
  };
  for (const event of input.rootEvents) {
    const seq = eventSeq(event);
    if (seq === undefined) continue;
    const data = asRecord(event.data);
    const name = nonEmpty(data?.name) ?? nonEmpty(data?.toolName);
    if (event.type === "tool/ptc-dispatch") {
      // PTC dispatch is the completed native sub-call, not a model-authored call intent.
      if (name === "send_message" && data?.isError === false && data?.error === undefined) {
        appendLeadSend(event.type, seq, argumentRecord(data?.arguments ?? data?.args),
          nonEmpty(data?.subCallId) ?? nonEmpty(data?.callId));
      }
      continue;
    }
    if (event.type !== "tool/result" || !successfulNativeResult(data)) continue;
    const message = asRecord(data?.message);
    const source = asRecord(message?.source);
    const callId = nonEmpty(source?.callId) ?? nonEmpty(data?.callId);
    const call = callId ? ordinaryCalls.get(callId) : undefined;
    if (!callId || !call) continue;
    const resultNames = [data?.name, data?.toolName, source?.name, source?.toolName]
      .map(nonEmpty).filter((value): value is string => value !== undefined);
    if (resultNames.some(resultName => resultName !== "send_message")) continue;
    appendLeadSend(event.type, seq, argumentRecord(data?.arguments ?? data?.args) ?? call.arguments, callId);
  }
  const workerMessages: WorkerMessageCandidate[] = [];
  const appendWorkerMessage = (eventType: string, seq: number, message: RecordValue | undefined): void => {
    if (!message) return;
    const source = asRecord(message.source);
    const messageId = nonEmpty(message.id);
    workerMessages.push({
      nativeAgentId: workerNativeAgentId,
      eventSeq: seq,
      eventType,
      ...(messageId ? { messageId } : {}),
      senderId: nonEmpty(source?.senderSessionId),
      sourceKind: nonEmpty(source?.kind),
      text: agentMessageText(messageText(message.content)),
    });
  };
  for (const event of input.workerEvents) {
    const seq = eventSeq(event);
    if (seq === undefined) continue;
    const data = asRecord(event.data);
    if (event.type === "agent/inbox/spliced") {
      const inserted = Array.isArray(data?.inserted) ? data.inserted : [];
      for (const entry of inserted) appendWorkerMessage(event.type, seq, asRecord(entry));
      continue;
    }
    if (event.type !== "user/message") continue;
    appendWorkerMessage(event.type, seq, asRecord(data?.message) ?? data);
  }

  const relevantLead = leadSends.filter(send =>
    currentMandateText(send.text, mandate, workerNativeAgentId) || validDeliveryText(send.text, mandate));
  const relevantWorker = workerMessages.filter(message =>
    currentMandateText(message.text, mandate, workerNativeAgentId) || validDeliveryText(message.text, mandate));
  const validLead = relevantLead.filter(send => validDeliveryText(send.text, mandate));
  const validWorker = relevantWorker.filter(message => validDeliveryText(message.text, mandate));
  let incomplete: { lead: LeadSendCandidate; worker: WorkerMessageCandidate } | undefined;
  for (const lead of validLead) {
    if (!workerAddresses.has(lead.target)) continue;
    for (const worker of validWorker) {
      if (worker.sourceKind !== "agent-message" || worker.senderId !== rootNativeAgentId || worker.text !== lead.text) continue;
      if (lead.callId && worker.messageId) {
        return { result: "pass", reason: "mandate_delivery_verified", lead, worker };
      }
      incomplete ??= { lead, worker };
    }
  }

  const wrongTarget = validLead.find(send => !workerAddresses.has(send.target));
  if (wrongTarget) {
    return { result: "fail", reason: "worker_target_mismatch", lead: wrongTarget, worker: relevantWorker[0] };
  }
  const wrongSender = validWorker.find(message => message.sourceKind !== "agent-message" || message.senderId !== rootNativeAgentId);
  if (wrongSender) {
    return { result: "fail", reason: "lead_sender_mismatch", lead: relevantLead[0], worker: wrongSender };
  }
  if (relevantLead.some(send => !validDeliveryText(send.text, mandate)) ||
      relevantWorker.some(message => !validDeliveryText(message.text, mandate))) {
    return { result: "fail", reason: "mandate_text_or_action_now_mismatch", lead: relevantLead[0], worker: relevantWorker[0] };
  }
  const rootWorkerMessages = relevantWorker.filter(message =>
    message.sourceKind === "agent-message" && message.senderId === rootNativeAgentId);
  if (relevantLead.length > 0 && rootWorkerMessages.length > 0 &&
      !relevantLead.some(lead => rootWorkerMessages.some(worker => worker.text === lead.text))) {
    return { result: "fail", reason: "lead_worker_message_mismatch", lead: relevantLead[0], worker: rootWorkerMessages[0] };
  }
  if (incomplete) {
    return { result: "unknown", reason: "native_reference_incomplete", lead: incomplete.lead, worker: incomplete.worker };
  }
  if (validLead.some(send => workerAddresses.has(send.target))) {
    return { result: "unknown", reason: "worker_receipt_missing", lead: validLead[0], worker: relevantWorker[0] };
  }
  if (validWorker.some(message => message.sourceKind === "agent-message" && message.senderId === rootNativeAgentId)) {
    return { result: "unknown", reason: "lead_send_missing", lead: relevantLead[0], worker: validWorker[0] };
  }
  return { result: "unknown", reason: "mandate_delivery_not_found", lead: relevantLead[0], worker: relevantWorker[0] };
}

export function mandateDeliveryReceipt(input: {
  mandate: Mandate;
  rootNativeAgentId: string;
  workerNativeAgentId: string;
  kind: "coverage" | "host_contract";
  obligationId?: string;
  sourceId?: string;
  observation: MandateDeliveryObservation;
}): Record<string, JsonValue> {
  const { mandate, observation } = input;
  const lead = observation.lead;
  const worker = observation.worker;
  const activityCount = (lead ? 1 : 0) + (worker ? 1 : 0);
  if (input.kind === "coverage" && !input.obligationId) {
    throw new EvidenceError("COVERAGE_OBLIGATION_REQUIRED", "coverage mandate_delivery evidence requires an obligation binding");
  }
  if (input.kind === "host_contract" && observation.result === "pass" && activityCount < 1) {
    throw new EvidenceError("HOST_CONTRACT_UNKNOWN", "host_contract pass requires real native delivery activity");
  }
  return {
    hostObserved: true,
    provenance: "host_observed",
    verification: "mandate_delivery",
    ...(input.kind === "coverage" ? {
      coverage: observation.result === "pass" ? "full" : "unknown",
      obligationId: input.obligationId!,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    } : { activityCount }),
    mandateId: mandate.id,
    attempt: mandate.attempt,
    generation: mandate.generation,
    workerId: input.workerNativeAgentId,
    operation: "verify",
    reason: observation.reason,
    nativeAgentId: input.workerNativeAgentId,
    leadNativeAgentId: input.rootNativeAgentId,
    workerNativeAgentId: input.workerNativeAgentId,
    ...(lead ? { leadEventSeq: lead.eventSeq, leadEventType: lead.eventType } : {}),
    ...(lead?.callId ? { leadCallId: lead.callId } : {}),
    ...(worker ? { workerEventSeq: worker.eventSeq, workerEventType: worker.eventType } : {}),
    ...(worker?.messageId ? { workerMessageId: worker.messageId } : {}),
  };
}

const MODEL_RECEIPT_KEYS = new Set([
  "exitCode", "passed", "failed", "total", "hash", "sourceHash", "buildHash", "loadedHash",
  "operation", "write", "coverage", "obligationId", "sourceId", "mode", "timeout", "unreadable",
  "malformed", "restartRequired", "deploymentStatus", "activityCount", "emptyReason", "actual", "expected",
  "left", "right", "delta", "scope", "artifactId", "status", "reason", "fingerprint", "violated", "observed",
]);
const SENSITIVE = /(password|passwd|secret|token|cookie|api[_-]?key|authorization|credential|private[_-]?key|body|content|transcript|source[_-]?text)/i;

export function sanitizeModelReceipt(receipt: Record<string, JsonValue>): Record<string, JsonValue> {
  const serialized = JSON.stringify(receipt);
  if (serialized.length > 8000) throw new EvidenceError("EVIDENCE_RECEIPT_INVALID", "model receipt exceeds 8000 characters");
  const clean: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(receipt)) {
    if (SENSITIVE.test(key) || !MODEL_RECEIPT_KEYS.has(key)) {
      throw new EvidenceError("EVIDENCE_RECEIPT_INVALID", "receipt key is sensitive or outside the host allowlist", { key });
    }
    clean[key] = value;
  }
  return { ...clean, hostObserved: false, provenance: "model_reported" };
}

export async function readNativeEvents(ctx: Context, sessionId: string): Promise<NativeEventLike[]> {
  const snapshot = await ctx.sessionQuery.readSession(sessionId as never);
  return snapshot.events as unknown as NativeEventLike[];
}

export async function observeNativeEvent(ctx: Context, sessionId: string, seq: number) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new EvidenceError("EVIDENCE_EVENT_NOT_FOUND", "eventSeq must be a non-negative safe integer");
  const events = await readNativeEvents(ctx, sessionId);
  const facts = extractNativeFacts(events, seq);
  if (!["tool/result", "tool/ptc-dispatch"].includes(facts.eventType)) {
    throw new EvidenceError("EVIDENCE_EVENT_UNSUPPORTED", "only native tool result or PTC dispatch events can become host-observed evidence");
  }
  return { events, facts, receipt: hostObservedReceipt(sessionId, seq, facts) };
}
