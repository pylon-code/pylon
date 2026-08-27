#!/usr/bin/env node

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import sharp from "sharp";

import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const checkOnly = process.argv.includes("--check");
const outputs = new Map();

const variants = [
  {
    label: "development",
    background: "assets/dev/app-icon.icon/Assets/background.svg",
    ios: "assets/dev/blueprint-ios-1024.png",
    macos: "assets/dev/blueprint-macos-1024.png",
    universal: "assets/dev/blueprint-universal-1024.png",
    windows: "assets/dev/blueprint-windows.ico",
    favicon: "assets/dev/blueprint-web-favicon.ico",
    favicon16: "assets/dev/blueprint-web-favicon-16x16.png",
    favicon32: "assets/dev/blueprint-web-favicon-32x32.png",
    appleTouch: "assets/dev/blueprint-web-apple-touch-180.png",
  },
  {
    label: "preview",
    background: "assets/nightly/app-icon.icon/Assets/background.svg",
    ios: "assets/nightly/nightly-ios-1024.png",
    macos: "assets/nightly/nightly-macos-1024.png",
    universal: "assets/nightly/nightly-universal-1024.png",
    windows: "assets/nightly/nightly-windows.ico",
    favicon: "assets/nightly/nightly-web-favicon.ico",
    favicon16: "assets/nightly/nightly-web-favicon-16x16.png",
    favicon32: "assets/nightly/nightly-web-favicon-32x32.png",
    appleTouch: "assets/nightly/nightly-web-apple-touch-180.png",
  },
  {
    label: "production",
    ios: "assets/prod/black-ios-1024.png",
    macos: "assets/prod/black-macos-1024.png",
    universal: "assets/prod/black-universal-1024.png",
    windows: "assets/prod/t3-black-windows.ico",
    favicon: "assets/prod/t3-black-web-favicon.ico",
    favicon16: "assets/prod/t3-black-web-favicon-16x16.png",
    favicon32: "assets/prod/t3-black-web-favicon-32x32.png",
    appleTouch: "assets/prod/t3-black-web-apple-touch-180.png",
  },
];

const absolutePath = (relativePath) => NodePath.join(repositoryRoot, relativePath);
const renderPng = (contents, size) =>
  sharp(contents).resize(size, size, { kernel: sharp.kernel.lanczos3 }).png().toBuffer();

async function renderVariantMaster(variant) {
  if (!variant.background) {
    return sharp(absolutePath("assets/prod/logo.svg"), { density: 300 })
      .resize(1024, 1024)
      .png()
      .toBuffer();
  }

  const background = await sharp(absolutePath(variant.background), { density: 300 })
    .resize(1024, 1024)
    .png()
    .toBuffer();
  const mark = await sharp(
    absolutePath(
      `assets/${variant.label === "preview" ? "nightly" : "dev"}/app-icon.icon/Assets/text.svg`,
    ),
    { density: 300 },
  )
    .resize(1024, 1024)
    .png()
    .toBuffer();

  return sharp(background)
    .composite([{ input: mark }])
    .png()
    .toBuffer();
}

async function renderMacIcon(master) {
  const body = await renderPng(master, 824);
  return sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: body, left: 100, top: 100 }])
    .png()
    .toBuffer();
}

// Android scales an adaptive layer to the full 108dp canvas and then lets the
// launcher mask show only the centred 72dp of it, of which just the inner 66dp
// — a circle of radius 132px on this 432px (108dp @ 4x) canvas — is guaranteed
// to survive. A full-bleed 1024px channel icon used as a layer is therefore
// zoomed and edge-cropped; an inset rendition is not.
const ANDROID_ADAPTIVE_CANVAS = 432;
const ANDROID_ADAPTIVE_SAFE_RADIUS = 132;
const ANDROID_ADAPTIVE_MARK = 352;

/**
 * Largest distance from the canvas centre at which the image is not fully
 * transparent. This is the number Android's mask cares about.
 */
async function maxOpaqueRadius(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const centreX = (info.width - 1) / 2;
  const centreY = (info.height - 1) / 2;
  let maxRadius = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] === 0) continue;
      const radius = Math.hypot(x - centreX, y - centreY);
      if (radius > maxRadius) maxRadius = radius;
    }
  }
  return maxRadius;
}

/**
 * The mark centred on a transparent 108dp canvas, small enough that the whole
 * of it survives a circular launcher mask. Serves both the adaptive foreground
 * and the Android 13+ monochrome themed layer, which is masked identically.
 */
async function renderAndroidAdaptiveLayer(mark) {
  const body = await renderPng(mark, ANDROID_ADAPTIVE_MARK);
  const inset = Math.round((ANDROID_ADAPTIVE_CANVAS - ANDROID_ADAPTIVE_MARK) / 2);
  const layer = await sharp({
    create: {
      width: ANDROID_ADAPTIVE_CANVAS,
      height: ANDROID_ADAPTIVE_CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: body, left: inset, top: inset }])
    .png()
    .toBuffer();

  // Enforced rather than documented: editing T3Mark.svg to use more of its
  // artboard would otherwise regenerate a layer the launcher clips, and
  // `icons:check` only proves the output matches the vector.
  const radius = await maxOpaqueRadius(layer);
  if (radius > ANDROID_ADAPTIVE_SAFE_RADIUS) {
    throw new Error(
      `Android adaptive layer reaches ${radius.toFixed(1)}px from centre, outside the ${ANDROID_ADAPTIVE_SAFE_RADIUS}px safe circle. Lower ANDROID_ADAPTIVE_MARK (currently ${ANDROID_ADAPTIVE_MARK}) or reduce the mark's extent in T3Mark.svg.`,
    );
  }
  return layer;
}

async function renderIco(master) {
  const renditions = await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await renderPng(master, size) })),
  );
  return encodePngIco(renditions);
}

const masters = new Map();
for (const variant of variants) {
  const master = await renderVariantMaster(variant);
  const macIcon = await renderMacIcon(master);
  const ico = await renderIco(master);
  masters.set(variant.label, master);
  outputs.set(variant.ios, master);
  outputs.set(variant.macos, macIcon);
  outputs.set(variant.universal, master);
  outputs.set(variant.windows, ico);
  outputs.set(variant.favicon, ico);
  outputs.set(variant.favicon16, await renderPng(master, 16));
  outputs.set(variant.favicon32, await renderPng(master, 32));
  outputs.set(variant.appleTouch, await renderPng(master, 180));
}

const development = variants[0];
outputs.set("apps/web/public/favicon.ico", outputs.get(development.favicon));
outputs.set("apps/web/public/favicon-16x16.png", outputs.get(development.favicon16));
outputs.set("apps/web/public/favicon-32x32.png", outputs.get(development.favicon32));
outputs.set("apps/web/public/apple-touch-icon.png", outputs.get(development.appleTouch));

// Desktop packaging and the macOS launcher both read their icons straight from
// `assets/<channel>/`, so `apps/desktop/resources/icon.*` no longer has a
// consumer and is not emitted.
const production = variants[2];
const productionMaster = masters.get("production");

const androidMarkSvg = NodeFS.readFileSync(
  absolutePath("apps/mobile/assets/widget/T3Mark.svg"),
  "utf8",
).replace('fill="black" mask=', 'fill="white" mask=');
const androidMark = await sharp(Buffer.from(androidMarkSvg), { density: 300 }).png().toBuffer();
// `android-icon-mark.png` reaches close to its canvas edges, which suits the
// notification icon (drawn unmasked at 24dp) and no Android layer that the
// launcher masks. Those get the inset rendition below instead.
outputs.set(
  "apps/mobile/assets/android-icon-mark.png",
  await renderPng(androidMark, ANDROID_ADAPTIVE_CANVAS),
);
outputs.set("apps/mobile/assets/android-notification-icon.png", await renderPng(androidMark, 96));
outputs.set(
  "apps/mobile/assets/android-icon-foreground.png",
  await renderAndroidAdaptiveLayer(androidMark),
);

outputs.set("apps/marketing/public/icon.png", productionMaster);
outputs.set(
  "apps/marketing/public/icon.webp",
  await sharp(productionMaster).webp({ lossless: true }).toBuffer(),
);
outputs.set("apps/marketing/public/favicon.ico", outputs.get(production.favicon));
outputs.set("apps/marketing/public/favicon-16x16.png", outputs.get(production.favicon16));
outputs.set("apps/marketing/public/favicon-32x32.png", outputs.get(production.favicon32));
outputs.set("apps/marketing/public/apple-touch-icon.png", outputs.get(production.appleTouch));
outputs.set(
  "apps/marketing/public/favicon-16x16.webp",
  await sharp(outputs.get(production.favicon16)).webp({ lossless: true }).toBuffer(),
);
outputs.set(
  "apps/marketing/public/favicon-32x32.webp",
  await sharp(outputs.get(production.favicon32)).webp({ lossless: true }).toBuffer(),
);
outputs.set(
  "apps/marketing/public/apple-touch-icon.webp",
  await sharp(outputs.get(production.appleTouch)).webp({ lossless: true }).toBuffer(),
);

const stale = [];
for (const [relativePath, contents] of outputs) {
  const targetPath = absolutePath(relativePath);
  if (checkOnly) {
    if (!NodeFS.existsSync(targetPath) || !NodeFS.readFileSync(targetPath).equals(contents)) {
      stale.push(relativePath);
    }
    continue;
  }
  NodeFS.mkdirSync(NodePath.dirname(targetPath), { recursive: true });
  NodeFS.writeFileSync(targetPath, contents);
}

if (stale.length > 0) {
  console.error(`Pylon brand assets are stale:\n${stale.map((file) => `- ${file}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(
    checkOnly
      ? `Pylon brand assets are current (${outputs.size} files).`
      : `Exported Pylon brand assets (${outputs.size} files).`,
  );
}
