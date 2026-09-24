import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas.ts";

/** Driver-owned configuration for one Oh My Pi provider instance. */
export const OmpSettings = Schema.Struct({
  binaryPath: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("omp")),
    Schema.annotateKey({
      title: "Binary path",
      description: "Path to the Oh My Pi binary used by this instance.",
      providerSettingsForm: { placeholder: "omp", clearWhenEmpty: "omit" },
    }),
  ),
  profile: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({
      title: "Profile",
      description: "Oh My Pi profile to use for this instance.",
      providerSettingsForm: {
        placeholder: "e.g. work",
        clearWhenEmpty: "omit",
      },
    }),
  ),
  customModels: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
}).pipe(
  Schema.annotate({
    providerSettingsFormSchema: { order: ["binaryPath", "profile"] },
  }),
);
export type OmpSettings = typeof OmpSettings.Type;
