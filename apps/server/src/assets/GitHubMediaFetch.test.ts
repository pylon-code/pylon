import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpServerResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { githubMediaResponse } from "./GitHubMediaFetch.ts";

const github = Layer.mock(GitHubCli.GitHubCli)({
  execute: (input) => {
    expect(input.env?.GH_DEBUG).toBe("");
    return Effect.succeed({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: "private-token",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  },
});
const asset = {
  url: "https://github.com/user-attachments/assets/abc-123",
  cwd: "/repo",
  expiresAt: 60_000,
};

it.effect("strips credentials on signed CDN redirects and streams video ranges", () => {
  const requests: Array<{ url: string; auth: string | undefined; range: string | undefined }> = [];
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const response = yield* githubMediaResponse(
      { ...asset, expiresAt: now + 60_000 },
      { range: "bytes=2-4", cookie: "private-cookie", authorization: "client-token" },
    );
    expect(response.status).toBe(206);
    expect(response.headers["content-range"]).toBe("bytes 2-4/10");
    expect(response.headers["cache-control"]).toBe("private, max-age=60");
    expect(yield* Effect.promise(() => HttpServerResponse.toWeb(response).text())).toBe("abc");
    expect(requests).toEqual([
      { url: asset.url, auth: "Bearer private-token", range: "bytes=2-4" },
      {
        url: "https://private-user-images.githubusercontent.com/image?signature=opaque",
        auth: undefined,
        range: "bytes=2-4",
      },
    ]);
  }).pipe(
    Effect.provide(github),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        expect(request.headers.cookie).toBeUndefined();
        requests.push({
          url: request.url,
          auth: request.headers.authorization,
          range: request.headers.range,
        });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            requests.length === 1
              ? new Response(null, {
                  status: 302,
                  headers: {
                    location:
                      "https://private-user-images.githubusercontent.com/image?signature=opaque",
                  },
                })
              : new Response("abc", {
                  status: 206,
                  headers: {
                    "content-type": "video/mp4",
                    "content-range": "bytes 2-4/10",
                    "content-length": "3",
                  },
                }),
          ),
        );
      }),
    ),
    Effect.scoped,
  );
});

for (const location of [
  "https://127.0.0.1/private",
  "https://internal.example/private",
  "http://raw.githubusercontent.com/x",
  "https://raw.githubusercontent.com:8443/x",
  "https://[",
  "https://user:password@raw.githubusercontent.com/x",
]) {
  it.effect(`refuses an unsafe media redirect: ${location}`, () => {
    let requests = 0;
    return githubMediaResponse(asset, {}).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          expect(response.status).toBe(502);
          expect(requests).toBe(1);
        }),
      ),
      Effect.provide(github),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests++;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 302, headers: { location } }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });
}

for (const scenario of [
  { type: "text/html", status: 200, expected: 415 },
  { type: "image/svg+xml", status: 200, expected: 200 },
  { type: "text/html", status: 404, expected: 404 },
  { type: "text/html", status: 503, expected: 502 },
]) {
  it.effect(`handles media content type ${scenario.type} and status ${scenario.status}`, () =>
    githubMediaResponse(asset, {}).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          expect(response.status).toBe(scenario.expected);
          expect(response.headers["x-content-type-options"]).toBe("nosniff");
          if (scenario.type === "image/svg+xml")
            expect(response.headers["content-security-policy"]).toContain("sandbox");
          else expect(response.headers["content-length"]).toBeUndefined();
        }),
      ),
      Effect.provide(github),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: scenario.status,
                headers: { "content-type": scenario.type, "content-length": "200" },
              }),
            ),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );
}
