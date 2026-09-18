/**
 * Test fixtures and synthetic protobuf generator for Antigravity tests.
 *
 * Placed in a separate non-test file so importing the generator into
 * `UsageService.test.ts` does not cause Vitest to register test suites twice.
 *
 * @module antigravityTestFixtures
 */

export interface SyntheticGenMetadataInput {
  readonly executionId?: string;
  readonly modelName?: string;
  readonly modelEnum?: number;
  readonly timestampSeconds?: bigint | number;
  readonly timestampNanos?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly cacheReadTokens?: number;
  readonly thinkingOutputTokens?: number;
  readonly responseOutputTokens?: number;
  readonly estimatedTokensUsed?: number;
  readonly maxContextTokens?: number;
  readonly extraFields?: ReadonlyArray<{
    readonly tag: number;
    readonly wireType: number;
    readonly value: bigint | Uint8Array;
  }>;
}

function writeVarint(value: bigint | number): Uint8Array {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) {
    v = BigInt.asUintN(64, v);
  }
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v & 0x7fn));
  return new Uint8Array(out);
}

function concatBuffers(bufs: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = bufs.reduce((sum, b) => sum + b.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of bufs) {
    out.set(b, offset);
    offset += b.length;
  }
  return out;
}

export function encodeVarintField(fieldNumber: number, value: bigint | number): Uint8Array {
  const tag = (fieldNumber << 3) | 0; // WIRE_VARINT
  const tagBytes = writeVarint(tag);
  const valBytes = writeVarint(value);
  return concatBuffers([tagBytes, valBytes]);
}

export function encodeLengthDelimited(fieldNumber: number, payload: Uint8Array): Uint8Array {
  const tag = (fieldNumber << 3) | 2; // WIRE_LENGTH_DELIMITED
  const tagBytes = writeVarint(tag);
  const lenBytes = writeVarint(payload.length);
  return concatBuffers([tagBytes, lenBytes, payload]);
}

export function encodeSyntheticGenMetadataBlob(input: SyntheticGenMetadataInput): Uint8Array {
  const chatModelParts: Uint8Array[] = [];

  if (input.modelEnum !== undefined) {
    chatModelParts.push(encodeVarintField(3, input.modelEnum));
  }
  if (input.modelName !== undefined) {
    const nameBytes = new TextEncoder().encode(input.modelName);
    chatModelParts.push(encodeLengthDelimited(19, nameBytes));
  }

  // usage: ModelUsageStats (field 4)
  const usageParts: Uint8Array[] = [];
  if (input.inputTokens !== undefined) {
    usageParts.push(encodeVarintField(2, input.inputTokens));
  }
  if (input.outputTokens !== undefined) {
    usageParts.push(encodeVarintField(3, input.outputTokens));
  }
  if (input.cacheWriteTokens !== undefined) {
    usageParts.push(encodeVarintField(4, input.cacheWriteTokens));
  }
  if (input.cacheReadTokens !== undefined) {
    usageParts.push(encodeVarintField(5, input.cacheReadTokens));
  }
  if (input.thinkingOutputTokens !== undefined) {
    usageParts.push(encodeVarintField(9, input.thinkingOutputTokens));
  }
  if (input.responseOutputTokens !== undefined) {
    usageParts.push(encodeVarintField(10, input.responseOutputTokens));
  }
  if (usageParts.length > 0) {
    chatModelParts.push(encodeLengthDelimited(4, concatBuffers(usageParts)));
  }

  // chat_start_metadata: ChatStartMetadata (field 9)
  const chatStartParts: Uint8Array[] = [];
  if (input.timestampSeconds !== undefined) {
    const tsParts: Uint8Array[] = [encodeVarintField(1, input.timestampSeconds)];
    if (input.timestampNanos !== undefined) {
      tsParts.push(encodeVarintField(2, input.timestampNanos));
    }
    chatStartParts.push(encodeLengthDelimited(4, concatBuffers(tsParts)));
  }

  if (input.maxContextTokens !== undefined || input.estimatedTokensUsed !== undefined) {
    const cwParts: Uint8Array[] = [];
    if (input.estimatedTokensUsed !== undefined) {
      cwParts.push(encodeVarintField(1, input.estimatedTokensUsed));
    }
    if (input.maxContextTokens !== undefined) {
      cwParts.push(encodeVarintField(4, input.maxContextTokens));
    }
    chatStartParts.push(encodeLengthDelimited(10, concatBuffers(cwParts)));
  }

  if (chatStartParts.length > 0) {
    chatModelParts.push(encodeLengthDelimited(9, concatBuffers(chatStartParts)));
  }

  const rootParts: Uint8Array[] = [];
  if (input.executionId !== undefined) {
    const execBytes = new TextEncoder().encode(input.executionId);
    rootParts.push(encodeLengthDelimited(4, execBytes));
  }

  if (chatModelParts.length > 0) {
    rootParts.push(encodeLengthDelimited(1, concatBuffers(chatModelParts)));
  }

  if (input.extraFields) {
    for (const extra of input.extraFields) {
      if (extra.wireType === 0) {
        rootParts.push(encodeVarintField(extra.tag, extra.value as bigint | number));
      } else if (extra.wireType === 2) {
        rootParts.push(encodeLengthDelimited(extra.tag, extra.value as Uint8Array));
      }
    }
  }

  return concatBuffers(rootParts);
}
