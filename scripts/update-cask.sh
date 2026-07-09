#!/usr/bin/env bash
# リリース後に Homebrew tap の cask を新バージョンへ更新する。
# 使い方: scripts/update-cask.sh v0.1.0
set -euo pipefail

TAG="${1:?usage: update-cask.sh vX.Y.Z}"
VERSION="${TAG#v}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Downloading universal dmg for ${TAG}"
gh release download "${TAG}" -R Love-Rox/Harushion -p "*_universal.dmg" -D "$WORK"
DMG="$(ls "$WORK"/*_universal.dmg)"
SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
echo "    sha256: ${SHA}"

echo "==> Updating tap"
git clone --depth 1 "https://github.com/Love-Rox/homebrew-tap" "$WORK/tap"
CASK="$WORK/tap/Casks/harushion.rb"
sed -i '' -E "s|^  version \".*\"$|  version \"${VERSION}\"|" "$CASK"
sed -i '' -E "s|^  sha256 .*$|  sha256 \"${SHA}\"|" "$CASK"
git -C "$WORK/tap" commit -am "harushion ${VERSION}"
git -C "$WORK/tap" push
echo "==> Done: cask updated to ${VERSION}"
