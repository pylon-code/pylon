// @effect-diagnostics nodeBuiltinImport:off - this test layer must supply Node's real HTTP listener to reproduce address-family binding.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as Layer from "effect/Layer";

/**
 * The Effect test client sends to 127.0.0.1. Bind the test server to that same address:
 * macOS can also bind a separate IPv4 listener on a port held by an IPv6 `::` listener,
 * causing otherwise isolated tests to receive the other server's response.
 */
const makeLayer = (websocket?: { readonly perMessageDeflate: true }) =>
  HttpServer.layerTestClient.pipe(
    Layer.provide(
      Layer.fresh(FetchHttpClient.layer).pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
      ),
    ),
    Layer.provideMerge(
      NodeHttpServer.layer(NodeHttp.createServer, {
        host: "127.0.0.1",
        port: 0,
        ...(websocket ? { websocket } : {}),
      }),
    ),
  );

export const loopbackHttpServerTest = makeLayer();
export const loopbackHttpServerTestWithWsDeflate = makeLayer({ perMessageDeflate: true });
