import { err } from "@the-40-thieves/reliquary-tc-shared";
import { EMBED_BATCH, EMBED_CONCURRENCY, embedPlans } from "./embed-batches";
import { computeNotePlan } from "./note-plan";
import type { IndexVaultArgs, PlanResult } from "./types";

export type PrepareNoteArgs = Pick<
  IndexVaultArgs,
  "db" | "provider" | "vaultId" | "chunkTokens" | "embed" | "isEgressExcluded"
> & {
  path: string;
  raw: string;
  ts: number;
  enrich: boolean;
};

/** Prepare a whole note before the caller opens its write transaction. Owns no mutable state. */
export async function prepareNote(args: PrepareNoteArgs): Promise<PlanResult> {
  const result = computeNotePlan(
    args.db,
    args.vaultId,
    args.path,
    args.raw,
    args.ts,
    args.enrich,
    undefined,
    false,
    args.provider.id,
    undefined,
    args.chunkTokens,
    args.isEgressExcluded,
  );
  if (result.plan) {
    const { failed } = await embedPlans(
      args.provider,
      [result.plan],
      args.embed?.batchSize ?? EMBED_BATCH,
      args.embed?.concurrency ?? EMBED_CONCURRENCY,
      args.embed?.maxBatchTokens,
    );
    if (failed.length > 0) {
      throw err.embeddingProviderError(
        "provider rejected a single-chunk embed request (over its context?)",
        { provider: args.provider.provider, path: args.path },
      );
    }
  }
  return result;
}
