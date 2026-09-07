import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";

const oldClient = Schema.Struct({
  source: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  windows: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
      windowDurationMins: Schema.optional(NonNegativeInt),
      resetsAt: Schema.optional(IsoDateTime),
    }),
  ),
});
const decodeOldClient = Schema.decodeUnknownSync(oldClient);
const decodeLimits = Schema.decodeUnknownSync(ServerProviderUsageLimits);
const encodeLimits = Schema.encodeSync(ServerProviderUsageLimits);

const checkedAt = "2026-09-07T12:00:00.000Z";
const legacy = {
  source: "claudeOAuth",
  checkedAt,
  windows: [{ label: "Weekly (all models)", usedPercent: 42, windowDurationMins: 10080 }],
};

describe("usage limit version compatibility", () => {
  it("keeps old Pylon windows without ids or kinds", () => {
    expect(decodeLimits(legacy)).toEqual(legacy);
  });

  it("accepts new upstream windows that do not carry provenance", () => {
    const snapshot = {
      checkedAt,
      windows: [{ id: "primary", kind: "monthly", label: "Monthly", usedPercent: 30 }],
    };
    expect(decodeLimits(snapshot)).toEqual(snapshot);
  });

  it("preserves provenance so old Pylon clients can decode extended readings", () => {
    const encoded = encodeLimits({
      ...legacy,
      windows: [{ ...legacy.windows[0]!, id: "seven_day", kind: "weekly" }],
      resetCredits: { availableCount: 1 },
    });
    expect(decodeOldClient(encoded)).toEqual(legacy);
  });

  it("keeps valid windows when a newer server adds an unknown kind", () => {
    expect(
      decodeLimits({
        ...legacy,
        windows: [
          ...legacy.windows,
          { id: "future", kind: "future", label: "Future", usedPercent: 10 },
        ],
      }).windows,
    ).toEqual(legacy.windows);
  });
});
