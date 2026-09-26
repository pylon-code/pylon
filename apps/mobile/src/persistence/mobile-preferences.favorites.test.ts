import { ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { MobileDatabase } from "./mobile-database";
import { make } from "./mobile-preferences";
import { MobileSecureStorage } from "./mobile-secure-storage";

it.effect("persists favorites across a store restart while loading older preferences", () =>
  Effect.gen(function* () {
    let stored = { payload: JSON.stringify({ themeMode: "dark" }), updatedAt: 1 };
    const unused = Effect.die("Unrelated database operation");
    const database = MobileDatabase.of({
      loadCache: () => unused,
      listCache: () => unused,
      saveCache: () => unused,
      removeCache: () => unused,
      clearCacheKind: () => unused,
      clearEnvironmentCache: () => unused,
      clearAllCaches: unused,
      inspectCaches: unused,
      loadPreferencesJson: Effect.sync(() => Option.some(stored)),
      savePreferencesJson: (payload, updatedAt) =>
        Effect.sync(() => {
          stored = { payload, updatedAt };
        }),
    });
    const secureStorage = MobileSecureStorage.of({
      getItem: () => Effect.succeed(null),
      setItem: () => Effect.void,
      removeItem: () => Effect.void,
    });
    const makeStore = () =>
      make().pipe(
        Effect.provideService(MobileDatabase, database),
        Effect.provideService(MobileSecureStorage, secureStorage),
      );

    const beforeRestart = yield* makeStore();
    expect(yield* beforeRestart.load).toEqual({ themeMode: "dark" });
    const provider = ProviderInstanceId.make("codex_personal");
    yield* beforeRestart.savePatch({ modelFavorites: [{ provider, model: "gpt-6-sol" }] });
    expect(JSON.parse(stored.payload)).toEqual({
      themeMode: "dark",
      modelFavorites: [{ provider, model: "gpt-6-sol" }],
    });

    const afterRestart = yield* makeStore();
    expect(yield* afterRestart.load).toEqual({
      themeMode: "dark",
      modelFavorites: [{ provider, model: "gpt-6-sol" }],
    });

    stored = {
      payload: JSON.stringify({
        themeMode: "dark",
        modelFavorites: [
          { provider, model: "gpt-6-sol" },
          { provider: "", model: "invalid" },
          { provider, model: " " },
          { provider, model: 42 },
        ],
      }),
      updatedAt: stored.updatedAt + 1,
    };
    const sanitizedRestart = yield* makeStore();
    expect(yield* sanitizedRestart.load).toEqual({
      themeMode: "dark",
      modelFavorites: [{ provider, model: "gpt-6-sol" }],
    });
  }),
);
