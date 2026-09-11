import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

// Linux ships as an AppImage, so the .desktop entry users end up with is
// created by whatever integration tool they use (AppImageLauncher names it
// appimagekit_<hash>-….desktop) and its filename is not under our control.
// Electron's app.setAsDefaultProtocolClient resolves the desktop id from
// setDesktopName, which cannot match those files — so the browser keeps
// prompting "Choose an application" for every OAuth callback. Instead, write
// our own handler entry pointing at the current AppImage and claim the
// scheme default via xdg-mime, exactly what the file manager's "set as
// default" checkbox would record in mimeapps.list.
/**
 * Hidden handler entry every packaged channel wrote before the entry became the
 * per-channel portal identity (`com.pylon.code[.nightly].desktop`). Once the
 * scheme default points at the current entry it only duplicates the handler.
 */
export const LEGACY_URL_HANDLER_DESKTOP_ENTRY_NAME = "pylon-code-url-handler.desktop";

const { logInfo, logWarning } = makeComponentLogger("desktop-linux-url-handler");

export class DesktopLinuxUrlHandlerRegistrationError extends Schema.TaggedError<DesktopLinuxUrlHandlerRegistrationError>()(
  "DesktopLinuxUrlHandlerRegistrationError",
  {
    step: Schema.Literals([
      "write-desktop-entry",
      "set-default-handler",
      "remove-legacy-desktop-entry",
      "install-icon",
    ]),
    scheme: Schema.String,
    desktopEntryPath: Schema.optionalKey(Schema.String),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const exitCode = this.exitCode === undefined ? "" : `, xdg-mime exit code ${this.exitCode}`;
    return `Failed to register the ${this.scheme}:// URL handler (step: ${this.step}${exitCode}).`;
  }
}

const isRegistrationError = Schema.is(DesktopLinuxUrlHandlerRegistrationError);

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const escapeDesktopEntryString = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");

// Exec values are unescaped twice by implementations: first the general
// string-value rules, then the Exec quoting rules — so writing composes the
// layers in reverse. The argument is double-quoted with reserved characters
// backslash-escaped and literal percent signs doubled (field codes), and the
// general string escaping is applied on top: a literal backslash ends up as
// four backslashes in the file, a quote as \\", a dollar sign as \\$.
export function escapeDesktopEntryExecArgument(value: string): string {
  const quoted = value
    .replaceAll("\\", () => "\\\\")
    .replaceAll("`", () => "\\`")
    .replaceAll("$", () => "\\$")
    .replaceAll('"', () => '\\"')
    .replaceAll("%", () => "%%");
  return escapeDesktopEntryString(`"${quoted}"`);
}

/**
 * Stable copy of the app icon for the channel's desktop entry. Inside an AppImage
 * the bundled icon lives under a mount path that changes on every launch.
 */
export const resolveLinuxDesktopEntryIconPath = (input: {
  readonly dataHome: string;
  readonly desktopEntryName: string;
  readonly join: (...parts: ReadonlyArray<string>) => string;
}): string =>
  input.join(input.dataHome, input.desktopEntryName.replace(/\.desktop$/, ""), "icon.png");

// The AppImage integration entry owns the launcher. This hidden entry must not
// compete with it for StartupWMClass matching, but desktops that match a window
// by its app ID land here, so it still carries the app's name and icon.
export function renderUrlHandlerDesktopEntry(input: {
  readonly displayName: string;
  readonly execTarget: string;
  readonly scheme: string;
  readonly iconPath?: string;
}): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${escapeDesktopEntryString(input.displayName)}`,
    ...(input.iconPath === undefined ? [] : [`Icon=${escapeDesktopEntryString(input.iconPath)}`]),
    `Exec=${escapeDesktopEntryExecArgument(input.execTarget)} %U`,
    "Terminal=false",
    "NoDisplay=true",
    "StartupNotify=false",
    `MimeType=x-scheme-handler/${input.scheme};`,
    "",
  ].join("\n");
}

/** True only for the hidden scheme-handler entry Pylon generated, never a user's file. */
export function isLegacyUrlHandlerDesktopEntry(content: string, scheme: string): boolean {
  const lines = content.split("\n");
  return (
    lines[0] === "[Desktop Entry]" &&
    lines.includes("NoDisplay=true") &&
    lines.includes(`MimeType=x-scheme-handler/${scheme};`)
  );
}

export class DesktopLinuxUrlHandler extends Context.Service<
  DesktopLinuxUrlHandler,
  {
    readonly register: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopLinuxUrlHandler") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
  const desktopEntryPath = environment.path.join(
    environment.linuxApplicationsDir,
    environment.linuxDesktopEntryName,
  );

  const iconPath = resolveLinuxDesktopEntryIconPath({
    dataHome: environment.path.dirname(environment.linuxApplicationsDir),
    desktopEntryName: environment.linuxDesktopEntryName,
    join: (...parts) => environment.path.join(...parts),
  });

  const installIcon = Effect.gen(function* () {
    const source = (yield* assets.iconPaths).png;
    if (Option.isNone(source)) return;
    const icon = yield* fileSystem.readFile(source.value);
    const installed = yield* fileSystem.readFile(iconPath).pipe(Effect.orElseSucceed(() => null));
    if (installed !== null && sameBytes(installed, icon)) return;
    yield* fileSystem.makeDirectory(environment.path.dirname(iconPath), { recursive: true });
    yield* fileSystem.writeFile(iconPath, icon);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopLinuxUrlHandlerRegistrationError({
          step: "install-icon",
          scheme,
          cause,
        }),
    ),
  );

  const writeDesktopEntry = Effect.gen(function* () {
    // Inside the mounted AppImage, process.execPath points at a transient
    // /tmp/.mount_* path — the handler must launch the AppImage itself.
    const execTarget = Option.getOrElse(environment.appImagePath, () => process.execPath);
    const content = renderUrlHandlerDesktopEntry({
      displayName: environment.displayName,
      execTarget,
      scheme,
      iconPath,
    });
    // Pre-ready setup normally wrote this already. Avoid truncating a valid
    // entry while the portal may be reading it during startup.
    const existing = yield* fileSystem
      .readFileString(desktopEntryPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (existing === content) return;
    yield* fileSystem.makeDirectory(environment.linuxApplicationsDir, { recursive: true });
    yield* fileSystem.writeFileString(desktopEntryPath, content);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopLinuxUrlHandlerRegistrationError({
          step: "write-desktop-entry",
          scheme,
          desktopEntryPath,
          cause,
        }),
    ),
  );

  const setDefaultHandler = Effect.scoped(
    Effect.gen(function* () {
      const command = ChildProcess.make(
        "xdg-mime",
        ["default", environment.linuxDesktopEntryName, `x-scheme-handler/${scheme}`],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const handle = yield* spawner.spawn(command);
      const exitCode = yield* handle.exitCode;
      if ((exitCode as unknown as number) !== 0) {
        return yield* new DesktopLinuxUrlHandlerRegistrationError({
          step: "set-default-handler",
          scheme,
          exitCode: Number(exitCode),
        });
      }
    }),
  ).pipe(
    Effect.mapError((error) =>
      isRegistrationError(error)
        ? error
        : new DesktopLinuxUrlHandlerRegistrationError({
            step: "set-default-handler",
            scheme,
            cause: error,
          }),
    ),
  );

  const legacyDesktopEntryPath = environment.path.join(
    environment.linuxApplicationsDir,
    LEGACY_URL_HANDLER_DESKTOP_ENTRY_NAME,
  );
  // Runs only after the default moved to the current entry, so the scheme never
  // points at a deleted file.
  const removeLegacyDesktopEntry = Effect.gen(function* () {
    const legacy = yield* fileSystem
      .readFileString(legacyDesktopEntryPath)
      .pipe(Effect.orElseSucceed(() => null));
    if (legacy === null || !isLegacyUrlHandlerDesktopEntry(legacy, scheme)) return;
    yield* fileSystem.remove(legacyDesktopEntryPath);
    yield* logInfo("removed legacy URL scheme handler entry", {
      desktopEntryPath: legacyDesktopEntryPath,
    });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopLinuxUrlHandlerRegistrationError({
          step: "remove-legacy-desktop-entry",
          scheme,
          desktopEntryPath: legacyDesktopEntryPath,
          cause,
        }),
    ),
  );

  const register = Effect.gen(function* () {
    if (environment.platform !== "linux") {
      return;
    }
    // The icon only decorates the entry, so a failure must not block registration.
    yield* installIcon.pipe(
      Effect.catch((error) =>
        logWarning("desktop entry icon install failed", { scheme, message: error.message }),
      ),
    );
    yield* writeDesktopEntry;
    if (!environment.isPackaged) return;
    yield* setDefaultHandler;
    yield* logInfo("registered URL scheme handler", { scheme });
    yield* removeLegacyDesktopEntry;
  }).pipe(
    // Registration is best-effort: a missing xdg-mime or read-only home must
    // never block startup — the OS chooser remains as fallback.
    Effect.catch((error) =>
      logWarning("URL scheme handler registration failed", {
        scheme,
        step: error.step,
        message: error.message,
        ...(error.desktopEntryPath === undefined
          ? {}
          : { desktopEntryPath: error.desktopEntryPath }),
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
      }),
    ),
    Effect.withSpan("desktop.linuxUrlHandler.register"),
  );

  return DesktopLinuxUrlHandler.of({ register });
});

export const layer = Layer.effect(DesktopLinuxUrlHandler, make);
