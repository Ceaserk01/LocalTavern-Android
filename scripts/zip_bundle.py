#!/usr/bin/env python3
"""Lossless solid-compressed ZIP; keep every runtime path and byte.

STORE entries let one outer Zstandard frame share its dictionary across files.
Adjacent identical files also fit in the bounded decoder window. The Android
installer still uses SafeZip for paths, CRCs, entry counts and size quotas.
"""
import argparse
import hashlib
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--zstd', required=True, type=Path)
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    groups = {}
    for directory, names, files in os.walk(source, followlinks=True):
        names[:] = sorted(n for n in names if n not in ('.git', '.bin'))
        for name in sorted(files):
            file = Path(directory) / name
            digest = hashlib.sha256()
            with file.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            groups.setdefault(digest.digest(), []).append(file)
    ordered = sorted((sorted(files, key=lambda f: f.relative_to(source).as_posix())
                      for files in groups.values()), key=lambda files: files[0].relative_to(source).as_posix())
    count = sum(map(len, ordered))
    if not 0 < count <= 200000:
        raise ValueError('Bundle entry count exceeds installer limits')
    output.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    # Work files must stay outside Android's assets tree, even if a build or
    # preparation is interrupted before the temporary directory is removed.
    work = Path(__file__).resolve().parent.parent / '.cache'
    work.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='tavern-pack-', dir=work) as temporary:
        stored = Path(temporary) / 'runtime.zip'
        compressed = Path(temporary) / 'runtime.zip.zst'
        with zipfile.ZipFile(stored, 'w', compression=zipfile.ZIP_STORED) as archive:
            for files in ordered:
                for file in files:
                    size = file.stat().st_size
                    total += size
                    if size > 512 * 1024 * 1024 or total > 2 * 1024 * 1024 * 1024:
                        raise ValueError('Bundle exceeds installer size limits')
                    info = zipfile.ZipInfo(file.relative_to(source).as_posix(), (2026, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_STORED
                    info.external_attr = 0o100644 << 16
                    with file.open('rb') as src, archive.open(info, 'w') as dst:
                        for chunk in iter(lambda: src.read(1024 * 1024), b''):
                            dst.write(chunk)
        # Compression is build-only. The phone needs a small streaming decoder,
        # capped to this 32 MiB window, and never runs this compressor.
        subprocess.run([str(args.zstd.resolve()), '-19', '--long=25', '--single-thread', '--check',
                        '--no-progress', '-f', str(stored), '-o', str(compressed)], check=True)
        subprocess.run([str(args.zstd.resolve()), '--test', '--quiet', str(compressed)], check=True)
        compressed.replace(output)
    print(f'{output}: {output.stat().st_size:,} bytes; {count:,} files; {total:,} unpacked bytes')


if __name__ == '__main__':
    main()
