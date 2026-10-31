#!/usr/bin/env python3
"""Prepare the pinned Zstandard source and matching host compression tool.

Only the common/decompression C sources are linked into the Android app. The
host CLI is built from the same verified source instead of using a system zstd.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parent.parent
VERSION = "1.5.7"
ARCHIVE = f"zstd-{VERSION}.tar.gz"
URL = f"https://codeload.github.com/facebook/zstd/tar.gz/refs/tags/v{VERSION}"
SHA256 = "37d7284556b20954e56e1ca85b80226768902e2edabd3b649e9e72c0c9012ee3"


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def download(cache):
    target = cache / ARCHIVE
    if target.is_file() and digest(target) == SHA256:
        return target
    cache.mkdir(parents=True, exist_ok=True)
    partial = cache / (ARCHIVE + ".partial")
    subprocess.run([
        "curl", "--fail", "--location", "--silent", "--show-error",
        "--retry", "4", "--retry-all-errors", "--connect-timeout", "30",
        "--output", str(partial), URL,
    ], check=True)
    if digest(partial) != SHA256:
        partial.unlink(missing_ok=True)
        raise RuntimeError("Zstandard source checksum mismatch")
    partial.replace(target)
    return target


def extract(archive, destination):
    """Accept ordinary files beneath exactly the expected archive root."""
    prefix = f"zstd-{VERSION}"
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            parts = PurePosixPath(member.name).parts
            if (not parts or parts[0] != prefix or ".." in parts
                    or PurePosixPath(member.name).is_absolute()):
                raise RuntimeError("Unsafe path in Zstandard source archive")
            if member.isdir():
                continue
            if not member.isfile():
                # Upstream includes CLI convenience symlinks; none are needed
                # to build zstd, and no archive links are materialized.
                continue
            target = destination.joinpath(*parts[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            source = bundle.extractfile(member)
            if source is None:
                raise RuntimeError("Cannot read Zstandard source archive")
            with source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def stage(source):
    target = ROOT / "app" / "libzstd"
    metadata = {"version": VERSION, "url": URL, "sha256": SHA256,
                "sourceSha256": SHA256, "format": "zstd-single-frame",
                "maxWindowLog": 25, "maxDecodedBytes": 2 * 1024**3 + 128 * 1024**2,
                "license": "BSD-3-Clause", "androidModules": ["common", "decompress"]}
    expected = json.dumps(metadata, indent=2) + "\n"
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="zstd-stage-", dir=target.parent) as temporary:
        staged = Path(temporary)
        shutil.copytree(source / "lib", staged / "lib")
        shutil.copyfile(source / "LICENSE", staged / "LICENSE")
        (staged / "codec.json").write_text(expected, encoding="utf-8")
        # Never preserve stale source files when changing the pinned version.
        if (target / "lib").exists():
            shutil.rmtree(target / "lib")
        shutil.move(str(staged / "lib"), str(target / "lib"))
        shutil.copyfile(staged / "LICENSE", target / "LICENSE")
        shutil.copyfile(staged / "codec.json", target / "codec.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache" / "zstd" / f"v{VERSION}")
    parser.add_argument("--archive", type=Path, help="Local source archive; checksum is still required")
    parser.add_argument("--print-cli", action="store_true", help="Print only the absolute pinned host CLI path")
    parser.add_argument("--source-only", action="store_true", help="Stage Android C sources without building the host CLI")
    args = parser.parse_args()
    if args.print_cli and args.source_only:
        parser.error("--print-cli cannot be combined with --source-only")
    cache = args.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    archive = args.archive.resolve() if args.archive else download(cache)
    if digest(archive) != SHA256:
        raise RuntimeError("Zstandard source checksum mismatch")
    # Re-extract before a build: cached headers or C files cannot silently alter
    # the compressor or the Android decoder we stage.
    with tempfile.TemporaryDirectory(prefix="source-", dir=cache) as temporary:
        source = Path(temporary)
        extract(archive, source)
        stage(source)
        cli = cache / "zstd"
        if not args.source_only:
            # Disable optional codecs, legacy formats and threading. A single
            # deterministic compression thread is all the bundle builder needs.
            subprocess.run([
                "make", "-C", str(source), "zstd", "HAVE_ZLIB=0", "HAVE_LZMA=0",
                "HAVE_LZ4=0", "HAVE_THREAD=0", "ZSTD_LEGACY_SUPPORT=0",
                f"-j{min(8, os.cpu_count() or 1)}",
            ], check=True, stdout=subprocess.DEVNULL if args.print_cli else None)
            shutil.copyfile(source / "programs" / "zstd", cli)
            cli.chmod(0o755)
            version = subprocess.check_output([str(cli), "--version"], text=True)
            if f"v{VERSION}" not in version:
                raise RuntimeError("Built Zstandard CLI has an unexpected version")
            (cache / "cli.json").write_text(json.dumps({
                "version": VERSION, "sourceSha256": SHA256,
                "binarySha256": digest(cli), "threads": False,
            }, indent=2) + "\n", encoding="utf-8")
    if args.print_cli:
        print(cli)
    else:
        print(f"Staged Zstandard {VERSION} source in {ROOT / 'app/libzstd'}")
        if not args.source_only:
            print(f"Pinned host compressor: {cli}")


if __name__ == "__main__":
    main()
