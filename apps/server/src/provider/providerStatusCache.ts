import {
  type ProviderInstanceId,
  type ServerProvider,
  ServerProvider as ServerProviderSchema,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

const PrivateProviderStatusCache = Schema.Struct({
  version: Schema.Literal(1),
  configRevision: Schema.String,
  provider: ServerProviderSchema,
});
const decodeLegacyProviderStatusCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerProviderSchema),
);
const decodePrivateProviderStatusCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PrivateProviderStatusCache),
);

const mergeProviderModels = (
  fallbackModels: ReadonlyArray<ServerProvider["models"][number]>,
  cachedModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  const fallbackSlugs = new Set(fallbackModels.map((model) => model.slug));
  // The fallback snapshot is built from current settings and already carries
  // every custom model, so cached custom rows that are not in it were removed
  // while the cache was stale and must not come back.
  return [
    ...fallbackModels,
    ...cachedModels.filter((model) => !model.isCustom && !fallbackSlugs.has(model.slug)),
  ];
};

export const orderProviderSnapshots = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  [...providers].toSorted(
    (left, right) =>
      (left.displayName ?? "").localeCompare(right.displayName ?? "") ||
      left.driver.localeCompare(right.driver) ||
      left.instanceId.localeCompare(right.instanceId),
  );

export const isCachedProviderCorrelated = (input: {
  readonly cachedProvider: ServerProvider;
  readonly fallbackProvider: ServerProvider;
}): boolean =>
  input.cachedProvider.instanceId === input.fallbackProvider.instanceId &&
  input.cachedProvider.driver === input.fallbackProvider.driver;

export const hydrateCachedProvider = (input: {
  readonly cachedProvider: ServerProvider;
  readonly fallbackProvider: ServerProvider;
}): ServerProvider => {
  if (!isCachedProviderCorrelated(input)) {
    return input.fallbackProvider;
  }

  if (
    !input.fallbackProvider.enabled ||
    input.cachedProvider.enabled !== input.fallbackProvider.enabled
  ) {
    return input.fallbackProvider;
  }

  const { message: _fallbackMessage, ...fallbackWithoutMessage } = input.fallbackProvider;
  const hydratedProvider: ServerProvider = {
    ...fallbackWithoutMessage,
    models: mergeProviderModels(input.fallbackProvider.models, input.cachedProvider.models),
    installed: input.cachedProvider.installed,
    version: input.cachedProvider.version,
    status: input.cachedProvider.status,
    auth: input.cachedProvider.auth,
    checkedAt: input.cachedProvider.checkedAt,
    slashCommands: input.cachedProvider.slashCommands,
    skills: input.cachedProvider.skills,
  };

  return input.cachedProvider.message
    ? { ...hydratedProvider, message: input.cachedProvider.message }
    : hydratedProvider;
};

/**
 * Resolve the on-disk cache path for a provider instance snapshot.
 *
 * File naming: `<cacheDir>/<instanceId>.json`. For the default instance of
 * a built-in kind this equals the legacy `<kind>.json` path (because
 * `defaultInstanceIdForDriver(kind).toString() === kind`), so existing
 * cached snapshots remain readable without any rename step.
 *
 * Non-default instances (e.g. `codex_personal`) land in their own files and
 * never collide with other instances.
 *
 * Cache contents must still carry matching `instanceId` + `driver` identity
 * before hydration. The filename alone is not trusted as a routing key.
 */
export const resolveProviderStatusCachePath = Effect.fn("resolveProviderStatusCachePath")(
  function* (input: {
    readonly cacheDir: string;
    readonly instanceId: ProviderInstanceId;
  }): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    return path.join(input.cacheDir, `${input.instanceId}.json`);
  },
);

export const readProviderStatusCache = (
  filePath: string,
  options?: { readonly configRevision?: string | undefined },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return undefined;
    }

    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const expectedRevision = options?.configRevision;
    const onDecodeFailure = (cause: Cause.Cause<unknown>) =>
      Effect.logWarning("failed to parse provider status cache, ignoring", {
        path: filePath,
        errorTag: causeErrorTag(cause),
      }).pipe(Effect.as(undefined));
    if (expectedRevision === undefined) {
      return yield* decodeLegacyProviderStatusCache(trimmed).pipe(
        Effect.matchCauseEffect({
          onFailure: onDecodeFailure,
          onSuccess: Effect.succeed,
        }),
      );
    }
    const decoded = yield* decodePrivateProviderStatusCache(trimmed).pipe(
      Effect.matchCauseEffect({
        onFailure: onDecodeFailure,
        onSuccess: Effect.succeed,
      }),
    );
    return decoded?.configRevision === expectedRevision ? decoded.provider : undefined;
  });

export const writeProviderStatusCache = (input: {
  readonly filePath: string;
  readonly provider: ServerProvider;
  readonly configRevision?: string | undefined;
  readonly commitGuard?: Effect.Effect<boolean>;
}) => {
  const { updateState: _updateState, ...cacheableProvider } = input.provider;
  const contents =
    input.configRevision === undefined
      ? cacheableProvider
      : { version: 1 as const, configRevision: input.configRevision, provider: cacheableProvider };
  return writeFileStringAtomically({
    filePath: input.filePath,
    contents: `${JSON.stringify(contents, null, 2)}\n`,
    ...(input.commitGuard === undefined ? {} : { commitGuard: input.commitGuard }),
  });
};
