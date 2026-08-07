import type { APIRoute } from "astro";

import { buildT3ProjectFileJsonSchema } from "@t3tools/shared/t3ProjectFile";

// Rendered at build time so t3.json files can reference it via "$schema" for
// editor/LSP support. This site serves it at /schema/t3.json, but
// T3_PROJECT_FILE_SCHEMA_URL in packages/contracts still points at
// https://t3.codes/schema/t3.json, so generated files resolve there. Moving
// that constant is a cross-package change, not a marketing one.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildT3ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
