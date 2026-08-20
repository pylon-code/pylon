# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs three jobs on pull requests and
pushes to `pylon`:

- **Check**: `vp check` (format and lint; this repo sets `typeCheck: false` in its lint options),
  then `vpr typecheck` for the workspace type check. The same job
  builds the desktop pipeline (`vp run build:desktop`) and verifies the preload bundle exists and
  still exports its expected symbols.
- **Test**: `vp run test` across the workspace.
- **Release Smoke**: exercises release-only workflow steps through `scripts/release-smoke.ts`, so
  release breakage surfaces on PRs rather than at tag time.

[`.github/workflows/ci-mobile-native.yml`](../../.github/workflows/ci-mobile-native.yml) runs
**Mobile Native Static Analysis** (`vp run lint:mobile`, wrapping
`scripts/mobile-native-static-check.ts`) on the same events. It lives in its own workflow so it can
be path-filtered: the check only reads `.swift`, `.kt`, and `.kts` sources under `apps/mobile`, and
it needs a macOS runner, which is the most expensive tier we buy. Filtering on `apps/mobile/**`
would not be enough — most changes there are TypeScript the native linters never look at. Widen the
`paths:` list whenever the check learns to read something new, or it will silently stop running.

`.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`)
desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release. It auto-enables
signing only when platform credentials are present. macOS passkey builds additionally require
`APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing.
Without the core signing credentials, it still releases unsigned artifacts.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.
