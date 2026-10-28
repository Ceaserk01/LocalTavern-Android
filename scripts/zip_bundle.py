#!/usr/bin/env python3
"""Deterministic ZIP with relative paths; follows npm's local symlinks."""
import os
import sys
import zipfile
from pathlib import Path

source, output = map(Path, sys.argv[1:3])
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for directory, names, files in os.walk(source, followlinks=True):
        names[:] = sorted(n for n in names if n not in ('.git', '.bin'))
        for name in sorted(files):
            file = Path(directory) / name
            info = zipfile.ZipInfo(file.relative_to(source).as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            with file.open('rb') as src, archive.open(info, 'w') as dst:
                while chunk := src.read(1024 * 1024):
                    dst.write(chunk)
print(f'{output}: {output.stat().st_size:,} bytes')
