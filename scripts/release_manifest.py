#!/usr/bin/env python3
"""Public provenance for the exact source, runtime and signed release artifacts."""
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
out = root / 'dist'
version = json.loads((root / 'release.json').read_text())['version']
artifacts = [out / f'LocalTavern-{version}-{suffix}' for suffix in ('arm64.apk', 'x86_64.apk', 'source.tar.gz')]
def sha(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''): value.update(data)
    return value.hexdigest()
manifest = {
    'repository': 'https://github.com/Ceaserk01/LocalTavern-Android',
    'tag': f'v{version}',
    'version': version,
    'sourceCommit': subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip(),
    'upstream': json.loads((root / 'upstream.lock.json').read_text()),
    'runtime': json.loads((root / 'app/libnode/runtime.json').read_text()),
    'bundle': json.loads((root / 'app/src/main/assets/bundle-manifest.json').read_text()),
    'artifacts': [{'name': file.name, 'bytes': file.stat().st_size, 'sha256': sha(file)} for file in artifacts],
}
path = out / f'LocalTavern-{version}-manifest.json'
path.write_text(json.dumps(manifest, indent=2) + '\n')
public_files = [*artifacts, path, out / 'signature-arm64.txt', out / 'signature-x86_64.txt']
(out / 'SHA256SUMS.txt').write_text(''.join(f'{sha(file)}  {file.name}\n' for file in public_files))
print(json.dumps({'version': version, 'sourceCommit': manifest['sourceCommit'], 'artifacts': manifest['artifacts']}, indent=2))
