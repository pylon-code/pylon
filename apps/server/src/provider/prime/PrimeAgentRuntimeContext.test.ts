// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PrimeAgentSettings, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  bindPrimeAgentRuntimeContext,
  materializePrimeAgentIdentities,
  PRIME_AGENT_COMPAT_HOME_ENV,
  PRIME_AGENT_HOME_ENV,
  type PrimeAgentIdentityInput,
  type PrimeAgentIdentityPreparation,
} from "./PrimeAgentRuntimeContext.ts";
import { PrimeAgentOwnershipReceiptStore } from "./PrimeAgentOwnershipReceipt.ts";

const decodeSettings = Schema.decodeSync(PrimeAgentSettings);

const input = (
  id: string,
  agentHomePath: string,
  environment: PrimeAgentIdentityInput["environment"] = [],
): PrimeAgentIdentityInput => ({
  instanceId: ProviderInstanceId.make(id),
  environment,
  enabled: true,
  config: decodeSettings({ agentHomePath }),
});

const readyIdentity = (
  result: ReadonlyMap<ProviderInstanceId, PrimeAgentIdentityPreparation>,
  id: string,
) => {
  const prepared = result.get(ProviderInstanceId.make(id));
  expect(prepared?.kind).toBe("ready");
  if (prepared?.kind !== "ready") throw new Error("expected ready identity");
  return prepared.identity;
};

it.layer(NodeServices.layer)("PrimeAgentRuntimeContext", (it) => {
  it.effect("materializes one frozen exact environment with explicit-home precedence", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-context-"))),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        );
        const canonicalRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
        const explicitHome = NodePath.join(root, "explicit");
        const environmentHome = NodePath.join(root, "environment");
        yield* Effect.promise(() => NodeFSP.mkdir(explicitHome, { recursive: true }));

        const prepared = yield* materializePrimeAgentIdentities([
          input("prime-a", explicitHome, [
            { name: "HOME", value: NodePath.join(root, "first-home"), sensitive: false },
            { name: "HOME", value: NodePath.join(root, "effective-home"), sensitive: false },
            { name: PRIME_AGENT_HOME_ENV, value: environmentHome, sensitive: false },
            {
              name: PRIME_AGENT_COMPAT_HOME_ENV,
              value: NodePath.join(root, "compat"),
              sensitive: false,
            },
            { name: "PRIME_AGENT_INTERNAL_TOKEN", value: "secret-a", sensitive: false },
            { name: "rlm_depth", value: "9", sensitive: false },
            { name: "force_color", value: "1", sensitive: false },
            { name: "KEEP_ME", value: "yes", sensitive: false },
          ]),
        ]).pipe(
          Effect.provideService(HostProcessEnvironment, {
            HOME: NodePath.join(root, "host-home"),
            PRIME_AGENT_INTERNAL_ROLE: "server",
            RLM_CHILD_ID: "secret-b",
          }),
        );
        const identity = readyIdentity(prepared, "prime-a");

        const canonicalExplicitHome = NodePath.join(canonicalRoot, "explicit");
        expect(identity.effectiveHome).toBe(canonicalExplicitHome);
        expect(identity.settings.agentHomePath).toBe(canonicalExplicitHome);
        expect(identity.launchEnv).toMatchObject({
          HOME: NodePath.join(root, "effective-home"),
          KEEP_ME: "yes",
          [PRIME_AGENT_HOME_ENV]: canonicalExplicitHome,
          [PRIME_AGENT_COMPAT_HOME_ENV]: canonicalExplicitHome,
        });
        expect(
          Object.keys(identity.launchEnv).some(
            (name) =>
              name.toUpperCase().startsWith("PRIME_AGENT_INTERNAL_") ||
              name.toUpperCase().startsWith("RLM_") ||
              name.toUpperCase() === "FORCE_COLOR",
          ),
        ).toBe(false);
        expect(Object.isFrozen(identity)).toBe(true);
        expect(Object.isFrozen(identity.launchEnv)).toBe(true);
        expect(Object.isFrozen(identity.settings)).toBe(true);
        expect(Object.isFrozen(identity.settings.customModels)).toBe(true);
        const runtimeContext = bindPrimeAgentRuntimeContext(identity, {
          kind: "acp",
          fallbackCategory: "daemon-setup",
        });
        expect(Object.isFrozen(runtimeContext)).toBe(true);
        expect(Object.isFrozen(runtimeContext.backendIdentity)).toBe(true);

        const ownership = {
          store: new PrimeAgentOwnershipReceiptStore(root),
          adoptableReceipts: [],
        };
        const identityWithOwnership = { ...identity, nativeOwnership: ownership };
        const acpContext = bindPrimeAgentRuntimeContext(identityWithOwnership, { kind: "acp" });
        expect(acpContext.nativeOwnership).toBeUndefined();
        const daemonContext = bindPrimeAgentRuntimeContext(identityWithOwnership, {
          kind: "daemon",
          proof: {
            sdkFeatures: [],
            requiredServerCapabilities: [
              "caller_owned_session_environment_cleanup_v1",
              "authoritative_owned_session_cleanup_v1",
            ],
          },
        });
        expect(daemonContext.nativeOwnership).toBe(ownership);
      }),
    ),
  );

  it.effect("uses environment home and HOME-derived default without ambient fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-home-"))),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        );
        const canonicalRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
        const environmentHome = NodePath.join(root, "environment-agent");
        const effectiveOsHome = NodePath.join(root, "os-home");
        yield* Effect.promise(() =>
          Promise.all([
            NodeFSP.mkdir(environmentHome, { recursive: true }),
            NodeFSP.mkdir(effectiveOsHome, { recursive: true }),
          ]),
        );

        const prepared = yield* materializePrimeAgentIdentities([
          input("prime-env", "", [
            { name: PRIME_AGENT_COMPAT_HOME_ENV, value: environmentHome, sensitive: false },
          ]),
          input("prime-default", "", [{ name: "HOME", value: effectiveOsHome, sensitive: false }]),
          input("prime-relative", "relative/home", [
            { name: "HOME", value: effectiveOsHome, sensitive: false },
          ]),
        ]).pipe(
          Effect.provideService(HostProcessEnvironment, { HOME: NodePath.join(root, "ambient") }),
        );

        expect(readyIdentity(prepared, "prime-env").effectiveHome).toBe(
          NodePath.join(canonicalRoot, "environment-agent"),
        );
        expect(readyIdentity(prepared, "prime-default").effectiveHome).toBe(
          NodePath.join(canonicalRoot, "os-home", ".prime", "agent"),
        );
        const invalid = prepared.get(ProviderInstanceId.make("prime-relative"));
        expect(invalid?.kind).toBe("unavailable");
        if (invalid?.kind === "unavailable") {
          expect(invalid.error.detail).not.toContain("relative/home");
          expect(invalid.error.detail).not.toContain(root);
        }
      }),
    ),
  );

  it.effect("rejects every enabled participant in nested and symlink-aliased overlap groups", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "prime-overlap-"))),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        );
        const canonicalRoot = yield* Effect.promise(() => NodeFSP.realpath(root));
        const shared = NodePath.join(root, "shared");
        const alias = NodePath.join(root, "alias");
        const separate = NodePath.join(root, "separate");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(shared, { recursive: true });
          await NodeFSP.mkdir(separate, { recursive: true });
          await NodeFSP.symlink(shared, alias, "dir");
        });

        const prepared = yield* materializePrimeAgentIdentities([
          input("prime-parent", shared),
          input("prime-child", NodePath.join(shared, "nested", "future")),
          input("prime-alias", alias),
          input("prime-separate", separate),
        ]).pipe(
          Effect.provideService(HostProcessEnvironment, { HOME: root }),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        for (const id of ["prime-parent", "prime-child", "prime-alias"]) {
          const result = prepared.get(ProviderInstanceId.make(id));
          expect(result?.kind).toBe("unavailable");
          if (result?.kind === "unavailable") {
            expect(result.error.detail).toContain("distinct homes");
            expect(result.error.detail).not.toContain(root);
          }
        }
        expect(readyIdentity(prepared, "prime-separate").effectiveHome).toBe(
          NodePath.join(canonicalRoot, "separate"),
        );
      }),
    ),
  );
});
