#!/usr/bin/env bash
# One-time container setup, baked into prebuilds. Content-dependent work
# (dependency install and web cache warming) lives in update-content.sh.
set -euo pipefail

# The installer uses pnpm too, so its mounted store must already be writable.
for dir in "$HOME/.cache" "$HOME/.cache/pnpm"; do
  if [ -d "$dir" ] && [ "$(stat -c %U "$dir")" != "$(id -un)" ]; then
    sudo chown "$(id -un):$(id -gn)" "$dir"
  fi
done

# The Vite+ CLI is the repo task runner (vp i, vp run dev, vp test run).
# Download to a file first: a curl failure inside $( ) would yield an empty
# script and a false success. VP_NODE_MANAGER=no skips the installer's node
# shims; Node comes from the devcontainer feature. Pylon's pinned Vite+ 0.2.2
# uses the single-root VP_HOME layout, including for non-login lifecycle shells.
export VP_HOME="$HOME/.vite-plus"
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT
curl -fsSL https://vite.plus -o "$installer"
VP_VERSION=0.2.2 VP_NODE_MANAGER=no bash "$installer"
rm -f "$installer"

# Non-login lifecycle shells never source the profile the installer edits,
# so expose vp on the default PATH. test -x keeps a bad install loud.
test -x "$VP_HOME/bin/vp"
sudo ln -sf "$VP_HOME/bin/vp" /usr/local/bin/vp

# First-run terminal notice, rendered by the devcontainers base image.
sudo mkdir -p /usr/local/etc/vscode-dev-containers
sudo tee /usr/local/etc/vscode-dev-containers/first-run-notice.txt >/dev/null <<'EOF'
Pylon devcontainer

  vp run dev            start server + web, then open the pairing URL it
                        prints (the bare forwarded port will not authenticate)
  cp .env.example .env  optional: enable T3 Connect cloud features
                        (public identifiers, not secrets)

Details: docs/internals/devcontainer.md
EOF
