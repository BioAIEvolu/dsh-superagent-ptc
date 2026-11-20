import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session-query";
import type { EvidenceKind, EvidenceResult, JsonValue } from "../core/index.ts";
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
  if (call?.arguments !== undefined) collectJsonCandidates(call.arguments, candidates);
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content.slice(0, 30)) {
      const text = asRecord(block)?.text;
      if (typeof text !== "string" || text.length > 100_000) continue;
      try { collectJsonCandidates(JSON.parse(text), candidates); } catch { /* plain tool text is not receipt JSON */ }
    }
  }
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
