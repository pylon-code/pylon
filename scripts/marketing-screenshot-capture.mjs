// Captures the marketing hero image (apps/marketing/public/app-preview.webp)
// from a running Pylon web client seeded by marketing-screenshot-environment.ts.
//
// Full pipeline:
//   BASE=$(mktemp -d /tmp/pylon-marketing.XXXXXX)
//   vp run dev --home-dir "$BASE"                             # leave running
//   node scripts/marketing-screenshot-environment.ts "$BASE"
//   node scripts/marketing-screenshot-capture.mjs "$BASE"
//
// Pairing tokens are single-use, so this mints a fresh one per run. Never put a
// pairing URL in a committed file or a screenshot.
import { createRequire } from "node:module";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const repoRoot = NodePath.resolve(NodePath.dirname(NodeUrl.fileURLToPath(import.meta.url)), "..");

// playwright-core is a direct dependency of apps/desktop, not of the root, so
// resolve it from that package rather than guessing a pnpm store path.
const require = createRequire(NodePath.join(repoRoot, "apps/desktop/package.json"));
const { chromium } = require("playwright-core");
const sharp = createRequire(NodePath.join(repoRoot, "package.json"))("sharp");

// 1254x841 CSS at deviceScaleFactor 2 lands exactly on the 2508x1682 the hero
// <img> declares. Capturing at 1x and upscaling visibly softens the type.
const VIEWPORT = { width: 1254, height: 841 };
const DEVICE_SCALE_FACTOR = 2;
const THREAD_ID = "stream-provider-output";
const OUTPUT = NodePath.join(repoRoot, "apps/marketing/public/app-preview.webp");

const baseDir = process.argv[2];
if (!baseDir) {
  console.error("Usage: node scripts/marketing-screenshot-capture.mjs <base-dir>");
  process.exit(1);
}

const environmentId = (
  await NodeFSP.readFile(NodePath.join(baseDir, "userdata", "environment-id"), "utf8")
).trim();

const runtime = JSON.parse(
  await NodeFSP.readFile(NodePath.join(baseDir, "userdata", "server-runtime.json"), "utf8"),
);
const webOrigin = process.env.WEB_ORIGIN ?? `http://localhost:${runtime.webPort ?? 5736}`;

const { stdout } = await execFile(
  "node",
  [NodePath.join(repoRoot, "apps/server/src/bin.ts"), "pair", "--base-dir", baseDir],
  { cwd: repoRoot },
);
const token = stdout.match(/^Token:\s*(\S+)$/m)?.[1];
if (!token) throw new Error("Could not mint a pairing token.");

const browser = await chromium.launch({ channel: "chrome" });
try {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: "dark",
  });
  const page = await context.newPage();

  await page.goto(`${webOrigin}/pair#token=${token}`, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  await page.goto(`${webOrigin}/${environmentId}/${THREAD_ID}`, { waitUntil: "load" });
  await page.waitForSelector("table", { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Park the pointer off-canvas so no hover affordance is baked into the still.
  await page.mouse.move(2, 2);

  await page.addStyleTag({
    content: `
      *::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      * { caret-color: transparent !important; }
      /* Persistent table affordances that read as chrome noise mid-transcript. */
      [aria-label="Collapse table cells"],
      [aria-label="Copy table"],
      [aria-label="Copy link"] { display: none !important; }
    `,
  });

  // Release-update toasts are environment noise and must not ship in marketing.
  await page.evaluate(() => {
    const noisy = /update available|install the update/i;
    for (const element of Array.from(document.querySelectorAll("body *"))) {
      const text = element.textContent ?? "";
      if (!noisy.test(text) || text.length > 400 || element.children.length > 12) continue;
      const box = element.getBoundingClientRect();
      if (box.width > 120 && box.height > 30 && box.height < 400) {
        element.style.setProperty("display", "none", "important");
      }
    }
  });
  await page.waitForTimeout(500);

  const body = await page.evaluate(() => document.body.innerText);
  const problems = [
    [/Update Available/i, "an update toast is visible"],
    [/No provider available|Enable a provider/i, "the composer has no provider"],
    [/Stream provider output/i, "the hero thread did not render", true],
  ].flatMap(([pattern, message, expected]) =>
    pattern.test(body) === Boolean(expected) ? [] : [message],
  );
  if (problems.length > 0) throw new Error(`Refusing to write the hero: ${problems.join("; ")}.`);

  const png = await page.screenshot();
  const { width, height } = await sharp(png).metadata();
  const expectedWidth = VIEWPORT.width * DEVICE_SCALE_FACTOR;
  const expectedHeight = VIEWPORT.height * DEVICE_SCALE_FACTOR;
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`Expected ${expectedWidth}x${expectedHeight}, got ${width}x${height}.`);
  }
  await sharp(png).webp({ quality: 86 }).toFile(OUTPUT);
  console.log(`Wrote ${OUTPUT} (${width}x${height})`);
} finally {
  await browser.close();
}
