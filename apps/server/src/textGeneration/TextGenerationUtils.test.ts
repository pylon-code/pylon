import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { toJsonSchemaObject } from "./TextGenerationUtils.ts";

it("emits a closed structured-output schema with required fields", () => {
  expect(toJsonSchemaObject(Schema.Struct({ title: Schema.String }))).toEqual({
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
    additionalProperties: false,
  });
});
