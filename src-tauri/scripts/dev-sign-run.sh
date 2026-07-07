#!/bin/bash
# Cargo runner for macOS dev builds.
#
# `tauri dev` binaries are ad-hoc linker-signed, so the keychain identifies
# the app by the binary hash — which changes every rebuild — and "Always
# Allow" never sticks for the Spotify OAuth tokens stored in the keychain.
# Re-signing with a stable Apple Development identity (and a stable
# identifier) makes the keychain ACL match by identity across rebuilds.
set -euo pipefail

BIN="$1"
IDENTITY="${TAGDECK_DEV_SIGN_IDENTITY:-Apple Development}"

if ! codesign --force --sign "$IDENTITY" --identifier com.factor8.tagdeck "$BIN" 2>/dev/null; then
  echo "warning: dev re-sign with '$IDENTITY' failed; keychain prompts may recur" >&2
fi

exec "$@"
