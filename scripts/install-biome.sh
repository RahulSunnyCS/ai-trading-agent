#!/usr/bin/env bash
# install-biome.sh — download the Biome CLI binary from GitHub Releases.
#
# Run once after cloning the repo (or after upgrading the pinned version below).
# The binary is placed at ./tools/biome, which is gitignored because it is
# platform-specific. All lint scripts and the pre-commit hook reference this path.
#
# Why a standalone binary instead of npm?
#   @biomejs/biome is not available in the corporate JFrog npm proxy. The GitHub
#   Releases CDN is a separate download path that works independently of npm.
#   Once IT adds @biomejs/* to the JFrog virtual repo, this script becomes
#   optional and can be removed in favour of putting biome back in devDependencies.
#
# If GitHub is also blocked by your proxy, download the binary manually from:
#   https://github.com/biomejs/biome/releases/tag/cli/v1.9.4
# and place it at ./tools/biome, then: chmod +x ./tools/biome

set -euo pipefail

BIOME_VERSION="1.9.4"
TARGET_DIR="$(cd "$(dirname "$0")/.." && pwd)/tools"
TARGET="$TARGET_DIR/biome"

# ---------------------------------------------------------------------------
# Detect OS and architecture
# ---------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64)  ASSET="biome-linux-x64" ;;
      aarch64) ASSET="biome-linux-arm64" ;;
      *)
        echo "Unsupported Linux architecture: $ARCH" >&2
        exit 1
        ;;
    esac
    ;;
  Darwin)
    case "$ARCH" in
      x86_64)  ASSET="biome-darwin-x64" ;;
      arm64)   ASSET="biome-darwin-arm64" ;;
      *)
        echo "Unsupported macOS architecture: $ARCH" >&2
        exit 1
        ;;
    esac
    ;;
  MINGW*|MSYS*|CYGWIN*)
    ASSET="biome-win32-x64.exe"
    TARGET="$TARGET_DIR/biome.exe"
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

URL="https://github.com/biomejs/biome/releases/download/cli%2Fv${BIOME_VERSION}/${ASSET}"

# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------
mkdir -p "$TARGET_DIR"

echo "Downloading Biome ${BIOME_VERSION} (${ASSET})..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TARGET"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$URL" -O "$TARGET"
else
  echo "Neither curl nor wget found. Install one and retry." >&2
  exit 1
fi

chmod +x "$TARGET"

echo "Installed: $TARGET"
"$TARGET" --version
