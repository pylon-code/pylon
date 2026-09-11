import {
  DEFAULT_CLIENT_SETTINGS,
  decodeStoredClientSettings,
  encodeStoredClientSettings,
  retainUnreadClientSettings,
  type ClientSettings,
  type QuitConfirmationMode,
  type StoredClientSettings,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const decodeClientSettingsDocument = Schema.decodeEffect(
  fromLenientJson(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeClientSettingsDocument = Schema.encodeEffect(fromLenientJson(Schema.Unknown));

export class DesktopClientSettingsReadError extends Schema.TaggedErrorClass<DesktopClientSettingsReadError>()(
  "DesktopClientSettingsReadError",
  {
    operation: Schema.Literal("read-file"),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop client settings read failed during ${this.operation} at ${this.path}.`;
  }
}

const DesktopClientSettingsWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-settings-file",
]);

export class DesktopClientSettingsWriteError extends Schema.TaggedErrorClass<DesktopClientSettingsWriteError>()(
  "DesktopClientSettingsWriteError",
  {
    operation: DesktopClientSettingsWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop client settings write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopClientSettings extends Context.Service<
  DesktopClientSettings,
  {
    readonly get: Effect.Effect<Option.Option<ClientSettings>, DesktopClientSettingsReadError>;
    readonly set: (
      settings: ClientSettings,
    ) => Effect.Effect<void, DesktopClientSettingsWriteError>;
  }
>()("@t3tools/desktop/settings/DesktopClientSettings") {}

/**
 * Storage failures fail the read so the renderer can retry without replacing
 * preferences it never saw. A document that parses but holds values this build
 * cannot decode keeps every readable setting and defaults the rest; a document
 * that is not settings JSON at all reads as no saved settings.
 */
const readClientSettings = (
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
): Effect.Effect<Option.Option<StoredClientSettings>, DesktopClientSettingsReadError> =>
  fileSystem.readFileString(settingsPath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.logWarning("Could not read desktop client settings.", cause).pipe(
              Effect.annotateLogs({ settingsPath }),
              Effect.andThen(
                Effect.fail(
                  new DesktopClientSettingsReadError({
                    operation: "read-file",
                    path: settingsPath,
                    cause,
                  }),
                ),
              ),
            ),
    }),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<StoredClientSettings>()),
        onSome: (raw) =>
          decodeClientSettingsDocument(raw).pipe(
            Effect.flatMap((document) => {
              // Legacy files wrap the settings in a `settings` key.
              const stored = decodeStoredClientSettings(
                Object.hasOwn(document, "settings") ? document.settings : document,
              );
              if (stored === null) {
                return Effect.logWarning("Could not decode desktop client settings.").pipe(
                  Effect.annotateLogs({ settingsPath }),
                  Effect.as(Option.none<StoredClientSettings>()),
                );
              }
              const unreadSettings = Object.keys(stored.unreadValues);
              return (
                unreadSettings.length === 0
                  ? Effect.void
                  : Effect.logWarning(
                      "Some desktop client settings could not be decoded; using defaults for them.",
                    ).pipe(Effect.annotateLogs({ settingsPath, unreadSettings }))
              ).pipe(Effect.as(Option.some(stored)));
            }),
            Effect.catchTags({
              SchemaError: (cause) =>
                Effect.logWarning("Could not decode desktop client settings.", cause).pipe(
                  Effect.annotateLogs({ settingsPath }),
                  Effect.as(Option.none<StoredClientSettings>()),
                ),
            }),
          ),
      }),
    ),
  );

/** Reads the quit shortcut mode, keeping the default hold when settings cannot be read. */
export const readConfirmQuit = (
  clientSettings: DesktopClientSettings["Service"],
): Effect.Effect<QuitConfirmationMode> =>
  clientSettings.get.pipe(
    Effect.map(
      Option.match({
        onNone: () => DEFAULT_CLIENT_SETTINGS.confirmQuit,
        onSome: (settings) => settings.confirmQuit,
      }),
    ),
    Effect.orElseSucceed(() => DEFAULT_CLIENT_SETTINGS.confirmQuit),
  );

const writeClientSettings = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly stored: StoredClientSettings;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopClientSettingsWriteError> {
  const directory = input.path.dirname(input.settingsPath);
  const tempPath = `${input.settingsPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeClientSettingsDocument(
    encodeStoredClientSettings(input.stored),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "encode-document",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "write-temporary-file",
          path: tempPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.rename(tempPath, input.settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopClientSettingsWriteError({
          operation: "replace-settings-file",
          path: input.settingsPath,
          cause,
        }),
    ),
  );
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  // The last read document, so writes keep values this build could not decode.
  const lastRead = yield* Ref.make<StoredClientSettings | null>(null);

  return DesktopClientSettings.of({
    get: readClientSettings(fileSystem, environment.clientSettingsPath).pipe(
      Effect.tap((stored) => Ref.set(lastRead, Option.getOrNull(stored))),
      Effect.map(Option.map((stored) => stored.settings)),
      Effect.withSpan("desktop.clientSettings.get"),
    ),
    set: (settings) =>
      Effect.gen(function* () {
        const suffix = yield* crypto.randomUUIDv4.pipe(
          Effect.map((uuid) => uuid.replace(/-/g, "")),
          Effect.mapError(
            (cause) =>
              new DesktopClientSettingsWriteError({
                operation: "create-temporary-file-name",
                path: environment.clientSettingsPath,
                cause,
              }),
          ),
        );
        const stored = retainUnreadClientSettings(settings, yield* Ref.get(lastRead));
        yield* writeClientSettings({
          fileSystem,
          path,
          settingsPath: environment.clientSettingsPath,
          stored,
          suffix,
        });
        yield* Ref.set(lastRead, stored);
      }).pipe(Effect.withSpan("desktop.clientSettings.set")),
  });
});

export const layer = Layer.effect(DesktopClientSettings, make);

export const layerTest = (initialSettings: Option.Option<ClientSettings> = Option.none()) =>
  Layer.effect(
    DesktopClientSettings,
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make(initialSettings);
      return DesktopClientSettings.of({
        get: Ref.get(settingsRef),
        set: (settings) => Ref.set(settingsRef, Option.some(settings)),
      });
    }),
  );
