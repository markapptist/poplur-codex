from pathlib import Path
import hashlib
import json
import sys
import zipfile

root = Path('/Users/matrix/Developer')
ios = root / 'Poplur2025-iOS/ClayMapWeb'
android = root / 'Poplur2025-Android/app/src/main/assets/claymap'
rn = root / 'Poplur2025-ReactNative/src/assets/claymap'

def tree(directory):
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob('*') if p.is_file() and p.name != '.DS_Store'}

def markers(directory):
    text = '\n'.join(p.read_text() for p in directory.glob('*.js'))
    required = ['global.block', 'feedTitleScrolls', 'feedHeadlineSwap',
                'data-profile-safety-dialog', 'traverseOwner',
                'poplur-claims-overview', 'analyticsEvent', 'Review your capture',
                'data-feed-timer', 'photoViewSeconds']
    missing = [m for m in required if m not in text]
    css = '\n'.join(p.read_text() for p in directory.glob('*.css'))
    if '--profile-control-top' not in css:
        missing.append('profile rail alignment')
    for size in (256, 512):
        if not (directory / f'poplur-side-buttons/assets/{size}/global/block.png').is_file():
            missing.append(f'{size}px supplied block art')
    if missing:
        raise SystemExit(f'{directory}: missing {missing}')

expected = tree(ios)
assert expected == tree(android), 'iOS and Android bundles differ'
with zipfile.ZipFile(rn / 'claymap.zip') as z:
    archived = {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()
                if not n.endswith('/') and not n.endswith('.DS_Store')}
assert archived == expected, 'React Native archive differs'
metadata = json.loads((rn / 'bundle.json').read_text())
assert hashlib.sha256((rn / 'claymap.zip').read_bytes()).hexdigest() == metadata['sha256']
markers(ios)
if len(sys.argv) > 1:
    app = Path(sys.argv[1]) / 'ClayMapWeb'
    assert tree(app) == expected, 'Built iPhone app carries a different web bundle'
    markers(app)
print(f'PASS: {len(expected)} identical files across iOS, Android and RN; all takeover markers and supplied block artwork present.')
