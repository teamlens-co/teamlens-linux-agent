#!/usr/bin/env python3
"""Generate teamlens-linux-agent-latest.json for Tauri updater."""
import json, os, datetime, glob, re, sys

run_number = sys.argv[1] if len(sys.argv) > 1 else '0'

build_version = '0.1.{}'.format(run_number)

for path in ['src-tauri/tauri.conf.json', 'package.json']:
    with open(path) as f:
        cfg = json.load(f)
    if cfg.get('version') != build_version:
        cfg['version'] = build_version
        with open(path, 'w') as f:
            json.dump(cfg, f, indent=2)
        print('[OK] Updated {} version to {}'.format(path, build_version))

cargo_path = 'src-tauri/Cargo.toml'
with open(cargo_path) as f:
    cargo_toml = f.read()
updated_cargo_toml = re.sub(r'^version\s*=\s*"[^"]+"', 'version = "{}"'.format(build_version), cargo_toml, count=1, flags=re.MULTILINE)
if updated_cargo_toml != cargo_toml:
    with open(cargo_path, 'w') as f:
        f.write(updated_cargo_toml)
    print('[OK] Updated {} version to {}'.format(cargo_path, build_version))

bundle_dir = 'src-tauri/target/release/bundle'
installer_url = ''
signature = ''

appimage_dir = os.path.join(bundle_dir, 'appimage')
if os.path.isdir(appimage_dir):
    files = glob.glob(os.path.join(appimage_dir, '*.AppImage'))
    sig_files = glob.glob(os.path.join(appimage_dir, '*.AppImage.sig'))
    if files and sig_files:
        installer_name = os.path.basename(files[0])
        with open(sig_files[0]) as f:
            signature = f.read().strip()
        installer_url = 'https://github.com/teamlens-co/teamlens-linux-agent/releases/download/teamlens-linux-agent-v{}/{}'.format(run_number, installer_name)

data = {
    'version': build_version,
    'notes': 'TeamLens for Linux - Build #{}'.format(run_number),
    'pub_date': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    'platforms': {
        'linux-x86_64': {
            'signature': signature,
            'url': installer_url
        }
    }
}

os.makedirs('src-tauri/target/release', exist_ok=True)
os.makedirs(os.path.join(bundle_dir), exist_ok=True)

with open('src-tauri/target/release/teamlens-linux-agent-latest.json', 'w') as f:
    json.dump(data, f, indent=2)

with open(os.path.join(bundle_dir, 'teamlens-linux-agent-latest.json'), 'w') as f:
    json.dump(data, f, indent=2)

print('[OK] Generated updater JSON')
print(json.dumps(data, indent=2))
