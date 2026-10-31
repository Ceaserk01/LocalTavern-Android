#!/usr/bin/env python3
"""Compile and test the real JNI decoder on the host, without starting Android."""

import hashlib
import io
import os
import platform
import random
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def java_home():
    candidates = [Path(os.environ["JAVA_HOME"])] if os.environ.get("JAVA_HOME") else []
    candidates += [ROOT / ".tooling/jdk/Contents/Home", ROOT / ".tooling/jdk"]
    for candidate in candidates:
        if (candidate / "include/jni.h").is_file():
            return candidate
    javac = shutil.which("javac")
    if javac:
        candidate = Path(javac).resolve().parent.parent
        if (candidate / "include/jni.h").is_file():
            return candidate
    raise RuntimeError("A JDK 17+ is required; set JAVA_HOME")


def main():
    cli = Path(subprocess.check_output([
        sys.executable, str(ROOT / "scripts/prepare_codec.py"), "--print-cli",
    ], text=True).strip())
    sdk = ROOT / "app/libzstd"
    java = java_home()
    system = platform.system()
    if system not in ("Darwin", "Linux"):
        raise RuntimeError("Host JNI codec tests support macOS and Linux")
    compiler = os.environ.get("CC", "cc")
    with tempfile.TemporaryDirectory(prefix="bundle-codec-", dir=ROOT / ".cache") as temporary:
        work = Path(temporary)
        library = work / ("libtavern_bundle.dylib" if system == "Darwin" else "libtavern_bundle.so")
        sources = [ROOT / "app/src/main/cpp/bundle_zstd.c"]
        sources += sorted((sdk / "lib/common").glob("*.c"))
        sources += sorted((sdk / "lib/decompress").glob("*.c"))
        command = [compiler, "-dynamiclib" if system == "Darwin" else "-shared", "-fPIC", "-Os",
                   "-fvisibility=hidden", "-DZSTD_DISABLE_ASM", "-DZSTD_LEGACY_SUPPORT=0",
                   "-DZSTDLIB_VISIBLE=", "-DZSTDERRORLIB_VISIBLE=",
                   # Exercise the same output-limit branch with a small fixture.
                   "-DTAVERN_ZSTD_MAX_OUTPUT=4194304ULL", "-Wall", "-Wextra", "-Werror",
                   "-I" + str(java / "include"),
                   "-I" + str(java / "include" / ("darwin" if system == "Darwin" else "linux")),
                   "-I" + str(sdk / "lib"), *map(str, sources), "-o", str(library)]
        subprocess.run(command, check=True)
        fixtures = work / "fixtures"
        fixtures.mkdir()

        def compress(name, raw):
            result = subprocess.run([str(cli), "--single-thread", "-3", "--check", "-q", "-c"],
                                    input=raw, stdout=subprocess.PIPE, check=True).stdout
            (fixtures / name).write_bytes(result)
            return result

        rng = random.Random(2401)
        raw = bytes(rng.getrandbits(8) for _ in range(300001)) + bytes(range(256)) * 200
        (fixtures / "binary.raw").write_bytes(raw)
        compress("binary.zst", raw)
        compress("empty.zst", b"")
        tiny = compress("tiny.zst", b"binary\x00\xff\n" * 5)
        for length in range(len(tiny)):
            (fixtures / f"truncated-{length:03d}.zst").write_bytes(tiny[:length])
        corrupt = bytearray(tiny)
        corrupt[-1] ^= 0x80 # Always exercises the frame checksum, regardless of content encoding.
        (fixtures / "corrupt.zst").write_bytes(corrupt)
        (fixtures / "trailing.zst").write_bytes(tiny + b"x")
        (fixtures / "double.zst").write_bytes(tiny + tiny)
        (fixtures / "skippable.zst").write_bytes(bytes.fromhex("502a4d1800000000") + tiny)
        # Streaming stdin has no declared content size. Increasing its window
        # descriptor preserves a valid frame/checksum but exceeds our cap.
        if tiny[4] & 0x20:
            raise RuntimeError("Expected a non-single-segment streaming frame")
        large_window = bytearray(tiny)
        large_window[5] = 0x80 # 2^(10+16) = 64 MiB > the 32 MiB decoder cap.
        (fixtures / "large-window.zst").write_bytes(large_window)
        reference = subprocess.run([str(cli), "-d", "-q", "-c"], input=large_window,
                                   stdout=subprocess.PIPE, check=True).stdout
        if reference != b"binary\x00\xff\n" * 5:
            raise RuntimeError("Large-window fixture is not an otherwise valid Zstandard frame")
        compress("over-limit.zst", b"a" * (4 * 1024 * 1024 + 1))
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
            for index in range(900):
                # A long central directory keeps frame EOF well beyond where
                # ZipInputStream stops reading its local-file records.
                bundle.writestr(f"{index:04d}-" + "n" * 240, b"payload")
        zip_frame = compress("footer.zip.zst", archive.getvalue())
        corrupt_zip = bytearray(zip_frame)
        corrupt_zip[-1] ^= 0x80
        (fixtures / "bad-footer.zip.zst").write_bytes(corrupt_zip)
        classes = work / "classes"
        classes.mkdir()
        subprocess.run([str(java / "bin/javac"), "--release", "17", "-encoding", "UTF-8", "-d", str(classes),
                        str(ROOT / "app/src/main/java/app/local/tavern/BundleZstdInputStream.java"),
                        str(ROOT / "tests/java/app/local/tavern/BundleZstdInputStreamTest.java")], check=True)
        subprocess.run([str(java / "bin/java"), "-Xmx64m", "-Djava.library.path=" + str(work),
                        "-cp", str(classes), "app.local.tavern.BundleZstdInputStreamTest", str(fixtures)], check=True)
        # Explicit byte-for-byte compressor reproducibility from the pinned CLI.
        first = compress("repeat-a.zst", raw)
        second = compress("repeat-b.zst", raw)
        if first != second:
            raise RuntimeError("Pinned compressor produced nondeterministic output")
        print("Pinned compressor repeated SHA-256:", hashlib.sha256(first).hexdigest())


if __name__ == "__main__":
    main()
