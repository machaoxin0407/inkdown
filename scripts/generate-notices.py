"""Collect installed dependency copyright/license texts for redistribution."""
import json
import os
import tomllib
from pathlib import Path

root = Path(__file__).resolve().parent.parent
sections = ["Inkdown — Third-party notices\n\nDependencies retain their respective licenses.\n"]

def include(folder, label, license_id):
    sections.append(f"\n{'=' * 72}\n{label}\nLicense: {license_id}\n")
    for path in sorted(folder.iterdir()):
        if path.is_file() and path.name.lower().startswith(('license', 'licence', 'copying', 'notice')):
            sections.append(f"\n--- {path.name} ---\n{path.read_text(encoding='utf-8', errors='replace')}\n")

lock = json.loads((root / 'package-lock.json').read_text(encoding='utf-8'))
count = 0
for key, package in lock['packages'].items():
    if not key or package.get('dev'):
        continue
    directory = root / key
    if not (directory / 'package.json').exists():
        continue
    meta = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
    include(directory, f"npm: {meta['name']} {meta['version']}", meta.get('license', 'See package license'))
    count += 1

cargo_home = root / '.tools' / 'cargo'
if not cargo_home.exists():
    cargo_home = Path(os.environ.get('CARGO_HOME', str(Path.home() / '.cargo')))
cargo_lock = tomllib.loads((root / 'src-tauri' / 'Cargo.lock').read_text(encoding='utf-8'))
for package in cargo_lock['package']:
    if not package.get('source', '').startswith('registry+'):
        continue
    for directory in (cargo_home / 'registry' / 'src').glob(f"*/{package['name']}-{package['version']}"):
        meta = tomllib.loads((directory / 'Cargo.toml').read_text(encoding='utf-8'))['package']
        include(directory, f"Rust: {package['name']} {package['version']}", meta.get('license', 'See package license'))
        count += 1
(root / 'THIRD_PARTY_NOTICES.txt').write_text(''.join(sections), encoding='utf-8')
print(f'Collected notices for {count} installed dependencies.')
