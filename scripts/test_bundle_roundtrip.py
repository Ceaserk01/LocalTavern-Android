#!/usr/bin/env python3
"""Prove the packaged Zstandard/ZIP bundle preserves every staged file.

Payloads are hashed in chunks; only metadata is kept in memory. Decompression
uses a disposable file, never the stage or the application's data directories.
An optional old tavern.zip can prove equivalence to an earlier release as well.
"""

import argparse
import hashlib
import json
import os
import re
import stat
import struct
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parent.parent
CHUNK = 1024 * 1024
MAX_ENTRIES = 200000
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
MAX_ZIP_BYTES = MAX_TOTAL_BYTES + 128 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def hash_stream(source, limit):
    digest = hashlib.sha256()
    size = 0
    while block := source.read(CHUNK):
        size += len(block)
        require(size <= limit, f"File exceeds {limit} bytes")
        digest.update(block)
    return {"size": size, "sha256": digest.hexdigest()}


def safe_name(name):
    require(name and "\0" not in name and "\\" not in name,
            f"Unsafe ZIP path: {name!r}")
    require(not name.startswith("/") and not re.match(r"^[a-zA-Z]:", name),
            f"Absolute ZIP path: {name!r}")
    parts = name.rstrip("/").split("/")
    require(all(part not in ("", ".", "..") for part in parts),
            f"Non-canonical ZIP path: {name!r}")
    require(str(PurePosixPath(*parts)) == name.rstrip("/"),
            f"Non-canonical ZIP path: {name!r}")
    return "/".join(parts)


def stage_inventory(stage):
    """Match the original ZIP writer's directory exclusions and symlink policy."""
    require(stage.is_dir(), f"Stage directory does not exist: {stage}")
    result = {}
    total = 0

    def walk(directory, relative, ancestors):
        nonlocal total
        identity = directory.stat()
        identity = (identity.st_dev, identity.st_ino)
        require(identity not in ancestors, f"Stage contains a symlink cycle: {directory}")
        ancestors = ancestors | {identity}
        with os.scandir(directory) as iterator:
            entries = sorted(iterator, key=lambda item: item.name)
        for entry in entries:
            file = Path(entry.path)
            name = relative + entry.name
            if entry.is_dir(follow_symlinks=True):
                if entry.name not in (".git", ".bin"):
                    walk(file, name + "/", ancestors)
                continue
            safe_name(name)
            before = file.stat()
            require(stat.S_ISREG(before.st_mode), f"Stage entry is not a regular file: {name}")
            require(before.st_size <= MAX_FILE_BYTES, f"Stage file exceeds native limit: {name}")
            with file.open("rb") as source:
                record = hash_stream(source, MAX_FILE_BYTES)
            after = file.stat()
            require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                    == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
                    and record["size"] == before.st_size,
                    f"Stage changed during verification: {name}")
            result[name] = record
            total += record["size"]
            require(len(result) <= MAX_ENTRIES, "Stage exceeds native entry limit")
            require(total <= MAX_TOTAL_BYTES, "Stage exceeds native total-size limit")

    walk(stage, "", set())
    require(result, "Stage is empty")
    return result


def zip_inventory(file, stored=False):
    result = {}
    paths = {}
    total = 0
    with zipfile.ZipFile(file) as archive:
        entries = archive.infolist()
        require(0 < len(entries) <= MAX_ENTRIES, "ZIP entry count exceeds native bounds or is empty")
        require(not archive.comment, "Unexpected ZIP archive comment")
        declared_total = 0
        for entry in entries:
            name = safe_name(entry.orig_filename)
            require(name not in paths, f"Duplicate ZIP path: {name}")
            require(not entry.flag_bits & 1, f"Encrypted ZIP entry: {name}")
            require(entry.file_size <= MAX_FILE_BYTES, f"ZIP file exceeds native size limit: {name}")
            require(entry.file_size >= 0 and entry.compress_size >= 0, f"Invalid ZIP size: {name}")
            require(entry.header_offset >= 0, f"Invalid ZIP local-header offset: {name}")
            declared_total += entry.file_size
            require(declared_total <= MAX_TOTAL_BYTES, "ZIP declared size exceeds native total-size limit")
            if stored:
                require(entry.compress_type == zipfile.ZIP_STORED, f"Expected STORE ZIP entry: {name}")
                require(entry.compress_size == entry.file_size, f"STORE ZIP size mismatch: {name}")
            paths[name] = entry.is_dir()
        if stored:
            # Android consumes local headers in order, whereas Python normally
            # trusts the central directory. Prove both views see the same files.
            cursor = 0
            with file.open("rb") as source:
                for entry in entries:
                    require(entry.header_offset == cursor,
                            f"Non-contiguous or reordered ZIP local headers: {entry.filename}")
                    source.seek(cursor)
                    raw_header = source.read(30)
                    require(len(raw_header) == 30, "Truncated ZIP local header")
                    header = struct.unpack("<4s5H3I2H", raw_header)
                    require(header[0] == b"PK\x03\x04", "Invalid ZIP local header")
                    require(header[2] == entry.flag_bits and not header[2] & 8,
                            f"Unexpected ZIP data descriptor or local flags: {entry.filename}")
                    require(header[3] == entry.compress_type and header[6] == entry.CRC
                            and header[7] == entry.compress_size and header[8] == entry.file_size,
                            f"ZIP local/central metadata mismatch: {entry.filename}")
                    local_name = source.read(header[9]).decode("utf8" if header[2] & 0x800 else "cp437")
                    require(local_name == entry.orig_filename,
                            f"ZIP local/central path mismatch: {entry.filename}")
                    cursor += 30 + header[9] + header[10] + entry.compress_size
                    require(cursor <= archive.start_dir, "ZIP local entry overlaps central directory")
            require(cursor == archive.start_dir, "ZIP has unindexed local entries or data before its central directory")
        for name in paths:
            parent = PurePosixPath(name).parent
            while str(parent) != ".":
                require(paths.get(str(parent), True), f"ZIP file/directory conflict: {name}")
                parent = parent.parent
        for entry in entries:
            name = safe_name(entry.orig_filename)
            require(not entry.is_dir(), f"Unexpected directory entry; bundle writer stores files only: {name}")
            with archive.open(entry) as source:
                record = hash_stream(source, MAX_FILE_BYTES)
            require(record["size"] == entry.file_size, f"ZIP declared/actual size mismatch: {name}")
            result[name] = record
            total += record["size"]
            require(total <= MAX_TOTAL_BYTES, "ZIP exceeds native total-size limit")
    return result


def inspect_zstd_frame(bundle):
    """Check a single ordinary frame, bounded window, and absence of trailing data."""
    size = bundle.stat().st_size
    with bundle.open("rb") as source:
        def read(count):
            data = source.read(count)
            require(len(data) == count, "Truncated Zstandard frame")
            return data

        require(read(4) == b"\x28\xb5\x2f\xfd", "Expected one ordinary Zstandard frame")
        descriptor = read(1)[0]
        require(not descriptor & 0x18, "Reserved Zstandard frame-header bits are set")
        single_segment = bool(descriptor & 0x20)
        window = None
        if not single_segment:
            descriptor_window = read(1)[0]
            base = 1 << (10 + (descriptor_window >> 3))
            window = base + (base >> 3) * (descriptor_window & 7)
        dictionary_size = (0, 1, 2, 4)[descriptor & 3]
        dictionary = int.from_bytes(read(dictionary_size), "little")
        require(dictionary == 0, "Unexpected external Zstandard dictionary")
        content_size_bytes = (1 if single_segment else 0, 2, 4, 8)[descriptor >> 6]
        content_size = int.from_bytes(read(content_size_bytes), "little") if content_size_bytes else None
        if content_size_bytes == 2:
            content_size += 256
        if single_segment:
            window = content_size
        require(window is not None and window <= 1 << 25, "Zstandard window exceeds --long=25")
        require(content_size is None or content_size <= MAX_ZIP_BYTES,
                "Zstandard declared content exceeds ZIP-size bound")
        blocks = 0
        while True:
            header = int.from_bytes(read(3), "little")
            block_type = (header >> 1) & 3
            block_size = header >> 3
            require(block_type != 3, "Reserved Zstandard block type")
            require(block_size <= 128 * 1024, "Zstandard block exceeds format limit")
            payload_size = 1 if block_type == 1 else block_size
            require(source.tell() + payload_size <= size, "Truncated Zstandard block")
            source.seek(payload_size, os.SEEK_CUR)
            blocks += 1
            if header & 1:
                break
        if descriptor & 4:
            read(4)
        require(source.tell() == size, "Zstandard contains concatenated frames or trailing data")
    return {"frames": 1, "windowBytes": window, "contentSize": content_size,
            "checksum": bool(descriptor & 4), "blocks": blocks}


def decompress(bundle, output, zstd):
    version = subprocess.run([str(zstd), "--version"], check=True, capture_output=True, text=True).stdout.strip()
    require(re.search(r"\bv1\.5\.7\b", version), f"Expected pinned zstd v1.5.7, got: {version}")
    total = 0
    with tempfile.TemporaryFile() as errors:
        child = subprocess.Popen([str(zstd), "-q", "-d", "-c", "--long=25", "--", str(bundle)],
                                 stdout=subprocess.PIPE, stderr=errors)
        try:
            with output.open("wb") as destination:
                while block := child.stdout.read(CHUNK):
                    total += len(block)
                    require(total <= MAX_ZIP_BYTES, "Decompressed ZIP exceeds size bound")
                    destination.write(block)
            status = child.wait()
            errors.seek(0, os.SEEK_END)
            errors.seek(max(0, errors.tell() - 8192))
            require(status == 0, f"zstd decompression failed ({status}): {errors.read().decode(errors='replace')}")
        except BaseException:
            child.kill()
            child.wait()
            raise
        finally:
            child.stdout.close()
    return {"version": version, "zipBytes": total}


def inventory_digest(inventory):
    digest = hashlib.sha256()
    for name, record in sorted(inventory.items()):
        digest.update(json.dumps([name, record["size"], record["sha256"]],
                                 ensure_ascii=False, separators=(",", ":")).encode("utf8") + b"\n")
    return digest.hexdigest()


def compare(expected, actual, label):
    missing = sorted(expected.keys() - actual.keys())
    extra = sorted(actual.keys() - expected.keys())
    changed = [name for name in sorted(expected.keys() & actual.keys()) if expected[name] != actual[name]]
    require(not (missing or extra or changed),
            f"{label} mismatch: {len(missing)} missing, {len(extra)} extra, {len(changed)} changed; "
            f"examples={json.dumps({'missing': missing[:8], 'extra': extra[:8], 'changed': changed[:8]}, ensure_ascii=False)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=ROOT / "app/src/main/assets/tavern.zip.zst")
    parser.add_argument("--stage", type=Path, default=ROOT / ".cache/bundle")
    parser.add_argument("--zstd", type=Path, default=ROOT / ".cache/zstd/v1.5.7/zstd")
    parser.add_argument("--reference-zip", type=Path)
    parser.add_argument("--report", type=Path, default=ROOT / ".cache/bundle-roundtrip.json")
    args = parser.parse_args()
    require(args.report.resolve() != args.bundle.resolve(), "Report would overwrite the input bundle")
    require(args.stage.resolve() not in args.report.resolve().parents,
            "Report must be outside the target bundle tree")
    started = time.monotonic()
    report = {"passed": False, "scope": "Host streaming decompression and byte-for-byte bundle preservation; no Android/emulator assertion",
              "bundle": str(args.bundle.resolve()), "stage": str(args.stage.resolve()),
              "limits": {"entries": MAX_ENTRIES, "fileBytes": MAX_FILE_BYTES,
                         "totalBytes": MAX_TOTAL_BYTES, "zipBytes": MAX_ZIP_BYTES}}
    status = 0
    try:
        report["compressedBytes"] = args.bundle.stat().st_size
        with args.bundle.open("rb") as source:
            report["compressedSha256"] = hash_stream(source, MAX_ZIP_BYTES)["sha256"]
        report["frame"] = inspect_zstd_frame(args.bundle)
        expected = stage_inventory(args.stage)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="bundle-roundtrip-", dir=args.report.parent) as temporary:
            decoded = Path(temporary) / "tavern.zip"
            report["decoder"] = decompress(args.bundle, decoded, args.zstd.resolve())
            content_size = report["frame"]["contentSize"]
            require(content_size is None or content_size == report["decoder"]["zipBytes"],
                    "Zstandard declared/decoded content size mismatch")
            actual = zip_inventory(decoded, stored=True)
            compare(expected, actual, "Stage/archive")
        if args.reference_zip:
            reference = zip_inventory(args.reference_zip)
            compare(reference, actual, "Reference/archive")
            report["reference"] = {"path": str(args.reference_zip.resolve()), "matched": True,
                                   "inventorySha256": inventory_digest(reference)}
        report.update({"passed": True, "fileCount": len(actual),
                       "totalFileBytes": sum(record["size"] for record in actual.values()),
                       "inventorySha256": inventory_digest(actual),
                       "files": [{"path": name, **record} for name, record in sorted(actual.items())]})
    except Exception as error:
        status = 1
        report["error"] = f"{type(error).__name__}: {error}"
    report["elapsedMs"] = round((time.monotonic() - started) * 1000)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "files"}, ensure_ascii=False, indent=2))
    print(f"Report: {args.report.resolve()}")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
