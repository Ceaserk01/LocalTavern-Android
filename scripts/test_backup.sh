#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "${JAVA_HOME:-}" ]]; then
  task_javac="${JAVA_HOME}/bin/javac"
  task_java="${JAVA_HOME}/bin/java"
elif [[ -x "${project_root}/.tooling/jdk/Contents/Home/bin/javac" ]]; then
  task_javac="${project_root}/.tooling/jdk/Contents/Home/bin/javac"
  task_java="${project_root}/.tooling/jdk/Contents/Home/bin/java"
elif [[ -x "${project_root}/.tooling/jdk/bin/javac" ]]; then
  task_javac="${project_root}/.tooling/jdk/bin/javac"
  task_java="${project_root}/.tooling/jdk/bin/java"
else
  task_javac="$(command -v javac || true)"
  task_java="$(command -v java || true)"
fi
if [[ ! -x "${task_javac}" || ! -x "${task_java}" ]]; then
  echo "A host JDK 17+ is required. Set JAVA_HOME to its home directory." >&2
  exit 1
fi
task_classes="$(mktemp -d "${TMPDIR:-/tmp}/local-tavern-backup-tests.XXXXXX")"
trap 'rm -rf "${task_classes}"' EXIT
"${task_javac}" --release 17 -encoding UTF-8 -d "${task_classes}" \
  "${project_root}/app/src/main/java/app/local/tavern/SafeZip.java" \
  "${project_root}/app/src/main/java/app/local/tavern/BackupArchive.java" \
  "${project_root}/tests/java/app/local/tavern/BackupArchiveTest.java"
"${task_java}" -Xmx64m -cp "${task_classes}" app.local.tavern.BackupArchiveTest
