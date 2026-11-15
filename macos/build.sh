#!/bin/bash
# Build "Streaming Timer Sync.app" (universal: Apple Silicon + Intel) and package it as .dmg and .zip.
#   macos/build.sh            -> dist/
# Needs Xcode command line tools. Downloads the official Node.js runtime (checksum-verified).
set -euo pipefail

NODE_VERSION="22.12.0"
APP_NAME="Streaming Timer Sync"
BUNDLE_ID="io.github.samandrsn.streamingtimersync"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/server/package.json').version" 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/server/package.json")"
BUILD="$ROOT/macos/build"
DIST="$ROOT/dist"
APP="$BUILD/$APP_NAME.app"

echo "Building $APP_NAME $VERSION"
rm -rf "$BUILD" && mkdir -p "$BUILD/node" "$DIST"

# --- Node runtime (universal) ---
CACHE="$ROOT/macos/.cache"
mkdir -p "$CACHE"
SUMS="$CACHE/SHASUMS256-$NODE_VERSION.txt"
[ -f "$SUMS" ] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$SUMS"
for arch in arm64 x64; do
	tgz="node-v$NODE_VERSION-darwin-$arch.tar.gz"
	[ -f "$CACHE/$tgz" ] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tgz" -o "$CACHE/$tgz"
	want="$(grep " $tgz\$" "$SUMS" | cut -d' ' -f1)"
	got="$(shasum -a 256 "$CACHE/$tgz" | cut -d' ' -f1)"
	[ -n "$want" ] && [ "$want" = "$got" ] || { echo "Checksum mismatch for $tgz"; rm -f "$CACHE/$tgz"; exit 1; }
	tar -xzf "$CACHE/$tgz" -C "$BUILD/node" "node-v$NODE_VERSION-darwin-$arch/bin/node" "node-v$NODE_VERSION-darwin-$arch/LICENSE"
done
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
lipo -create "$BUILD/node/node-v$NODE_VERSION-darwin-arm64/bin/node" "$BUILD/node/node-v$NODE_VERSION-darwin-x64/bin/node" -output "$APP/Contents/Resources/node"
cp "$BUILD/node/node-v$NODE_VERSION-darwin-arm64/LICENSE" "$APP/Contents/Resources/NODE-LICENSE.txt"

# --- App executable (universal) ---
for target in arm64-apple-macos13 x86_64-apple-macos13; do
	swiftc -O -target "$target" -o "$BUILD/app-$target" "$ROOT/macos/App.swift"
done
lipo -create "$BUILD"/app-* -output "$APP/Contents/MacOS/$APP_NAME"

# --- Server files ---
mkdir -p "$APP/Contents/Resources/server"
cp -R "$ROOT/server/src" "$ROOT/server/public" "$ROOT/server/package.json" "$APP/Contents/Resources/server/"

# --- Icon (rendered from the web logo) ---
if qlmanage -t -s 1024 -o "$BUILD" "$ROOT/server/public/logo.svg" >/dev/null 2>&1 && [ -f "$BUILD/logo.svg.png" ]; then
	ICONSET="$BUILD/AppIcon.iconset"
	mkdir -p "$ICONSET"
	for size in 16 32 128 256 512; do
		sips -z $size $size "$BUILD/logo.svg.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
		sips -z $((size * 2)) $((size * 2)) "$BUILD/logo.svg.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
	done
	iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>$APP_NAME</string>
	<key>CFBundleDisplayName</key><string>$APP_NAME</string>
	<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
	<key>CFBundleExecutable</key><string>$APP_NAME</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundleVersion</key><string>$VERSION</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSLocalNetworkUsageDescription</key><string>Stage displays and Companion on your network connect to the timer server.</string>
	<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

# Ad-hoc signature so it runs on Apple Silicon. Not notarized: first launch needs right-click > Open.
codesign --force --deep --sign - "$APP"

# --- Package ---
ZIP="$DIST/StreamingTimerSync-$VERSION-macOS.zip"
DMG="$DIST/StreamingTimerSync-$VERSION-macOS.dmg"
rm -f "$ZIP" "$DMG"
ditto -c -k --keepParent "$APP" "$ZIP"
STAGE="$BUILD/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG"

echo "Done:"
ls -lh "$ZIP" "$DMG"
