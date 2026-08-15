// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap runs before an Effect runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Pylon Connect is gated on `hasCloudPublicConfig()` in
// apps/mobile/src/features/cloud/publicConfig.ts, which omits every Connect
// surface when any of these three is absent. That failure is invisible in the
// app: no error, no empty state, the section simply does not render. Asserting
// against the resolved manifest here turns a silently Connect-dark build into a
// failed job, where the cause is still visible.
const REQUIRED = [
  ["clerk.publishableKey", (extra: Extra) => extra?.clerk?.publishableKey],
  ["clerk.jwtTemplate", (extra: Extra) => extra?.clerk?.jwtTemplate],
  ["relay.url", (extra: Extra) => extra?.relay?.url],
] as const;

interface Extra {
  readonly clerk?: { readonly publishableKey?: unknown; readonly jwtTemplate?: unknown };
  readonly relay?: { readonly url?: unknown };
}

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const MOBILE_ROOT = NodePath.join(REPO_ROOT, "apps", "mobile");

// The workspace-local binary, not `pnpm exec`: `pnpm exec` reinstalls the
// workspace and re-runs the CLI under its own Node, which can be older than the
// version whose type stripping app.config.ts needs.
const EXPO_BIN = NodePath.join(MOBILE_ROOT, "node_modules", ".bin", "expo");

function readPublicManifest(): { readonly extra?: Extra } {
  const stdout = NodeChildProcess.execFileSync(EXPO_BIN, ["config", "--type", "public", "--json"], {
    cwd: MOBILE_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // `expo config` can emit progress lines before the document.
  const start = stdout.indexOf("{");
  if (start === -1) {
    throw new Error(`expo config produced no JSON document:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start));
}

const extra = readPublicManifest().extra;
const missing = REQUIRED.filter(([, read]) => {
  const value = read(extra ?? {});
  return typeof value !== "string" || value.trim() === "";
}).map(([name]) => name);

if (missing.length > 0) {
  process.stderr.write(
    `Pylon Connect config is missing from the app manifest: ${missing.join(", ")}.\n` +
      "Mobile reads these from the EAS environment. Confirm the GitHub production " +
      "environment defines CLERK_PUBLISHABLE_KEY, CLERK_JWT_TEMPLATE, and " +
      "RELAY_API_ZONE_NAME (or RELAY_DOMAIN), and that the sync step ran before this one.\n" +
      "Building now would ship an app with every Connect surface silently omitted.\n",
  );
  process.exit(1);
}

const variant = process.env.APP_VARIANT?.trim() || "production";
process.stdout.write(`Pylon Connect config present in the ${variant} app manifest.\n`);
