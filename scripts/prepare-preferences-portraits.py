"""从固定完整立绘派生半身卡面；自动建议与逐图复核分别记录。"""
import argparse
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--cascade', required=True, type=Path)
parser.add_argument('--workers', type=int, default=6)
parser.add_argument('--appearance', action='append', help='Regenerate only these appearance IDs; repeat as needed')
parser.add_argument('--revision', help='Write corrected portraits to a new immutable path segment')
args = parser.parse_args()
if args.revision and not re.fullmatch(r'[A-Za-z0-9_-]+', args.revision):
    parser.error('--revision must be a single alphanumeric path segment')
cv2.setNumThreads(1)
catalog_path = ROOT / 'data/preferences/catalog.json'
catalog = json.loads(catalog_path.read_text())
focus_path = ROOT / 'data/preferences/portrait-focus.json'
previous = json.loads(focus_path.read_text()) if focus_path.exists() else {'portraits': {}}
model_hash = hashlib.sha256(args.cascade.read_bytes()).hexdigest()
if model_hash != '9376d30ac38db6bda2a68b88b3b76bbd7e6aa33af47f7f5c76bc88ca75f1ce30':
    raise ValueError('Anime face model does not match the fixed source commit')
output = ROOT / 'assets/preferences/v2/portrait'
if args.revision:
    output /= args.revision
output.mkdir(parents=True, exist_ok=True)


def make(item):
    src = ROOT / item['image_url'].lstrip('/')
    source_hash = hashlib.sha256(src.read_bytes()).hexdigest()
    im = cv2.imread(str(src), cv2.IMREAD_UNCHANGED)
    h, w = im.shape[:2]
    if im.shape[2] == 3:
        im = cv2.cvtColor(im, cv2.COLOR_BGR2BGRA)
    old = previous['portraits'].get(item['id'], {})
    if old.get('source_sha256') == source_hash:
        entry = dict(old)
    else:
        gray = cv2.cvtColor(im[:, :, :3], cv2.COLOR_BGR2GRAY)
        gray = np.asarray(gray * (im[:, :, 3] / 255) + 220 * (1 - im[:, :, 3] / 255), dtype=np.uint8)
        detector = cv2.CascadeClassifier(str(args.cascade))
        faces = detector.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=3, minSize=(24, 24))
        faces = [list(map(int, f)) for f in faces]
        # 优先较大的主体脸；仅是候选，不能据此声称全部人工精修。
        faces.sort(key=lambda f: f[2] * f[3] * (1 - 0.45 * abs((f[0] + f[2] / 2) / w - .5)), reverse=True)
        if faces:
            x, y, fw, fh = faces[0]
            cw = min(w, max(fw * 3.15, fh * 2.75))
            cx, cy = x + fw / 2, y + fh / 2
            rect = [cx - cw / 2, cy - cw * 1.48 * .28, cw, cw * 1.48]
        else:
            cw = min(w, h / 1.48, max(w * .68, h * .38))
            rect = [(w - cw) / 2, 0, cw, cw * 1.48]
        entry = {'source_sha256': source_hash, 'source_size': [w, h], 'face_candidates': faces,
                 'crop': [round(v, 3) for v in rect], 'method': 'anime-face-proposal' if faces else 'composition-proposal',
                 'reviewed': False}
    x, y, cw, ch = entry['crop']
    # 边界外保持透明；不拉伸也不重绘脸，详情沿用完整立绘。
    transform = np.array([[480 / cw, 0, -x * 480 / cw], [0, 710 / ch, -y * 710 / ch]], dtype=np.float32)
    cropped = cv2.warpAffine(im, transform, (480, 710), flags=cv2.INTER_AREA, borderMode=cv2.BORDER_CONSTANT)
    target = output / (src.stem + '.webp')
    cv2.imwrite(str(target), cropped, [cv2.IMWRITE_WEBP_QUALITY, 86])
    raw = target.read_bytes()
    entry['portrait_url'] = '/' + target.relative_to(ROOT).as_posix()
    entry['portrait_sha256'] = hashlib.sha256(raw).hexdigest()
    file = {'path': target.relative_to(ROOT / 'assets/preferences').as_posix(), 'bytes': len(raw),
            'sha256': entry['portrait_sha256'], 'width': 480, 'height': 710}
    return item['id'], entry, file


selected = set(args.appearance or [])
known = {item['id'] for item in catalog['appearances']}
if selected - known:
    raise ValueError(f'Unknown appearance IDs: {sorted(selected - known)}')
if selected and known - selected - previous['portraits'].keys():
    raise ValueError('Partial regeneration requires existing portraits for all other appearances')
items = [item for item in catalog['appearances'] if not selected or item['id'] in selected]
rows = list(ThreadPoolExecutor(max_workers=args.workers).map(make, items))
portraits = {key: entry for key, entry in previous['portraits'].items() if key in known}
portraits.update({key: entry for key, entry, _ in rows})
focus = {'version': 2, 'model': {'repository': 'nagadomi/lbpcascade_animeface',
    'commit': '4433ab1ae1166ea75acfe99eb0f18709dac329a0', 'sha256': model_hash},
    'transform': 'transparent-affine-crop-480x710-webp86', 'portraits': portraits}
focus_path.write_text(json.dumps(focus, ensure_ascii=False, indent=2) + '\n')
for item in catalog['appearances']:
    p = focus['portraits'][item['id']]
    item['portrait_url'] = p['portrait_url']
    item['focus'] = {k: p[k] for k in ('crop', 'method', 'reviewed')}
manifest_path = ROOT / 'assets/preferences-manifest.json'
manifest = json.loads(manifest_path.read_text())
files = {f['path']: f for f in manifest['files']}
files.update({row[2]['path']: row[2] for row in rows})
manifest['files'] = sorted(files.values(), key=lambda f: f['path'])
version = 'preferences-assets-' + hashlib.sha256(json.dumps([[f['path'], f['sha256']] for f in manifest['files']], separators=(',', ':')).encode()).hexdigest()[:24]
catalog['asset_version'] = manifest['version'] = version
catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
manifest['catalog_sha256'] = hashlib.sha256(catalog_path.read_bytes()).hexdigest()
manifest['portrait_focus_sha256'] = hashlib.sha256(focus_path.read_bytes()).hexdigest()
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'portraits': len(rows), 'no_face_proposal': sum(not x[1]['face_candidates'] for x in rows), 'reviewed': sum(x[1]['reviewed'] for x in rows)}))
