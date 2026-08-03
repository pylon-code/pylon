#!/usr/bin/env node

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
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

async function renderIco(master) {
  const renditions = await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await renderPng(master, size) })),
  );
  return encodePngIco(renditions);
}

async function renderIcns(macIcon) {
  const temporaryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pylon-iconset-"));
  const iconsetDirectory = NodePath.join(temporaryRoot, "Pylon.iconset");
  const outputPath = NodePath.join(temporaryRoot, "Pylon.icns");
  NodeFS.mkdirSync(iconsetDirectory);

  try {
    const slots = [
      [16, "icon_16x16.png"],
      [32, "icon_16x16@2x.png"],
      [32, "icon_32x32.png"],
      [64, "icon_32x32@2x.png"],
      [128, "icon_128x128.png"],
      [256, "icon_128x128@2x.png"],
      [256, "icon_256x256.png"],
      [512, "icon_256x256@2x.png"],
      [512, "icon_512x512.png"],
      [1024, "icon_512x512@2x.png"],
    ];
    await Promise.all(
      slots.map(async ([size, fileName]) => {
        const contents = await renderPng(macIcon, size);
        NodeFS.writeFileSync(NodePath.join(iconsetDirectory, fileName), contents);
      }),
    );
    NodeChildProcess.execFileSync("iconutil", ["-c", "icns", iconsetDirectory, "-o", outputPath]);
    return NodeFS.readFileSync(outputPath);
  } finally {
    NodeFS.rmSync(temporaryRoot, { recursive: true, force: true });
  }
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

const production = variants[2];
const productionMaster = masters.get("production");
outputs.set("apps/desktop/resources/icon.png", await renderPng(productionMaster, 512));
outputs.set("apps/desktop/resources/icon.ico", outputs.get(production.windows));
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone exporter gates macOS-only iconutil.
if (process.platform === "darwin") {
  outputs.set("apps/desktop/resources/icon.icns", await renderIcns(outputs.get(production.macos)));
}

const androidMarkSvg = NodeFS.readFileSync(
  absolutePath("apps/mobile/assets/widget/T3Mark.svg"),
  "utf8",
).replace('fill="black" mask=', 'fill="white" mask=');
const androidMark = await sharp(Buffer.from(androidMarkSvg), { density: 300 }).png().toBuffer();
outputs.set("apps/mobile/assets/android-icon-mark.png", await renderPng(androidMark, 432));
outputs.set("apps/mobile/assets/android-notification-icon.png", await renderPng(androidMark, 96));

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
