import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  readAntigravityUsageLimits,
  usageLimitsFromAntigravityOutput,
} from "./antigravityUsageLimits.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const checkedAt = "2026-09-17T18:00:00.000Z";
const summary = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          remainingFraction: 0.75,
          resetTime: "2026-09-20T18:00:00Z",
        },
        { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.2 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [{ bucketId: "3p-5h", window: "5h", remainingFraction: 0.6 }],
    },
  ],
};
describe("native Antigravity quota schema", () => {
  it("maps actual CCPA groups without confusing remaining and used", () => {
    expect(usageLimitsFromAntigravityOutput(summary, checkedAt)).toMatchObject({
      source: "antigravityOAuth",
      checkedAt,
      windows: [
        {
          id: "gemini-weekly",
          label: "Weekly (Gemini)",
          usedPercent: 25,
          windowDurationMins: 10080,
          resetsAt: "2026-09-20T18:00:00.000Z",
        },
        { id: "gemini-5h", usedPercent: 80, windowDurationMins: 300 },
        { id: "3p-5h", label: "5-Hour (Claude/GPT)", usedPercent: 40 },
      ],
    });
  });
  it("fails closed for a CLI response or unknown schema", () => {
    expect(
      usageLimitsFromAntigravityOutput(
        { status: "SUCCESS", command: { data: summary } },
        checkedAt,
      ),
    ).toBeUndefined();
    expect(
      usageLimitsFromAntigravityOutput(
        { groups: [{ buckets: [{ remainingFraction: NaN }] }] },
        checkedAt,
      ),
    ).toBeUndefined();
  });
});

it.layer(NodeServices.layer)("ACP profile quota reads", (it) => {
  for (const mode of [
    "consumer",
    "enterprise",
    "missing",
    "wrong-uri",
    "http-error",
    "oversize",
    "account-change",
    "api-key",
  ] as const) {
    it.effect(mode, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(root, "antigravity-acp"));
        const tokenPath = path.join(root, "antigravity-acp", "acp_token.json");
        const credential = encodeJson({
          token_uri:
            mode === "wrong-uri"
              ? "https://example.invalid/token"
              : "https://oauth2.googleapis.com/token",
          client_id: "profile-client",
          client_secret: "fixture-secret",
          refresh_token: "profile-refresh",
          project_id: "saved-project",
        });
        if (mode !== "missing") yield* fs.writeFileString(tokenPath, credential);
        const urls: string[] = [];
        const http = HttpClient.make((request) =>
          Effect.gen(function* () {
            urls.push(request.url);
            if (request.url.endsWith("/token")) {
              expect(request.body._tag).toBe("Uint8Array");
              if (request.body._tag === "Uint8Array")
                expect(new TextDecoder().decode(request.body.body)).toContain(
                  "refresh_token=profile-refresh",
                );
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ access_token: "fixture-access" }),
              );
            }
            expect(request.headers.authorization).toBe("Bearer fixture-access");
            expect(request.headers["user-agent"]).toContain("antigravity/acp/1.1.1 (aidev_client;");
            if (request.url.endsWith("loadCodeAssist"))
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  cloudaicompanionProject: "account-project",
                  paidTier: { usesGcpTos: mode === "enterprise" },
                }),
              );
            if (mode === "account-change")
              yield* fs.writeFileString(tokenPath, credential + " ").pipe(Effect.orDie);
            const body = mode === "oversize" ? " ".repeat(300_000) : encodeJson(summary);
            return HttpClientResponse.fromWeb(
              request,
              new Response(body, { status: mode === "http-error" ? 403 : 200 }),
            );
          }),
        );
        const limits = yield* readAntigravityUsageLimits({
          profileDirectory: root,
          authMethod: mode === "api-key" ? "gemini-api-key" : "oauth-personal",
          runtimeVersion: "1.1.1",
        }).pipe(Effect.provideService(HttpClient.HttpClient, http));
        if (mode === "consumer" || mode === "enterprise") {
          expect(limits.windows).toHaveLength(3);
          expect(urls[2]).toBe(
            `https://${mode === "enterprise" ? "cloudcode-pa" : "daily-cloudcode-pa"}.googleapis.com/v1internal:retrieveUserQuotaSummary`,
          );
        } else {
          expect(limits.windows).toEqual([]);
          expect(limits.unavailable).toBeDefined();
        }
        if (mode === "missing" || mode === "wrong-uri" || mode === "api-key")
          expect(urls).toEqual([]);
        if (mode !== "missing" && mode !== "account-change")
          expect(yield* fs.readFileString(tokenPath)).toBe(credential);
      }),
    );
  }
});
