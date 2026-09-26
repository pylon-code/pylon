import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

// Effect rc.115 dropped schema-local parseOptions propagation. Pylon pins a
// minimal compatibility patch because private provider and contract payloads
// use these annotations to reject unknown fields at every nesting level.
describe("pinned Effect schema-local parse options", () => {
  const strict = Schema.Struct({
    kind: Schema.Literal("known"),
    value: Schema.String,
  }).annotate({ parseOptions: { onExcessProperty: "error" } });
  const checkedWithoutFinalAnnotation = strict.pipe(
    Schema.check(Schema.makeFilter((value) => value.value.length > 0)),
  );
  const checked = checkedWithoutFinalAnnotation.annotate({
    parseOptions: { onExcessProperty: "error" },
  });
  const envelope = Schema.Struct({
    items: Schema.Array(Schema.Union([checked, Schema.Struct({ kind: Schema.Literal("other") })])),
  });
  const decodePermissive = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }));

  it("rejects extra keys directly and inside checked union array children", () => {
    expect(() =>
      Schema.decodeUnknownSync(strict)({ kind: "known", value: "ok", extra: true }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(envelope)({
        items: [{ kind: "known", value: "ok", extra: true }],
      }),
    ).toThrow();
    expect(Schema.decodeUnknownSync(envelope)({ items: [{ kind: "known", value: "ok" }] })).toEqual(
      { items: [{ kind: "known", value: "ok" }] },
    );
  });

  it("preserves rc.112 check annotation precedence in both directions", () => {
    const input = { kind: "known", value: "ok", extra: true };
    // A check wrapper without its own annotation overrides the base annotation
    // on decode in rc.112. Encoding still visits the annotated base schema.
    expect(Schema.decodeUnknownSync(checkedWithoutFinalAnnotation)(input)).toEqual({
      kind: "known",
      value: "ok",
    });
    expect(() => Schema.encodeUnknownSync(checkedWithoutFinalAnnotation)(input)).toThrow();
    expect(() => Schema.decodeUnknownSync(checked)(input)).toThrow();
    expect(() => Schema.encodeUnknownSync(checked)(input)).toThrow();
  });

  it("keeps strictness on encoding while unannotated objects remain permissive", () => {
    expect(() =>
      Schema.encodeUnknownSync(checked)({ kind: "known", value: "ok", extra: true }),
    ).toThrow();
    expect(
      decodePermissive({
        value: "ok",
        extra: true,
      }),
    ).toEqual({ value: "ok" });
  });
});
