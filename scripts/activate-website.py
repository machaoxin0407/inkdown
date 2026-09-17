"""Verify and atomically activate a static site; runs as unprivileged deploy user."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import tempfile


def activate(root, deployment, archive):
    root = Path(root).resolve()
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{1,100}', deployment):
        raise ValueError('Invalid deployment id')
    releases = root / 'releases'
    releases.mkdir(parents=True, exist_ok=True)
    destination = releases / deployment
    if destination.exists():
        raise ValueError('Deployment already exists')
    stage = Path(tempfile.mkdtemp(prefix='.stage-', dir=releases))
    try:
        with tarfile.open(archive, 'r:gz') as bundle:
            seen = set()
            for member in bundle.getmembers():
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk():
                    raise ValueError('Unsafe archive path')
                if member.isdir():
                    (stage / path).mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    if str(path) in seen:
                        raise ValueError('Duplicate archive path')
                    seen.add(str(path))
                    target = stage / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.extractfile(member) as source, target.open('wb') as output:
                        shutil.copyfileobj(source, output)
                    target.chmod(0o644)
                else:
                    raise ValueError('Unsupported archive member')
        manifest = json.loads((stage / 'manifest.json').read_text())
        actual = {str(p.relative_to(stage)).replace(os.sep, '/') for p in stage.rglob('*') if p.is_file()}
        if actual != set(manifest) | {'manifest.json'}:
            raise ValueError('Manifest file set mismatch')
        for name, expected in manifest.items():
            if hashlib.sha256((stage / name).read_bytes()).hexdigest() != expected:
                raise ValueError('Checksum mismatch: ' + name)
        if not {'index.html', 'release.json', 'style.css', 'app.js'}.issubset(manifest):
            raise ValueError('Required site files missing')
        stage.chmod(0o755)
        os.replace(stage, destination)
        link = root / ('.current-' + deployment)
        link.symlink_to(destination, target_is_directory=True)
        os.replace(link, root / 'current')
        versions = sorted((p for p in releases.iterdir() if p.is_dir() and not p.is_symlink() and not p.name.startswith('.')), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in versions[3:]:
            if old.resolve() != (root / 'current').resolve():
                shutil.rmtree(old)
        print('Activated ' + deployment)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


if __name__ == '__main__':
    activate('/srv/inkdown', sys.argv[1], sys.argv[2])
