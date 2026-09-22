import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const sharp = createRequire(import.meta.url)(path.resolve(arg('--sharp', '../ArknightsEvidenceReview/node_modules/sharp')));
const plan = JSON.parse(await fs.readFile(path.join(root, 'data/npc/avatar-plan.json')));
const config = JSON.parse(await fs.readFile(path.join(root, 'scripts/npc-display-config.json')));
const originals = path.join(root, '.runtime/npc-originals');
const output = path.join(root, 'dist/avatars');
await fs.mkdir(originals, { recursive: true });
await fs.mkdir(output, { recursive: true });
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const manifestPath = path.join(root, 'assets/npc-manifest.json');
let previous = {};
try { previous = Object.fromEntries(JSON.parse(await fs.readFile(manifestPath)).assets.map(a => [a.id, a])); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const records = [];
let cursor = 0;
async function processAsset(asset) {
  const original = path.join(originals, asset.id + '.png');
  let raw;
  try { raw = await fs.readFile(original); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const temporary = original + '.part';
    await exec('curl', ['--fail', '--silent', '--show-error', '--location', '--connect-timeout', '15', '--max-time', '90', '--retry', '3', '--proto', '=https', '--proto-redir', '=https', '--output', temporary, asset.sourceUrl]);
    raw = await fs.readFile(temporary);
    await sharp(raw).metadata();
    await fs.rename(temporary, original);
  }
  const sourceSha256 = hash(raw);
  if (previous[asset.id]) assert.equal(sourceSha256, previous[asset.id].sourceSha256, `Portrait source changed: ${asset.name}`);
  const { data, info } = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * 4 + 3] > 24) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  assert.ok(maxX > minX && maxY > minY, `Empty portrait: ${asset.name}`);
  const height = maxY - minY + 1;
  const size = Math.min(info.width, info.height, Math.round(height * 0.37));
  let sumX = 0, count = 0;
  for (let y = minY; y < Math.min(maxY, minY + height * 0.22); y++) for (let x = minX; x <= maxX; x++) if (data[(y * info.width + x) * 4 + 3] > 128) { sumX += x; count++; }
  const center = count ? sumX / count : (minX + maxX) / 2;
  const automatic = { left: Math.max(0, Math.min(info.width - size, Math.round(center - size / 2))), top: Math.max(0, Math.min(info.height - size, Math.round(minY - height * 0.02))), width: size, height: size };
  const crop = config.portraits?.[asset.id]?.crop || automatic;
  const name = asset.id + '.webp';
  const file = path.join(output, name);
  await sharp(raw).extract(crop).resize(256, 256).flatten({ background: '#151a1d' }).webp({ quality: 88 }).toFile(file);
  const rendered = await fs.readFile(file);
  records.push({ ...asset, crop, filename: name, sourceSha256, sha256: hash(rendered), bytes: rendered.length, width: 256, height: 256 });
  if (records.length % 20 === 0 || records.length === plan.length) console.log(`Prepared ${records.length}/${plan.length} NPC avatars`);
}
await Promise.all(Array.from({ length: 3 }, async () => { while (cursor < plan.length) await processAsset(plan[cursor++]); }));
records.sort((a, b) => a.id.localeCompare(b.id));
await fs.writeFile(manifestPath, JSON.stringify({ source: 'PRTS 剧情角色一览与泰拉大典的游戏立绘', assets: records }, null, 2) + '\n');
console.log(JSON.stringify({ count: records.length, bytes: records.reduce((n, a) => n + a.bytes, 0), manifest: manifestPath }));
