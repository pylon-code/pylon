import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";

const require = NodeModule.createRequire(import.meta.url);
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone repair script has no Effect runtime.
const hostPlatform = NodeOS.platform();
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone repair script has no Effect runtime.
const hostArch = NodeOS.arch();

function getPlatformPath() {
  switch (hostPlatform) {
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${hostPlatform}`);
  }
}

function ensureExecutable(filePath) {
  if (hostPlatform !== "win32") {
    NodeFS.chmodSync(filePath, 0o755);
  }
}

function repairPathFile(electronDir, platformPath) {
  const pathFile = NodePath.join(electronDir, "path.txt");
  const currentPath = NodeFS.existsSync(pathFile)
    ? NodeFS.readFileSync(pathFile, "utf8")
    : undefined;

  if (currentPath !== platformPath) {
    NodeFS.writeFileSync(pathFile, platformPath);
  }
}

function getRequiredRuntimePaths(electronDir, platformPath) {
  const paths = [NodePath.join(electronDir, "dist", platformPath)];

  if (hostPlatform === "darwin") {
    paths.push(
      NodePath.join(electronDir, "dist", "Electron.app", "Contents", "Info.plist"),
      NodePath.join(
        electronDir,
        "dist",
        "Electron.app",
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Electron Framework",
      ),
    );
  }

  return paths;
}

function isMachO(filePath) {
  if (hostPlatform !== "darwin") {
    return true;
  }

  const result = NodeChildProcess.spawnSync("file", ["-b", filePath], {
    encoding: "utf8",
  });

  return result.status === 0 && result.stdout.includes("Mach-O");
}

function missingRuntimePaths(electronDir, platformPath) {
  return getRequiredRuntimePaths(electronDir, platformPath).filter((runtimePath) => {
    return !NodeFS.existsSync(runtimePath);
  });
}

function invalidRuntimePaths(electronDir, platformPath) {
  if (hostPlatform !== "darwin") {
    return [];
  }

  return [
    NodePath.join(electronDir, "dist", platformPath),
    NodePath.join(
      electronDir,
      "dist",
      "Electron.app",
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework",
    ),
  ].filter((runtimePath) => NodeFS.existsSync(runtimePath) && !isMachO(runtimePath));
}

/**
 * Whether `dist` holds a finished install of `version`. The package installer
 * writes `path.txt` only after extracting the whole archive, and this script
 * writes it only after checking a fallback install, so a `dist` without both
 * markers is a partial extraction, such as parallel lazy installs leave behind.
 */
export function hasCompletedElectronInstall(
  electronDir,
  platformPath,
  version,
  readFile = (filePath) => NodeFS.readFileSync(filePath, "utf8"),
) {
  try {
    return (
      readFile(NodePath.join(electronDir, "path.txt")) === platformPath &&
      readDistVersion(electronDir, readFile) === version
    );
  } catch {
    return false;
  }
}

function readDistVersion(electronDir, readFile) {
  return readFile(NodePath.join(electronDir, "dist", "version"))
    .trim()
    .replace(/^v/, "");
}

function distVersionMatches(electronDir, version) {
  try {
    return (
      readDistVersion(electronDir, (filePath) => NodeFS.readFileSync(filePath, "utf8")) === version
    );
  } catch {
    return false;
  }
}

function runChecked(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    stdio: "inherit",
  });

  if (result.status === 0) {
    return;
  }

  throw new Error(
    `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`,
  );
}

/**
 * Electron 42+ ships no install script, so nothing downloads the runtime during
 * `pnpm install`. The package's own installer verifies the archive against its
 * bundled checksums and reuses the @electron/get cache.
 */
export function resolvePackagedElectronInstaller(electronDir, exists = NodeFS.existsSync) {
  const installerPath = NodePath.join(electronDir, "install.js");
  return exists(installerPath) ? installerPath : null;
}

function runPackagedElectronInstaller(installerPath) {
  const result = NodeChildProcess.spawnSync(process.execPath, [installerPath], {
    encoding: "utf8",
    stdio: "inherit",
  });
  return result.status === 0;
}

function sha256File(filePath) {
  const hash = NodeCrypto.createHash("sha256");
  const descriptor = NodeFS.openSync(filePath, "r");
  try {
    const chunk = new Uint8Array(1024 * 1024);
    let bytesRead = NodeFS.readSync(descriptor, chunk);
    while (bytesRead > 0) {
      hash.update(chunk.subarray(0, bytesRead));
      bytesRead = NodeFS.readSync(descriptor, chunk);
    }
  } finally {
    NodeFS.closeSync(descriptor);
  }
  return hash.digest("hex");
}

/**
 * Checks a downloaded archive against the SHA-256 checksums shipped inside the
 * installed electron package, never against anything fetched from the download
 * source. A missing entry fails as loudly as a mismatch.
 */
export function verifyElectronArchive(zipPath, artifactName, checksums) {
  const expected = checksums[artifactName];
  if (typeof expected !== "string") {
    throw new Error(
      `Electron's bundled checksums.json has no entry for ${artifactName}; refusing to extract an unverified download.`,
    );
  }
  const actual = sha256File(zipPath);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `${artifactName} does not match Electron's bundled checksum (expected SHA-256 ${expected}, got ${actual}); refusing to extract it.`,
    );
  }
}

// Last resort when the packaged installer is missing or fails (for example, a
// policy blocks its native unzip binding). It has no download cache, but it
// verifies the archive against the package's bundled checksums like install.js.
function installElectronRuntime(electronDir, version) {
  const artifactName = `electron-v${version}-${hostPlatform}-${hostArch}.zip`;
  const checksums = JSON.parse(
    NodeFS.readFileSync(NodePath.join(electronDir, "checksums.json"), "utf8"),
  );
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-electron-"));
  const zipPath = NodePath.join(tempDir, artifactName);

  try {
    runChecked("curl", [
      "-fsSL",
      `https://github.com/electron/electron/releases/download/v${version}/${artifactName}`,
      "-o",
      zipPath,
    ]);
    verifyElectronArchive(zipPath, artifactName, checksums);
    if (hostPlatform === "darwin") {
      runChecked("ditto", ["-x", "-k", zipPath, NodePath.join(electronDir, "dist")]);
    } else {
      runChecked("python3", [
        "-c",
        "import os, sys, zipfile; os.makedirs(sys.argv[2], exist_ok=True); zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
        zipPath,
        NodePath.join(electronDir, "dist"),
      ]);
    }
  } finally {
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function ensureElectronRuntime() {
  const electronPackageJsonPath = require.resolve("electron/package.json");
  const electronPackageJson = JSON.parse(NodeFS.readFileSync(electronPackageJsonPath, "utf8"));
  const electronDir = NodePath.dirname(electronPackageJsonPath);
  const { version } = electronPackageJson;
  const platformPath = getPlatformPath();
  const electronPath = NodePath.join(electronDir, "dist", platformPath);
  const isInstalled =
    hasCompletedElectronInstall(electronDir, platformPath, version) &&
    missingRuntimePaths(electronDir, platformPath).length === 0 &&
    invalidRuntimePaths(electronDir, platformPath).length === 0;

  if (!isInstalled) {
    if (NodeFS.existsSync(NodePath.join(electronDir, "dist"))) {
      NodeFS.rmSync(NodePath.join(electronDir, "dist"), { recursive: true, force: true });
    }
    NodeFS.rmSync(NodePath.join(electronDir, "path.txt"), { force: true });
    const installerPath = resolvePackagedElectronInstaller(electronDir);
    const installedByPackage =
      installerPath !== null &&
      runPackagedElectronInstaller(installerPath) &&
      hasCompletedElectronInstall(electronDir, platformPath, version) &&
      missingRuntimePaths(electronDir, platformPath).length === 0 &&
      invalidRuntimePaths(electronDir, platformPath).length === 0;
    if (!installedByPackage) {
      if (NodeFS.existsSync(NodePath.join(electronDir, "dist"))) {
        NodeFS.rmSync(NodePath.join(electronDir, "dist"), { recursive: true, force: true });
      }
      NodeFS.rmSync(NodePath.join(electronDir, "path.txt"), { force: true });
      installElectronRuntime(electronDir, version);
    }
  }

  const missingAfterInstall = missingRuntimePaths(electronDir, platformPath);
  const invalidAfterInstall = invalidRuntimePaths(electronDir, platformPath);
  const versionMatchesAfterInstall = distVersionMatches(electronDir, version);
  if (
    missingAfterInstall.length > 0 ||
    invalidAfterInstall.length > 0 ||
    !versionMatchesAfterInstall
  ) {
    throw new Error(
      `Electron ${version} runtime is incomplete after install.\nMissing:\n${missingAfterInstall
        .map((runtimePath) => `- ${runtimePath}`)
        .join("\n")}\nInvalid:\n${invalidAfterInstall
        .map((runtimePath) => `- ${runtimePath}`)
        .join(
          "\n",
        )}${versionMatchesAfterInstall ? "" : `\nVersion: dist/version is not ${version}`}`,
    );
  }

  ensureExecutable(electronPath);
  repairPathFile(electronDir, platformPath);

  return electronPath;
}

// `file://${argv[1]}` never matches on Windows (drive letters need `file:///C:/`).
if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const electronPath = ensureElectronRuntime();
  process.stdout.write(`${electronPath}\n`);
}
