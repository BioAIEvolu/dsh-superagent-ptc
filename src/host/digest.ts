import { createHash } from "node:crypto";
import type { ModelPolicy, RunState, SnapshotProof } from "../core/index.ts";

/** Canonical JSON matching the durable JSON boundary: optional undefined object fields are omitted. */
export function canonicalSnapshotJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (entry: unknown): string | undefined => {
    if (entry === undefined) return undefined;
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return JSON.stringify(entry);
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new TypeError("snapshot contains a non-finite number");
      return JSON.stringify(Object.is(entry, -0) ? 0 : entry);
    }
    if (typeof entry !== "object") throw new TypeError("snapshot contains a non-JSON value");
    const object = entry as object;
    if (seen.has(object)) throw new TypeError("snapshot contains a circular reference");
    seen.add(object);
    try {
      if (Array.isArray(entry)) {
        return "[" + entry.map(item => {
          const encoded = visit(item);
          if (encoded === undefined) throw new TypeError("snapshot array contains undefined");
          return encoded;
        }).join(",") + "]";
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("snapshot contains an exotic object");
      const parts: string[] = [];
      for (const [key, child] of Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        const encoded = visit(child);
        if (encoded !== undefined) parts.push(JSON.stringify(key) + ":" + encoded);
      }
      return "{" + parts.join(",") + "}";
    } finally {
      seen.delete(object);
    }
  };
  const encoded = visit(value);
  if (encoded === undefined) throw new TypeError("snapshot root is undefined");
  return encoded;
}

export function snapshotDigest(snapshot: unknown): string {
  return createHash("sha256").update(canonicalSnapshotJson(snapshot), "utf8").digest("hex");
}

type LegacyRunState = Omit<RunState, "run" | "routeFailures"> & {
  run: Omit<RunState["run"], "modelPolicy">;
  routeFailures?: RunState["routeFailures"];
};

function withoutModelPolicy(state: RunState): LegacyRunState {
  const { modelPolicy: _currentPolicy, ...run } = state.run;
  const audit = state.audit.map(event => {
    if (!event.changes.run) return event;
    const { modelPolicy: _afterPolicy, ...runAfter } = event.changes.run;
    return { ...event, changes: { ...event.changes, run: runAfter } };
  });
  return { ...state, run, audit } as unknown as LegacyRunState;
}

function withoutEmptyRouteFailures(state: RunState | LegacyRunState): unknown {
  const { routeFailures: _routes, ...rest } = state;
  const audit = state.audit.map(event => {
    const changes = event.changes.routeFailures;
    if (!changes || Object.keys(changes).length > 0) return event;
    const { routeFailures: _changes, ...remaining } = event.changes;
    return { ...event, changes: remaining };
  });
  return { ...rest, audit };
}

/** Known v2 proof shapes differ only by routing fields' absence versus semantic defaults. */
export function snapshotVariantsForProof(state: RunState): unknown[] {
  const normalized = normalizeSnapshotForStorage(state);
  const withoutPolicy = withoutModelPolicy(normalized);
  const candidates: unknown[] = [
    normalized,
    withoutPolicy,
    withoutEmptyRouteFailures(withoutPolicy),
    withoutEmptyRouteFailures(normalized),
  ];
  const unique = new Map<string, unknown>();
  for (const candidate of candidates) unique.set(canonicalSnapshotJson(candidate), candidate);
  return [...unique.values()];
}

export function snapshotMatchingProof(
  state: RunState,
  proof: SnapshotProof,
  digest: (snapshot: unknown) => string = snapshotDigest,
): unknown | undefined {
  return snapshotVariantsForProof(state).find(candidate => digest(candidate) === proof.snapshotSha256);
}

export type StorageRunState = RunState & {
  run: RunState["run"] & { modelPolicy: ModelPolicy | null };
};

export function normalizeSnapshotForStorage(state: RunState): StorageRunState {
  const normalized = structuredClone(state) as StorageRunState;
  normalized.routeFailures ??= {};
  normalized.run.modelPolicy ??= null;
  for (const event of normalized.audit) {
    if (event.changes.run) event.changes.run.modelPolicy ??= null;
  }
  return normalized;
}

