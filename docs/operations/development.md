# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires Node 24;
Bun is optional. From the repository root:

```sh
vp i
vp run dev
```

Open the one-time pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser. The dev runner needs a TTY: started from a non-interactive background shell, it
exits without binding a port, so confirm the port is listening before relying on it.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately, and `dev:marketing` starts the
marketing site. See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/pylon-dev`.
Add `--browser` to open a browser automatically. The runner sets `T3CODE_NO_BROWSER` from that
flag, so the environment variable alone has no effect.

### State and ports

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set.
The main checkout defaults to `~/.pylon-code/dev/userdata`. An explicit `--home-dir` wins in both
cases. Never run a development server against the live `~/.pylon-code/userdata`, or against
`~/.t3/userdata`, which belongs to T3 Code and carries upstream migration numbering.

Seed development state from a copy of Pylon's own database. See
[test data](../../AGENTS.md#test-data) for a consistent `VACUUM INTO` snapshot. `vp run migrate-dev-db`
seeds a worktree from a trimmed copy of `~/.pylon-code/userdata/state.sqlite`, and
`node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path>` inspects or seeds an
isolated database after taking a private backup. Both refuse to write to either runtime home.

Read ports from the `[dev-runner]` output. The defaults are 13773 for the server and 5733 for web.
Worktrees derive stable preferences from their paths, but occupied ports can shift them.
`T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a different preference when needed.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies `/api`, `/ws`, `/oauth`, and
`/.well-known` through the browser's origin, so the same build works over localhost and remote
connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp fmt --check <files>
vp run --filter <package> typecheck
```

The server package is named `t3`. A filter that matches no package exits successfully without
checking anything, so confirm the package ran. Use `vp run lint:mobile` for native mobile changes.

CI owns the full suite; see [ci.yml](../../.github/workflows/ci.yml) for its current jobs.
[Mobile native static analysis](../../.github/workflows/ci-mobile-native.yml) runs in its own
workflow so it can be path-filtered to the Swift and Kotlin sources it reads, which keeps the
macOS runner idle for TypeScript-only mobile changes. Widen its `paths:` list whenever the check
learns to read something new, or it silently stops running.

The [manual Windows lane](../../.github/workflows/windows-tests.yml) runs one workspace package on
a GitHub Windows runner for focused investigation and is not a required check. Dispatch it with
`gh workflow run windows-tests.yml --ref <branch> -f package=apps/server -f files="src/bootstrap.test.ts"`.
File paths are relative to the package; omitting `files` runs the package's tests.

## Desktop artifacts

Local artifact builds write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options. The artifact script checks prerequisites before building and reports every missing one
together.

Packaged builds keep Pylon's desktop identity independent from T3 Code: `com.pylon.code`, the
`pylon-code://` protocol, the `pylon-code` Electron profile, and `~/.pylon-code` runtime state.
Development uses the matching `*.dev` and `pylon-code-dev` identities. Do not restore upstream
desktop identifiers during selective adoption. Set `PYLON_DESKTOP_UPDATE_REPOSITORY=owner/repo`
when building outside GitHub Actions for artifacts that should use Pylon's updater; GitHub Actions
derives it from `GITHUB_REPOSITORY`.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Packaging
also compiles the Rust resource monitor and the KDE and Hyprland window capture helpers, and
bundles the GNOME Shell capture extension. Install Rust, C/C++ build tools, libsecret development
headers, pkg-config, and ImageMagick. `T3CODE_DESKTOP_REUSE_LINUX_CAPTURE_HELPERS=true` reuses
capture helpers that are already built.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

Local DMGs are ad-hoc signed, not Developer ID signed or notarized. If your macOS version rejects
an installed ad-hoc build, set `PYLON_DESKTOP_LOCAL_SIGNING_IDENTITY` to an Apple Development
identity from `security find-identity -v -p codesigning` before building. This does not enable
release notarization. Unnotarized builds can require choosing **Open** from the app's context
menu on first launch.

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs a Linux node-pty prebuild;
see the [release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Pylon Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.
