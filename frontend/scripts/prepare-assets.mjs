import { cp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyResources } from '../../assets/verify-resources.mjs';
import { prepareNotices } from './prepare-notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, '../assets/resource-manifest.json'), 'utf8'));
const source = path.resolve(process.env.ATLAS_ASSET_DIR || path.join(root, '../assets/local', manifest.version));
await verifyResources(source, manifest);
await mkdir(path.join(root, 'public/avatars'), { recursive: true });
for (const directory of ['assets', 'avatars', 'illustrations']) {
  await rm(path.join(root, 'public', directory), { recursive: true, force: true });
  await cp(path.join(source, directory), path.join(root, 'public', directory), { recursive: true });
}
await copyFile(path.join(source, 'favicon.svg'), path.join(root, 'public/favicon.svg'));
await copyFile(path.join(root, 'static/unknown.svg'), path.join(root, 'public/avatars/unknown.svg'));
// 喜好素材拥有独立固定清单；先完整校验，再复制，日常构建不下载上游。
await import('../../scripts/verify-preferences-assets.mjs');
await cp(path.join(root, '../assets/preferences'), path.join(root, 'public/assets/preferences'), { recursive: true });
await prepareNotices();
