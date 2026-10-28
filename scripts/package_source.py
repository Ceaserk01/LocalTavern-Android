#!/usr/bin/env python3
"""Package wrapper plus the exact upstream source needed to rebuild this APK."""
import io
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'release.json').read_text())['version']
output = root / f'dist/LocalTavern-{version}-source.tar.gz'
output.parent.mkdir(exist_ok=True)
excluded = {'.git', '.cache', '.tooling', '.signing', '.gradle', '.cxx', 'build', 'dist', 'node_modules', '.idea', '__pycache__'}
generated = {'app/libnode', 'app/src/main/jniLibs', 'upstream', 'local.properties',
             'app/src/main/assets/tavern.zip', 'app/src/main/assets/bundle-manifest.json'}
def publishable(rel):
    file = Path(rel)
    return not (any(part in excluded for part in file.parts) or rel in generated
        or any(rel.startswith(prefix + '/') for prefix in generated)
        or file.name == '.DS_Store' or file.name.startswith('.env')
        or file.suffix.lower() in {'.jks', '.keystore', '.p12', '.pfx', '.pem', '.key'})

# A repository release exports only reviewed, version-controlled wrapper files.
# The walk fallback supports the standalone corresponding-source distribution.
tracked = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'], capture_output=True)
files_to_pack = [x.decode() for x in tracked.stdout.split(b'\0') if x] if tracked.returncode == 0 else []
if not files_to_pack:
    for directory, names, files in os.walk(root):
        relative = Path(directory).relative_to(root)
        names[:] = sorted(name for name in names if publishable((relative / name).as_posix()))
        files_to_pack.extend((relative / name).as_posix() for name in files)
with tarfile.open(output, 'w:gz') as target:
    for rel in sorted(files_to_pack):
        if publishable(rel): target.add(root / rel, arcname=f'LocalTavern/{rel}', recursive=False)
    upstream = subprocess.check_output(['git', '-C', str(root / 'upstream/SillyTavern'), 'archive', '--format=tar', 'HEAD'])
    snapshot = {'commit': json.loads((root / 'upstream.lock.json').read_text())['commit'], 'files': {}}
    with tarfile.open(fileobj=io.BytesIO(upstream), mode='r:') as source:
        for entry in source:
            content = source.extractfile(entry) if entry.isfile() else None
            if entry.isfile():
                data = content.read()
                snapshot['files'][entry.name] = hashlib.sha256(data).hexdigest()
                content = io.BytesIO(data)
            entry.name = 'LocalTavern/upstream/SillyTavern/' + entry.name
            target.addfile(entry, content)
    data = (json.dumps(snapshot, indent=2) + '\n').encode()
    marker = tarfile.TarInfo('LocalTavern/upstream/SillyTavern/.local-tavern-snapshot.json')
    marker.size = len(data)
    target.addfile(marker, io.BytesIO(data))
print(f'{output}: {output.stat().st_size:,} bytes')
