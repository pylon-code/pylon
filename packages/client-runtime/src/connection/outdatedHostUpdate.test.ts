import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ExecutionEnvironmentDescriptor,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Socket from "effect/unstable/socket/Socket";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import { PrimaryConnectionTarget } from "./model.ts";
import {
  type OutdatedHostUpdatePlan,
  outdatedHostUpdateConfirmation,
  updateOutdatedHost,
} from "./outdatedHostUpdate.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as RelayEnvironmentDiscovery from "../relay/discovery.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-old"),
  label: "Build Mac",
  httpBaseUrl: "https://build.example.test",
  wsBaseUrl: "wss://build.example.test",
});

const descriptor = (protocol: number | undefined, serverVersion: string) =>
  ({
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: { os: "darwin", arch: "arm64" },
    serverVersion,
    ...(protocol === undefined ? {} : { orchestrationProtocolVersion: protocol }),
    capabilities: { repositoryIdentity: true, serverSelfUpdate: "boot-service" },
  }) satisfies ExecutionEnvironmentDescriptor;

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.Union([Schema.String, Schema.Number]),
  payload: Schema.Unknown,
  tag: Schema.String,
});
const isRpcRequest = Schema.is(RpcRequest);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeDescriptor = Schema.encodeSync(Schema.fromJsonString(ExecutionEnvironmentDescriptor));

type Listener = (event: { readonly type: string; readonly data?: unknown }) => void;

/** Answers update RPCs the way a protocol-1 server does. */
class OutdatedHostSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly requests: Array<typeof RpcRequest.Type> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  readonly url: string;
  private readonly onUpdate: () => void;

  constructor(url: string, onUpdate: () => void) {
    this.url = url;
    this.onUpdate = onUpdate;
    queueMicrotask(() => {
      this.readyState = OutdatedHostSocket.OPEN;
      this.emit({ type: "open" });
    });
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    const message = decodeJson(data);
    if (!isRpcRequest(message)) return;
    this.requests.push(message);
    if (message.tag !== WS_METHODS.serverUpdateServer) return;
    this.onUpdate();
    queueMicrotask(() =>
      this.emit({
        type: "message",
        data: encodeJson({
          _tag: "Exit",
          requestId: message.id,
          exit: {
            _tag: "Success",
            value: { targetVersion: "0.0.46", method: "boot-service", updateId: "update-1" },
          },
        }),
      }),
    );
  }

  close() {
    this.readyState = 3;
    this.emit({ type: "close" });
  }

  private emit(event: { readonly type: string; readonly data?: unknown }) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}

describe("updateOutdatedHost", () => {
  it.effect("updates a protocol-1 host over a bare socket, then switches it back on", () =>
    Effect.gen(function* () {
      const blocked = orchestrationProtocolCompatibilityError(descriptor(undefined, "0.0.45"));
      expect(blocked).toMatchObject({ serverUpdateRequired: true });

      const sockets: Array<OutdatedHostSocket> = [];
      let served: ExecutionEnvironmentDescriptor = descriptor(undefined, "0.0.45");
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(
        new Map([
          [
            TARGET.environmentId,
            {
              target: TARGET,
              profile: Option.none(),
              enabled: false,
              unsupportedReason: blocked?.message ?? "",
              serverUpdateRequired: true,
            },
          ],
        ]),
      );
      const calls: Array<string> = [];
      const registry = EnvironmentRegistry.EnvironmentRegistry.of({
        entries,
        setCompatibility: (_environmentId: EnvironmentId, error: unknown) =>
          Effect.sync(() => calls.push(`compatibility:${error === null ? "clear" : "block"}`)),
        setEnabled: (_environmentId: EnvironmentId, enabled: boolean) =>
          Effect.sync(() => calls.push(`enabled:${enabled}`)),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const resolver = ConnectionResolver.ConnectionResolver.of({
        prepare: () => Effect.die(new Error("The update must bypass the protocol gate.")),
        prepareForUpdate: () =>
          Effect.sync(() => served).pipe(
            Effect.map((current) => ({
              descriptor: current,
              prepared: {
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                httpBaseUrl: TARGET.httpBaseUrl,
                socketUrl: "wss://build.example.test/ws?wsTicket=ticket",
                httpAuthorization: null,
                target: TARGET,
              },
            })),
          ),
      });
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() =>
          HttpClientResponse.fromWeb(request, new Response(encodeDescriptor(served))),
        ),
      );

      const events: Array<string> = [];
      const result = yield* updateOutdatedHost(
        TARGET.environmentId,
        { targetVersion: "0.0.46" },
        (stage) => Effect.sync(() => events.push(`stage:${stage}`)),
        (plan) =>
          Effect.sync(() => {
            events.push(`confirm:${plan.method}:${plan.fromVersion}->${plan.targetVersion}`);
            expect(sockets).toHaveLength(0);
            return true;
          }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
            Layer.succeed(ConnectionResolver.ConnectionResolver, resolver),
            Layer.succeed(
              RelayEnvironmentDiscovery.RelayEnvironmentDiscovery,
              RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.of({
                state: yield* SubscriptionRef.make(
                  RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
                ),
                refresh: Effect.void,
              }),
            ),
            Layer.succeed(HttpClient.HttpClient, httpClient),
            Layer.succeed(Socket.WebSocketConstructor, (url) => {
              // The host relaunches on a compatible protocol once the update lands.
              const socket = new OutdatedHostSocket(url, () => {
                served = descriptor(ORCHESTRATION_PROTOCOL_VERSION, "0.0.46");
              });
              sockets.push(socket);
              return socket as unknown as globalThis.WebSocket;
            }),
          ),
        ),
      );

      expect(sockets[0]?.url).not.toContain("orchestrationProtocol");
      expect(sockets[0]?.requests.map((request) => request.tag)).toEqual([
        WS_METHODS.serverUpdateServer,
      ]);
      expect(result.targetVersion).toBe("0.0.46");
      expect(calls).toEqual(["compatibility:clear", "enabled:true"]);
      // Confirmation comes before any progress or socket.
      expect(events).toEqual([
        "confirm:boot-service:0.0.45->0.0.46",
        "stage:downloading",
        "stage:resuming",
      ]);
    }),
  );

  it.effect("refuses a host that cannot update itself without opening a socket", () =>
    Effect.gen(function* () {
      const manual = {
        ...descriptor(undefined, "0.0.45"),
        capabilities: { repositoryIdentity: true },
      };
      let opened = false;
      const error = yield* Effect.flip(
        updateOutdatedHost(
          TARGET.environmentId,
          { targetVersion: "0.0.46" },
          () => Effect.void,
          () => Effect.die(new Error("A host that cannot update itself is never confirmed.")),
        ),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              EnvironmentRegistry.EnvironmentRegistry,
              EnvironmentRegistry.EnvironmentRegistry.of({
                entries: yield* SubscriptionRef.make<
                  ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
                >(
                  new Map([
                    [
                      TARGET.environmentId,
                      { target: TARGET, profile: Option.none(), enabled: false },
                    ],
                  ]),
                ),
              } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
            ),
            Layer.succeed(
              ConnectionResolver.ConnectionResolver,
              ConnectionResolver.ConnectionResolver.of({
                prepare: () => Effect.die(new Error("unused")),
                prepareForUpdate: () =>
                  Effect.succeed({
                    descriptor: manual,
                    prepared: {
                      environmentId: TARGET.environmentId,
                      label: TARGET.label,
                      httpBaseUrl: TARGET.httpBaseUrl,
                      socketUrl: "wss://build.example.test/ws",
                      httpAuthorization: null,
                      target: TARGET,
                    },
                  }),
              }),
            ),
            Layer.succeed(
              RelayEnvironmentDiscovery.RelayEnvironmentDiscovery,
              RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.of({
                state: yield* SubscriptionRef.make(
                  RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
                ),
                refresh: Effect.void,
              }),
            ),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die(new Error("unused"))),
            ),
            Layer.succeed(Socket.WebSocketConstructor, () => {
              opened = true;
              throw new Error("unused");
            }),
          ),
        ),
      );
      expect(error).toMatchObject({ _tag: "OutdatedHostUpdateError" });
      expect(opened).toBe(false);
    }),
  );
  it.effect("asks before relaunching a desktop-managed host and sends nothing when declined", () =>
    Effect.gen(function* () {
      const desktopManaged = {
        ...descriptor(undefined, "0.0.45"),
        capabilities: {
          repositoryIdentity: true,
          serverSelfUpdate: "desktop-managed",
          desktopAppUpdate: true,
        },
      } satisfies ExecutionEnvironmentDescriptor;
      const plans: Array<OutdatedHostUpdatePlan> = [];
      const stages: Array<string> = [];
      const registryCalls: Array<string> = [];
      let opened = false;
      const exit = yield* Effect.exit(
        updateOutdatedHost(
          TARGET.environmentId,
          { targetVersion: "0.0.46" },
          (stage) => Effect.sync(() => stages.push(stage)),
          (plan) =>
            Effect.sync(() => {
              plans.push(plan);
              return false;
            }),
        ),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              EnvironmentRegistry.EnvironmentRegistry,
              EnvironmentRegistry.EnvironmentRegistry.of({
                entries: yield* SubscriptionRef.make<
                  ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
                >(
                  new Map([
                    [
                      TARGET.environmentId,
                      { target: TARGET, profile: Option.none(), enabled: false },
                    ],
                  ]),
                ),
                setCompatibility: () => Effect.sync(() => registryCalls.push("compatibility")),
                setEnabled: () => Effect.sync(() => registryCalls.push("enabled")),
              } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
            ),
            Layer.succeed(
              ConnectionResolver.ConnectionResolver,
              ConnectionResolver.ConnectionResolver.of({
                prepare: () => Effect.die(new Error("unused")),
                prepareForUpdate: () =>
                  Effect.succeed({
                    descriptor: desktopManaged,
                    prepared: {
                      environmentId: TARGET.environmentId,
                      label: TARGET.label,
                      httpBaseUrl: TARGET.httpBaseUrl,
                      socketUrl: "wss://build.example.test/ws",
                      httpAuthorization: null,
                      target: TARGET,
                    },
                  }),
              }),
            ),
            Layer.succeed(
              RelayEnvironmentDiscovery.RelayEnvironmentDiscovery,
              RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.of({
                state: yield* SubscriptionRef.make(
                  RelayEnvironmentDiscovery.EMPTY_RELAY_ENVIRONMENT_DISCOVERY_STATE,
                ),
                refresh: Effect.void,
              }),
            ),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die(new Error("unused"))),
            ),
            Layer.succeed(Socket.WebSocketConstructor, () => {
              opened = true;
              throw new Error("A declined update must not open a socket.");
            }),
          ),
        ),
      );

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(plans).toEqual([
        {
          hostLabel: "Build Mac",
          method: "desktop-managed",
          fromVersion: "0.0.45",
          targetVersion: "0.0.46",
        },
      ]);
      expect(stages).toEqual([]);
      expect(registryCalls).toEqual([]);
      expect(opened).toBe(false);
    }),
  );
});

describe("outdatedHostUpdateConfirmation", () => {
  const plan = {
    hostLabel: "Build Mac",
    fromVersion: "0.0.45",
    targetVersion: "0.0.46",
  } as const;

  it("names the desktop app relaunch for a desktop-managed host", () => {
    const message = outdatedHostUpdateConfirmation({ ...plan, method: "desktop-managed" });
    expect(message).toContain("Pylon desktop app on Build Mac");
    expect(message).toContain("close and relaunch");
    expect(message).toContain("agent sessions running there will stop");
  });

  it.each(["boot-service", "respawn"] as const)(
    "warns that running sessions stop for a %s restart",
    (method) => {
      const message = outdatedHostUpdateConfirmation({ ...plan, method });
      expect(message).toContain("Update Pylon on Build Mac to 0.0.46?");
      expect(message).toContain("agent sessions running there will stop");
      expect(message).not.toContain("desktop app");
    },
  );
});
