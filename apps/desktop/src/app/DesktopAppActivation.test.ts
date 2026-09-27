// @effect-diagnostics nodeBuiltinImport:off -- This adapter test binds a real local socket or Windows named pipe and verifies its cleanup.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProjectId,
  ThreadId,
  type DesktopAppActivationRequest,
  type DesktopAppActivationResponse,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";

import { startDesktopAppControlServer } from "./DesktopAppActivation.ts";

const openServers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function makeTarget(stateDir: string, platform: NodeJS.Platform, userId: number | undefined) {
  return resolveDesktopAppControlAddress({
    stateDir,
    platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: NodePath.join,
  });
}

function request(requestId: string, platform: NodeJS.Platform): DesktopAppActivationRequest {
  return {
    version: 1,
    requestId,
    type: "open-workspace",
    workspaceRoot: NodePath.join(NodeOS.tmpdir(), "project"),
    platform: platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux",
  };
}

function startOkServer(
  target: ReturnType<typeof makeTarget>,
  userId: number | undefined,
  owner = "thread-1",
  testHooks?: Parameters<typeof startDesktopAppControlServer>[0]["testHooks"],
) {
  return startDesktopAppControlServer({
    ...target,
    userId,
    handle: async (input) => ({
      version: 1,
      requestId: input.requestId,
      ok: true,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make(owner),
    }),
    cancel: () => undefined,
    onReclaimError: () => undefined,
    ...(testHooks ? { testHooks } : {}),
  }).then((server) => {
    openServers.push(server);
    return server;
  });
}

function exchange(address: string, payload: DesktopAppActivationRequest) {
  return new Promise<DesktopAppActivationResponse>((resolve, reject) => {
    const socket = NodeNet.createConnection(address);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as DesktopAppActivationResponse);
    });
  });
}

describe("desktop app control server", () => {
  it.effect("roundtrips a request and removes its socket on shutdown", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-control-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const received: DesktopAppActivationRequest[] = [];
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: async (input) => {
            received.push(input);
            return {
              version: 1,
              requestId: input.requestId,
              ok: true,
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            };
          },
          cancel: () => undefined,
          onReclaimError: () => undefined,
        });
        openServers.push(server);

        const response = await exchange(target.address, request("request-1", platform));

        expect(received).toHaveLength(1);
        expect(response).toMatchObject({ ok: true, requestId: "request-1" });
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        if (target.directory !== null) {
          await expect(NodeFSP.stat(target.address)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("cancels a queued request when the client disconnects", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-cancel-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        let resolveCanceled: (requestId: string) => void = () => undefined;
        const canceled = new Promise<string>((resolve) => {
          resolveCanceled = resolve;
        });
        const server = await startDesktopAppControlServer({
          ...target,
          userId,
          handle: () => new Promise(() => undefined),
          cancel: resolveCanceled,
          onReclaimError: () => undefined,
        });
        openServers.push(server);
        const socket = NodeNet.createConnection(target.address);
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.write(`${JSON.stringify(request("request-canceled", platform))}\n`, () => {
              socket.destroy();
              resolve();
            });
          });
        });

        await expect(canceled).resolves.toBe("request-canceled");
        await server.close();
        openServers.splice(openServers.indexOf(server), 1);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  // Two desktop apps can share one state dir, such as nightly and a preview build.
  it.effect("keeps a newer app's socket when an older app on the same state dir quits", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-takeover-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const older = await startOkServer(target, userId, "older");
        await expect(exchange(target.address, request("first", platform))).resolves.toMatchObject({
          ok: true,
          threadId: "older",
        });
        await startOkServer(target, userId, "newer");
        await expect(exchange(target.address, request("second", platform))).resolves.toMatchObject({
          ok: true,
          threadId: "newer",
        });

        await older.close();

        await expect(
          exchange(target.address, request("after-quit", platform)),
        ).resolves.toMatchObject({ ok: true, requestId: "after-quit", threadId: "newer" });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("binds its address again after the socket file is removed", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-reclaim-test-"));
        const target = makeTarget(NodePath.join(root, "userdata"), platform, userId);
        const server = await startOkServer(target, userId);

        await NodeFSP.unlink(target.address);
        await server.reclaim();

        await expect(
          exchange(target.address, request("reclaimed", platform)),
        ).resolves.toMatchObject({
          ok: true,
          requestId: "reclaimed",
        });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("restores an older app after the newer app's socket disappears", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "pylon-app-reclaim-test-"),
        );
        const target = { address: NodePath.join(root, "control.sock"), directory: root };
        const older = await startOkServer(target, userId, "older");
        const newer = await startOkServer(target, userId, "newer");

        // A crash can leave the newer process alive briefly while the socket
        // path disappears. The older app can reclaim the free address.
        await NodeFSP.unlink(target.address);
        await older.reclaim();
        await expect(
          exchange(target.address, request("recovered", platform)),
        ).resolves.toMatchObject({
          ok: true,
          threadId: "older",
        });
        await newer.close();
        await expect(
          exchange(target.address, request("still-owned", platform)),
        ).resolves.toMatchObject({
          ok: true,
          threadId: "older",
        });
        await older.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("reclaims the address when the newer app exits", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-app-watch-test-"));
        const target = { address: NodePath.join(root, "control.sock"), directory: root };
        const older = await startOkServer(target, userId, "older");
        const newer = await startOkServer(target, userId, "newer");
        const recovered = new Promise<DesktopAppActivationResponse>((resolve, reject) => {
          const watcher = NodeFS.watch(root, () => {
            void exchange(target.address, request("automatic-reclaim", platform)).then(
              (response) => {
                if (response.ok && response.threadId === "older") {
                  watcher.close();
                  clearTimeout(timeout);
                  resolve(response);
                }
              },
              () => undefined,
            );
          });
          // @effect-diagnostics-next-line globalTimers:off -- Fails the event-driven watcher test if no recovery event arrives.
          const timeout = setTimeout(() => {
            watcher.close();
            reject(new Error("The older app did not reclaim the control socket."));
          }, 3_000);
        });

        await newer.close();
        await expect(recovered).resolves.toMatchObject({ ok: true, threadId: "older" });
        await older.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("removes its staging socket when startup takeover fails", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-app-start-test-"));
        const target = { address: NodePath.join(root, "control.sock"), directory: root };
        await NodeFSP.mkdir(target.address);
        await expect(startOkServer(target, userId)).rejects.toBeDefined();
        expect(await NodeFSP.readdir(root)).toEqual(["control.sock"]);
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("serializes an older app's checked close with a newer takeover", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-app-race-test-"));
        const target = { address: NodePath.join(root, "control.sock"), directory: root };
        let reachedOwnedStat: () => void = () => undefined;
        const ownedStatReached = new Promise<void>((resolve) => {
          reachedOwnedStat = resolve;
        });
        let resumeClose: () => void = () => undefined;
        const closeCanResume = new Promise<void>((resolve) => {
          resumeClose = resolve;
        });
        const older = await startOkServer(target, userId, "older", {
          afterOwnedCloseStat: () => {
            reachedOwnedStat();
            return closeCanResume;
          },
        });

        const closing = older.close();
        await ownedStatReached;
        // The old listening socket must still pin its inode through this check.
        await expect(
          new Promise<void>((resolve, reject) => {
            const socket = NodeNet.createConnection(target.address);
            socket.once("connect", () => {
              socket.destroy();
              resolve();
            });
            socket.once("error", reject);
          }),
        ).resolves.toBeUndefined();
        let reachedTakeover: () => void = () => undefined;
        const takeoverReached = new Promise<void>((resolve) => {
          reachedTakeover = resolve;
        });
        const startingNewer = startOkServer(target, userId, "newer", {
          beforeTakeoverLock: reachedTakeover,
        });
        await takeoverReached;
        let timeout: NodeJS.Timeout | undefined;
        const blocked = await Promise.race([
          startingNewer.then(() => false),
          new Promise<boolean>((resolve) => {
            // @effect-diagnostics-next-line globalTimers:off -- Bounds the negative concurrency assertion.
            timeout = setTimeout(() => resolve(true), 250);
          }),
        ]).finally(() => {
          clearTimeout(timeout);
          resumeClose();
        });
        expect(blocked).toBe(true);
        await closing;
        const newer = await startingNewer;
        await expect(
          exchange(target.address, request("after-race", platform)),
        ).resolves.toMatchObject({
          ok: true,
          threadId: "newer",
        });
        await newer.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("aborts checked unlink when its ownership lock disappears", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-app-lock-loss-"));
        const target = { address: NodePath.join(root, "control.sock"), directory: root };
        let reachedOwnedStat: () => void = () => undefined;
        const ownedStatReached = new Promise<void>((resolve) => {
          reachedOwnedStat = resolve;
        });
        let resumeClose: () => void = () => undefined;
        const closeCanResume = new Promise<void>((resolve) => {
          resumeClose = resolve;
        });
        const older = await startOkServer(target, userId, "older", {
          afterOwnedCloseStat: () => {
            reachedOwnedStat();
            return closeCanResume;
          },
        });
        const closing = older.close();
        await ownedStatReached;
        await NodeFSP.rmdir(`${target.address}.lock`);
        const newer = await startOkServer(target, userId, "newer");
        resumeClose();
        await expect(closing).rejects.toThrow("Lost ownership");
        await expect(
          exchange(target.address, request("after-lock-loss", platform)),
        ).resolves.toMatchObject({ ok: true, threadId: "newer" });
        await newer.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );

  it.effect("recovers a stale ownership lock after a prior app crash", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const userId = yield* HostProcessUserId;
      if (platform === "win32") return;
      yield* Effect.promise(async () => {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pylon-app-stale-test-"));
        const target = { address: NodePath.join(root, "control.sock"), directory: root };
        const staleLock = `${target.address}.lock`;
        await NodeFSP.mkdir(staleLock);
        await NodeFSP.utimes(staleLock, 0, 0);

        const server = await startOkServer(target, userId);
        await expect(
          exchange(target.address, request("after-crash", platform)),
        ).resolves.toMatchObject({
          ok: true,
          requestId: "after-crash",
        });
        await server.close();
        await expect(NodeFSP.stat(staleLock)).rejects.toMatchObject({ code: "ENOENT" });
        await NodeFSP.rm(root, { recursive: true, force: true });
      });
    }),
  );
});
