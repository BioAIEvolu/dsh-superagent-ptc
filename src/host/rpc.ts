import type { Context } from "@deepseek-ai/cordis";
import { routePath, endpointName } from "../shared/wire.ts";
import type { ProjectionRequestDto, SuperProjectionDto } from "../shared/types.ts";
import { errorMessage, HostError } from "./errors.ts";
import { rootOf } from "./native.ts";
import type { RunRepository } from "./store.ts";
import { projectRoot } from "./projection.ts";

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } };

function fail(code: string, message: string, details: Record<string, unknown> = {}): RpcResult<never> {
  return { ok: false, error: { code, message, details } };
}

export async function dispatchProjectionRpc(
  ctx: Context,
  repository: RunRepository,
  payload: unknown,
): Promise<RpcResult<SuperProjectionDto>> {
  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new HostError("BAD_REQUEST", "payload must be an object");
    const sessionId = (payload as Partial<ProjectionRequestDto>).sessionId;
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 4000) {
      throw new HostError("BAD_REQUEST", "sessionId must be an exact native root SessionId string");
    }
    const agent = ctx.agents.get(sessionId as never);
    if (!agent) throw new HostError("SESSION_UNAVAILABLE", "the exact native SessionId is not a live Agent; aliases and cold ids are not resolved");
    const root = rootOf(ctx, agent);
    if (root.id !== sessionId) throw new HostError("SESSION_NOT_ROOT", "projection requires the root SessionId, not a descendant or alias");
    repository.read(sessionId); // validates stored run.sessionId even before native composition.
    return { ok: true, value: await projectRoot(ctx, repository, root) };
  } catch (error) {
    const code = error instanceof HostError ? error.code : "SESSION_QUERY_UNAVAILABLE";
    return fail(code, errorMessage(error), error instanceof HostError && error.details ? error.details : {});
  }
}

async function serve(ctx: Context, repository: RunRepository, request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return new Response("body is not JSON", { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return new Response("invalid client-request envelope", { status: 400 });
  const message = body as Record<string, unknown>;
  const rpcId = typeof message.rpcId === "string" ? message.rpcId : undefined;
  if (!rpcId || message.method !== endpointName("projection")) {
    return new Response("invalid client-request envelope or method mismatch", { status: 400 });
  }
  const result = await dispatchProjectionRpc(ctx, repository, message.payload);
  return Response.json({ type: "server-response", rpcId, result });
}

export function registerProjectionRpc(ctx: Context, repository: RunRepository): void {
  ctx.inject(["connection"], sub => {
    const connection = sub.get("connection") as { fetch?: { register(spec: unknown): () => void } } | undefined;
    if (!connection?.fetch) return;
    const dispose = connection.fetch.register({
      path: routePath("projection"),
      methods: ["POST"],
      requestBody: "buffered",
      fetch: (request: Request) => serve(ctx, repository, request),
    });
    sub.effect(() => () => void dispose(), "super-agent:projection-rpc");
  });
}
