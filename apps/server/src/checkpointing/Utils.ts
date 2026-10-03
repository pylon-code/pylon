import * as Encoding from "effect/Encoding";
import { CheckpointRef, type ThreadId } from "@t3tools/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

function checkpointRefPrefixForThread(threadId: ThreadId): string {
  return `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/`;
}

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(`${checkpointRefPrefixForThread(threadId)}turn/${turnCount}`);
}
