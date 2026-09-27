// @effect-diagnostics nodeBuiltinImport:off - the regression competes with the real Node listener for the same IPv4 port.
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { loopbackHttpServerTest } from "./loopbackHttpServer.ts";

it.effect("reserves the IPv4 loopback port used by its test client", () =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = new URL(HttpServer.formatAddress(server.address));
    assert.equal(address.hostname, "127.0.0.1");

    const secondBind = yield* Effect.promise(
      () =>
        new Promise<string>((resolve) => {
          const competingServer = NodeHttp.createServer();
          competingServer.once("error", (error: NodeJS.ErrnoException) =>
            resolve(error.code ?? "unknown-error"),
          );
          competingServer.listen({ host: "127.0.0.1", port: Number(address.port) }, () =>
            competingServer.close(() => resolve("bound")),
          );
        }),
    );
    assert.equal(secondBind, "EADDRINUSE");
  }).pipe(Effect.provide(loopbackHttpServerTest)),
);
