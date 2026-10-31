#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
git rev-parse --verify HEAD >/dev/null
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo 'Commit the reviewed source before building a public release.' >&2; exit 1
fi
if [[ -z "${JAVA_HOME:-}" && -d .tooling/jdk/Contents/Home ]]; then
  export JAVA_HOME="$project_dir/.tooling/jdk/Contents/Home"
fi
if [[ -z "${ANDROID_HOME:-}" && -d .tooling/android ]]; then
  export ANDROID_HOME="$project_dir/.tooling/android"
fi
for name in TAVERN_KEYSTORE_FILE TAVERN_KEYSTORE_PASSWORD TAVERN_KEY_ALIAS TAVERN_KEY_PASSWORD; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing signing variable: $name. See docs/BUILDING.md." >&2
    exit 1
  fi
done
if [[ ! -f "$TAVERN_KEYSTORE_FILE" ]]; then
  echo 'Signing keystore does not exist.' >&2; exit 1
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
npm test
python3 scripts/test_bundle_codec.py
python3 scripts/test_bundle_roundtrip.py
node scripts/smoke_wasm.mjs
./scripts/test_archive.sh
./scripts/test_runtime_storage.sh
./scripts/test_backup.sh
./scripts/test_android_interaction.sh --build-only
npm run test:integration
npm run test:features
if [[ -x .tooling/gradle-8.11.1/bin/gradle ]]; then
  task_gradle=.tooling/gradle-8.11.1/bin/gradle
else
  task_gradle=./gradlew
fi
"$task_gradle" :app:assembleRelease :app:lintRelease --console=plain
version="$(node -p 'JSON.parse(require("node:fs").readFileSync("release.json","utf8")).version')"
build_tools="${ANDROID_HOME:?Set ANDROID_HOME}/build-tools/35.0.0"
mkdir -p dist
for abi in arm64-v8a x86_64; do
  if [[ "$abi" == arm64-v8a ]]; then suffix=arm64; else suffix=x86_64; fi
  source_apk="app/build/outputs/apk/release/app-${abi}-release.apk"
  target_apk="dist/LocalTavern-${version}-${suffix}.apk"
  "$build_tools/zipalign" -c -P 16 4 "$source_apk"
  "$build_tools/apksigner" verify --verbose --print-certs "$source_apk" > "dist/signature-${suffix}.txt"
  if grep -q 'Android Debug' "dist/signature-${suffix}.txt"; then
    echo 'Refusing to release an APK signed with the Android debug certificate.' >&2; exit 1
  fi
  if "$build_tools/aapt" dump badging "$source_apk" | grep -q '^application-debuggable'; then
    echo 'Refusing to release a debuggable APK.' >&2; exit 1
  fi
  cp "$source_apk" "$target_apk"
done
python3 scripts/package_source.py
python3 scripts/release_manifest.py
echo "Signed release artifacts for $version are ready in dist/. This script does not publish them."
