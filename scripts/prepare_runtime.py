#!/usr/bin/env python3
"""Fetch the pinned full Node.js mobile SDK and stage its Android binaries.

The upstream project labels this SDK as a prerelease. Its SHA-256 is pinned
here so a changed remote archive cannot silently change the runtime we ship.
The script requires Python 3.9+ and curl; it does not require npm or an NDK.
"""

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parent.parent
VERSION = "24.22.1-0"
ARCHIVE = f"nodejs-mobile-android-{VERSION}.zip"
URL = f"https://github.com/fogtape/nodejs-mobile/releases/download/v{VERSION}/{ARCHIVE}"
SHA256 = "d6fd9f610fe5d81fede8f0d400c5a62723247725a19831835f15abf4f0604250"
LICENSE_URL = "https://raw.githubusercontent.com/nodejs/node/v24.22.1/LICENSE"
LICENSE_SHA256 = "5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace"
ABIS = ("arm64-v8a", "x86_64")


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def download(cache, name=ARCHIVE, url=URL, expected=SHA256):
    target = cache / name
    if target.exists() and digest(target) == expected:
        return target
    cache.mkdir(parents=True, exist_ok=True)
    partial = cache / (name + ".partial")
    print(f"Downloading {name}…", flush=True)
    subprocess.run([
        "curl", "--fail", "--location", "--silent", "--show-error", "--retry", "4", "--retry-all-errors",
        "--connect-timeout", "30", "--output", str(partial), url,
    ], check=True)
    actual = digest(partial)
    if actual != expected:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"Download checksum mismatch: expected {expected}, got {actual}")
    partial.replace(target)
    return target


def verify_elf(data, abi):
    """Check ABI and each load segment's 16 KiB page compatibility."""
    if data[:6] != b"\x7fELF\x02\x01":
        raise RuntimeError(f"{abi}: expected a little-endian ELF64 library")
    machine = struct.unpack_from("<H", data, 18)[0]
    expected_machine = {"arm64-v8a": 183, "x86_64": 62}[abi]
    if machine != expected_machine:
        raise RuntimeError(f"{abi}: wrong ELF machine {machine}")
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phentsize, phnum = struct.unpack_from("<HH", data, 54)
    segments = []
    for index in range(phnum):
        start = phoff + index * phentsize
        ptype = struct.unpack_from("<I", data, start)[0]
        if ptype != 1:  # PT_LOAD
            continue
        offset, address = struct.unpack_from("<QQ", data, start + 8)
        alignment = struct.unpack_from("<Q", data, start + 48)[0]
        if alignment < 16384 or (address - offset) % 16384:
            raise RuntimeError(f"{abi}: PT_LOAD segment is not 16 KiB compatible")
        segments.append(alignment)
    if not segments:
        raise RuntimeError(f"{abi}: library has no load segments")
    return segments


def stage(archive, abis):
    sdk = ROOT / "app" / "libnode"
    libs = ROOT / "app" / "src" / "main" / "jniLibs"
    sdk.mkdir(parents=True, exist_ok=True)
    metadata = {"version": VERSION, "flavor": "full", "prerelease": True,
                "url": URL, "sha256": SHA256, "libraries": {}}
    with tempfile.TemporaryDirectory(prefix="node-sdk-", dir=sdk) as temporary:
        staging = Path(temporary)
        with zipfile.ZipFile(archive) as bundle:
            members = bundle.infolist()
            header_count = 0
            for member in members:
                parts = PurePosixPath(member.filename).parts
                if ".." in parts or member.is_dir():
                    continue
                # Published SDKs may have a wrapping directory. Match the
                # semantic include/node suffix, never trust an archive path.
                for index in range(len(parts) - 1):
                    if parts[index:index + 2] != ("include", "node"):
                        continue
                    relative = PurePosixPath(*parts[index:])
                    destination = staging.joinpath(*relative.parts)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.open(member) as source, destination.open("wb") as output:
                        shutil.copyfileobj(source, output)
                    header_count += 1
                    break
            if not (staging / "include" / "node" / "node.h").exists():
                raise RuntimeError("SDK does not contain include/node/node.h")
            for abi in abis:
                candidates = [member for member in members
                              if PurePosixPath(member.filename).name == "libnode.so"
                              and abi in PurePosixPath(member.filename).parts]
                if len(candidates) != 1:
                    raise RuntimeError(f"Expected one libnode.so for {abi}, found {len(candidates)}")
                data = bundle.read(candidates[0])
                alignment = verify_elf(data, abi)
                destination = staging / abi / "libnode.so"
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
                metadata["libraries"][abi] = {
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "size": len(data), "load_segment_alignment": alignment,
                }
        headers = sdk / "include"
        if headers.exists():
            shutil.rmtree(headers)
        shutil.move(str(staging / "include"), str(headers))
        for abi in abis:
            target = libs / abi
            target.mkdir(parents=True, exist_ok=True)
            shutil.move(str(staging / abi / "libnode.so"), str(target / "libnode.so"))
            print(f"Staged {abi}: {metadata['libraries'][abi]['size'] / 1024 / 1024:.1f} MiB; 16 KiB ELF verified")
        (sdk / "runtime.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        print(f"Staged {header_count} Node headers in {headers}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--abis", nargs="+", choices=ABIS, default=list(ABIS))
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache" / "node-runtime")
    parser.add_argument("--archive", type=Path, help="Use a downloaded SDK (checksum is still required)")
    args = parser.parse_args()
    archive = args.archive or download(args.cache)
    if digest(archive) != SHA256:
        raise RuntimeError("Node SDK checksum mismatch")
    stage(archive, args.abis)
    license_file = download(args.cache, "LICENSE-node-v24.22.1", LICENSE_URL, LICENSE_SHA256)
    shutil.copyfile(license_file, ROOT / "app" / "libnode" / "LICENSE")


if __name__ == "__main__":
    main()
