#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
if [[ -z "${JAVA_HOME:-}" && -d .tooling/jdk/Contents/Home ]]; then
  export JAVA_HOME="$project_dir/.tooling/jdk/Contents/Home"
fi
if [[ -z "${ANDROID_HOME:-}" && -d .tooling/android ]]; then
  export ANDROID_HOME="$project_dir/.tooling/android"
fi
if [[ -n "${ANDROID_HOME:-}" && ! -f local.properties ]]; then
  printf 'sdk.dir=%s\n' "$ANDROID_HOME" > local.properties
fi
if [[ "${1:-}" != "--skip-prepare" ]]; then
  python3 scripts/prepare_runtime.py
  node scripts/prepare_bundle.mjs
fi
cp app/libnode/LICENSE app/src/main/assets/Node-LICENSE.txt
cp LICENSE app/src/main/assets/SillyTavern-LICENSE.txt
cp app/libzstd/LICENSE app/src/main/assets/Zstd-LICENSE.txt
if [[ -x .tooling/gradle-8.11.1/bin/gradle ]]; then
  task_gradle=.tooling/gradle-8.11.1/bin/gradle
else
  task_gradle=./gradlew
fi
"$task_gradle" :app:assembleDebug :app:lintDebug --console=plain
mkdir -p dist
version="$(node -p 'JSON.parse(require("node:fs").readFileSync("release.json","utf8")).version')"
cp app/build/outputs/apk/debug/app-arm64-v8a-debug.apk "dist/LocalTavern-${version}-debug-arm64.apk"
cp app/build/outputs/apk/debug/app-x86_64-debug.apk "dist/LocalTavern-${version}-debug-x86_64.apk"
(cd dist && shasum -a 256 "LocalTavern-${version}-debug-"*.apk > DEBUG-SHA256SUMS.txt)
echo 'APK files and SHA256SUMS.txt are in dist/'
