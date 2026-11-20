import type { Context } from "@deepseek-ai/cordis";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import type {} from "@deepseek-ai/dsh-storage-domain";
import { storedRunRecordSchema, type StoredRunRecord } from "./schema.ts";
import { hostDrivers, RunRepository, type RecoveryReader } from "./store.ts";
import { NativeSnapshotProofStore } from "./proof.ts";

export const SUPER_AGENT_STORAGE_NAME = "super_agent_mode";
export const superAgentStorageSpec = defineDomain({
  name: SUPER_AGENT_STORAGE_NAME,
  version: 1,
  layout: "single",
  tables: { runs: domainTable<string, StoredRunRecord>(storedRunRecordSchema) },
});

export async function openRunRepository(ctx: Context, recoveryReader?: RecoveryReader): Promise<RunRepository> {
  const domain = await ctx.storageDomain.open(superAgentStorageSpec);
  ctx.effect(() => () => domain.close(), "super-agent:storage");
  return new RunRepository(domain.table("runs"), hostDrivers, recoveryReader, new NativeSnapshotProofStore(ctx));
}
