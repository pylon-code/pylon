import * as NodeCrypto from "node:crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const OpenCodeConversationAnchor = Schema.Struct({
  version: Schema.Literal(1),
  providerInstanceId: Schema.String,
  sessionIncarnationId: Schema.String,
  threadId: Schema.String,
  directory: Schema.String,
  snapshotSessionId: Schema.String,
  transcriptDigest: Schema.String,
  completedTurnId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  checkpointSnapshotSessionId: Schema.optionalKey(Schema.String),
  checkpointTranscriptDigest: Schema.optionalKey(Schema.String),
  checkpointRevision: Schema.optionalKey(
    Schema.Finite.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type OpenCodeConversationAnchor = typeof OpenCodeConversationAnchor.Type;
export const decodeOpenCodeConversationAnchor = Schema.decodeUnknownOption(
  OpenCodeConversationAnchor,
);

const decodeJson = Schema.decodeUnknownOption(Schema.Json);
const isArray = (value: Schema.Json): value is ReadonlyArray<Schema.Json> => Array.isArray(value);
const record = (value: Schema.Json | undefined) =>
  typeof value === "object" && value !== null && !isArray(value) ? value : undefined;

function stableJson(value: Schema.Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`)
    .join(",")}}`;
}

/**
 * Native Session.fork changes message/part/session IDs and assistant parentID.
 * Normalize exactly those fields. Content, tool call IDs, snapshots, metadata,
 * timestamps and every unknown field remain in the proof. A parent outside the
 * retained conversation cannot be proved and therefore cannot be forked here.
 */
export function openCodeTranscriptDigest(
  input: unknown,
  expectedSessionId?: string,
): string | undefined {
  const decoded = decodeJson(input);
  if (Option.isNone(decoded) || !isArray(decoded.value)) return undefined;
  const messages = decoded.value;
  const messageIndexes = new Map<string, number>();
  let sessionId = expectedSessionId;
  for (const [index, entry] of messages.entries()) {
    const info = record(record(entry)?.info);
    if (
      !info ||
      typeof info.id !== "string" ||
      typeof info.sessionID !== "string" ||
      messageIndexes.has(info.id)
    )
      return undefined;
    sessionId ??= info.sessionID;
    if (info.sessionID !== sessionId) return undefined;
    if (info.role !== "assistant" && info.role !== "user") return undefined;
    messageIndexes.set(info.id, index);
  }
  const normalized: Schema.Json[] = [];
  for (const [index, entry] of messages.entries()) {
    const message = record(entry)!;
    const info = record(message.info)!;
    if (message.parts === undefined || !isArray(message.parts)) return undefined;
    const normalizedInfo: { [key: string]: Schema.Json } = {
      ...info,
      id: index,
      sessionID: "session",
    };
    if (info.role === "assistant" && info.parentID !== undefined) {
      if (typeof info.parentID !== "string") return undefined;
      const parent = messageIndexes.get(info.parentID);
      if (parent === undefined || parent >= index) return undefined;
      normalizedInfo.parentID = parent;
    }
    const partIds = new Set<string>();
    const normalizedParts: Schema.Json[] = [];
    for (const [partIndex, rawPart] of message.parts.entries()) {
      const part = record(rawPart);
      if (!part || typeof part.id !== "string" || partIds.has(part.id)) return undefined;
      if (part.messageID !== info.id || part.sessionID !== info.sessionID) return undefined;
      partIds.add(part.id);
      const normalizedPart: { [key: string]: Schema.Json } = {
        ...part,
        id: partIndex,
        messageID: index,
        sessionID: "session",
      };
      // OpenCode 1.18 also rewrites this retained-tail reference while forking.
      if (part.type === "compaction" && part.tail_start_id !== undefined) {
        if (typeof part.tail_start_id !== "string") return undefined;
        const tail = messageIndexes.get(part.tail_start_id);
        if (tail === undefined || tail > index) return undefined;
        normalizedPart.tail_start_id = tail;
      }
      normalizedParts.push(normalizedPart);
    }
    normalized.push({ ...message, info: normalizedInfo, parts: normalizedParts });
  }
  return NodeCrypto.createHash("sha256").update(stableJson(normalized)).digest("hex");
}
