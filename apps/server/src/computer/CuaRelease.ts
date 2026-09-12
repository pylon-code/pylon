import { compareCuaVersions, ComputerSetupError, type ComputerRelease } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const Releases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.Boolean,
    assets: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        size: Schema.Int,
        digest: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
);
const decodeReleases = Schema.decodeUnknownEffect(Releases);
const decodeTags = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ ref: Schema.String })));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
export function cuaReleaseTarget(platform: string, arch: string): string | null {
  if (arch !== "arm64" && arch !== "x64") return null;
  if (platform === "darwin") return "darwin-universal";
  if (platform === "linux") return `linux-${arch === "x64" ? "x86_64" : "arm64"}`;
  if (platform === "win32") return `windows-${arch === "x64" ? "x86_64" : "arm64"}`;
  return null;
}
export function selectCuaRelease(
  releases: typeof Releases.Type,
  platform: string,
  arch: string,
): ComputerRelease | null {
  const target = cuaReleaseTarget(platform, arch);
  if (!target) return null;
  // This monorepo marks *all* product releases as GitHub prereleases. Plain SemVer is its stable channel.
  const candidates = releases
    .filter(
      (r) =>
        !r.draft &&
        r.tag_name.startsWith("cua-driver-rs-v") &&
        versionPattern.test(r.tag_name.slice(15)),
    )
    .sort((a, b) => compareCuaVersions(b.tag_name.slice(15), a.tag_name.slice(15)));
  const release = candidates[0];
  if (!release) return null;
  const version = release.tag_name.slice(15);
  const name = `cua-driver-rs-${version}-${target}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const asset = release.assets.find((a) => a.name === name);
  if (
    !asset ||
    !asset.digest?.match(/^sha256:[a-f0-9]{64}$/u) ||
    asset.size <= 0 ||
    asset.size > 512 * 1024 * 1024
  )
    return null;
  return {
    version,
    releaseUrl: `https://github.com/trycua/cua/releases/tag/${release.tag_name}`,
    assetName: name,
    sha256: asset.digest.slice(7),
    bytes: asset.size,
  };
}
export const fetchCuaRelease = Effect.fn("CuaRelease.fetch")(
  function* (platform: string, arch: string) {
    const client = yield* HttpClient.HttpClient;
    const request = (suffix: string) =>
      client.execute(
        HttpClientRequest.get(`https://api.github.com/repos/trycua/cua/${suffix}`, {
          headers: { Accept: "application/vnd.github+json", "User-Agent": "Pylon-Cua-Setup" },
        }),
      );
    // Driver tags are a small index; the monorepo release listing includes megabytes
    // of unrelated products and cannot be reliably paginated within a setup check.
    const tagResponse = yield* request("git/matching-refs/tags/cua-driver-rs-v").pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
    const tags = yield* tagResponse.json.pipe(Effect.flatMap(decodeTags));
    const prefix = "refs/tags/cua-driver-rs-v";
    const versions = tags
      .map((tag) => (tag.ref.startsWith(prefix) ? tag.ref.slice(prefix.length) : ""))
      .filter((tag) => versionPattern.test(tag))
      .sort((a, b) => compareCuaVersions(b, a))
      .slice(0, 10);
    if (versions.length === 0)
      return yield* new ComputerSetupError({
        operation: "check-update",
        message: "No stable Cua Driver tag was found.",
      });
    for (const version of versions) {
      const response = yield* request(`releases/tags/cua-driver-rs-v${version}`);
      // Tags may precede publication. Only unpublished releases are skipped;
      // an invalid published asset never silently falls back to an older version.
      if (response.status === 404) continue;
      yield* HttpClientResponse.filterStatusOk(response);
      const releases = yield* response.json.pipe(Effect.flatMap((raw) => decodeReleases([raw])));
      if (releases[0]?.draft) continue;
      const selected = selectCuaRelease(releases, platform, arch);
      if (!selected)
        return yield* new ComputerSetupError({
          operation: "check-update",
          message:
            "The latest published Cua Driver release has no verifiable asset for this platform.",
        });
      return selected;
    }
    return yield* new ComputerSetupError({
      operation: "check-update",
      message: "No published stable Cua Driver release was found.",
    });
  },
  Effect.scoped,
  Effect.timeout("30 seconds"),
  Effect.mapError(
    () =>
      new ComputerSetupError({
        operation: "check-update",
        message:
          "Could not verify the latest Cua Driver release with GitHub. Your installed driver is unchanged; try Check again later.",
      }),
  ),
);
