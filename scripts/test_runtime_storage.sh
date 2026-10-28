#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${JAVA_HOME:-}" ]]; then
  task_java_home="$JAVA_HOME"
elif [[ -x "$project_root/.tooling/jdk/Contents/Home/bin/javac" ]]; then
  task_java_home="$project_root/.tooling/jdk/Contents/Home"
else
  task_java_home=""
fi
task_javac="${task_java_home:+$task_java_home/bin/}javac"
task_java="${task_java_home:+$task_java_home/bin/}java"
task_classes="$(mktemp -d "${TMPDIR:-/tmp}/local-tavern-storage-tests.XXXXXX")"
trap 'rm -rf "$task_classes"' EXIT
"$task_javac" --release 17 -encoding UTF-8 -d "$task_classes" \
  "$project_root/app/src/main/java/app/local/tavern/RuntimeStorage.java" \
  "$project_root/tests/java/app/local/tavern/RuntimeStorageTest.java"
"$task_java" -Xmx64m -cp "$task_classes" app.local.tavern.RuntimeStorageTest
