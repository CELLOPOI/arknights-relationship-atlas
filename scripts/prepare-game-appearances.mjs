import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyResources, resourceVersion } from '../assets/verify-resources.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
if (!args.includes('--output')) throw new Error('Provide --output pointing to a new local staging directory.');
const output = path.resolve(arg('--output'));
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (data, algorithm = 'sha256') => crypto.createHash(algorithm).update(data).digest('hex');
const manifest = await read(path.join(root, 'assets/resource-manifest.json'));
const sourceDirectory = path.resolve(arg('--source', path.join(root, 'assets/local', manifest.version)));
await verifyResources(sourceDirectory, manifest);
await fs.mkdir(output);
const resources = path.join(output, 'resources');
await fs.cp(sourceDirectory, resources, { recursive: true });
const sharp = createRequire(import.meta.url)(path.resolve(arg('--sharp', path.join(root, 'frontend/node_modules/sharp'))));
const catalog = await read(path.join(root, 'frontend/src/game/appearance-catalog.json'));
const source = (await read(path.join(root, 'assets/illustration-manifest.json'))).source;
const skinData = await fs.readFile(path.resolve(arg('--gamedata', path.join(root, '../ArknightsGameData/zh_CN/gamedata/excel/skin_table.json'))));
const skins = JSON.parse(skinData);
const index = await read(path.join(resources, 'illustrations/index.json'));
const cache = path.join(root, '.runtime/game-art');
const exec = promisify(execFile);
async function download(url, file) {
  try { await fs.access(file); return; } catch { /* 首次下载才访问固定提交。 */ }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await exec('curl', ['--fail', '--silent', '--show-error', '--location', '--connect-timeout', '15', '--max-time', '120', '--retry', '2', '--proto', '=https', '--proto-redir', '=https', '--output', `${file}.part`, url]);
  await fs.rename(`${file}.part`, file);
}
async function tree(name, sha) {
  const file = path.join(cache, `fexli-${name}-tree.json`);
  await download(`https://api.github.com/repos/${source.repository}/git/trees/${sha}?recursive=1`, file);
  const result = await read(file);
  assert.equal(result.sha, sha); assert.equal(result.truncated, false);
  return new Map(result.tree.map(row => [row.path, row]));
}
const packs = await tree('charpack', source.charpackTree);
const portraits = await tree('charpor', source.charporTree);
const jobs = [];
for (const appearance of catalog.appearances) {
  index.people[appearance.id] = {};
  const evolve = skins.buildinEvolveMap[appearance.id];
  assert.ok(evolve, `Missing evolution map: ${appearance.id}`);
  for (const [layer, skinId] of [['base', evolve['1'] || evolve['0']], ['elite2', evolve['2']]]) {
    assert.ok(skinId, `Missing stage: ${appearance.id}/${layer}`);
    const skin = skins.charSkins[skinId];
    const stem = skin.illustId.replace(/^illust_/, '');
    const pack = packs.get(`${stem}b.png`) || packs.get(`${stem}.png`);
    assert.ok(pack, `Missing artwork: ${skin.illustId}`);
    jobs.push({ id: appearance.id, layer, skinId, sourcePath: `charpack/${pack.path}`, sourceBlobSha1: pack.sha, upstream: source });
    const filename = `${skin.portraitId.replaceAll('#', '_')}.png`;
    const portrait = portraits.get(filename);
    jobs.push({ id: appearance.id, layer: `${layer}Portrait`, skinId,
      sourcePath: `${portrait ? 'charpor' : 'portrait'}/${filename}`, sourceBlobSha1: portrait?.sha,
      upstream: portrait ? source : source.portraitFallback });
  }
  jobs.push({ id: appearance.id, layer: 'avatar', sourcePath: `avatar/${appearance.id}.png`, upstream: source.portraitFallback });
}
const records = [];
async function prepare(job) {
  const url = `https://raw.githubusercontent.com/${job.upstream.repository}/${job.upstream.commit}/${job.sourcePath.split('/').map(encodeURIComponent).join('/')}`;
  const file = path.join(cache, 'appearances', job.upstream.commit, job.sourcePath);
  await download(url, file);
  const raw = await fs.readFile(file);
  if (job.sourceBlobSha1) assert.equal(hash(Buffer.concat([Buffer.from(`blob ${raw.length}\0`), raw]), 'sha1'), job.sourceBlobSha1, `Upstream blob mismatch: ${job.sourcePath}`);
  let rendering = sharp(raw);
  let trim;
  if (job.layer === 'avatar') rendering = rendering.resize({ width: 180, height: 180, fit: 'inside', withoutEnlargement: true });
  else {
    const { data, info } = await rendering.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let left = info.width, top = info.height, right = -1, bottom = -1;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] <= 8) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    assert.ok(right > left && bottom > top, `Empty artwork: ${job.id}/${job.layer}`);
    trim = { left: Math.max(0, left - 2), top: Math.max(0, top - 2), width: 0, height: 0 };
    trim.width = Math.min(info.width - trim.left, right - trim.left + 3);
    trim.height = Math.min(info.height - trim.top, bottom - trim.top + 3);
    rendering = sharp(raw).extract(trim).resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true });
  }
  const result = await rendering.webp({ quality: 84, alphaQuality: 95 }).toBuffer({ resolveWithObject: true });
  const filename = job.layer === 'avatar' ? `avatars/${job.id}.webp` : `illustrations/${job.id}-${job.layer}.webp`;
  await fs.writeFile(path.join(resources, filename), result.data);
  const sha256 = hash(result.data);
  records.push({ id: job.id, layer: job.layer, filename, sourceUrl: url, sourceBlobSha1: job.sourceBlobSha1,
    sourceSha256: hash(raw), skinId: job.skinId, trim, width: result.info.width, height: result.info.height,
    bytes: result.data.length, sha256 });
  if (job.layer !== 'avatar') index.people[job.id][job.layer] = { src: `/${filename}?v=${sha256.slice(0, 12)}`, width: result.info.width, height: result.info.height };
  if (records.length % 20 === 0 || records.length === jobs.length) console.log(`Prepared ${records.length}/${jobs.length} appearance assets`);
}
let cursor = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (cursor < jobs.length) await prepare(jobs[cursor++]); }));
await fs.writeFile(path.join(resources, 'illustrations/index.json'), JSON.stringify(index) + '\n');
const files = [];
async function inventory(directory, prefix = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await inventory(path.join(directory, entry.name), `${name}/`);
    else { const raw = await fs.readFile(path.join(directory, entry.name)); files.push({ path: name, bytes: raw.length, sha256: hash(raw) }); }
  }
}
await inventory(resources);
files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const nextManifest = { ...manifest, version: resourceVersion(files), files };
await verifyResources(resources, nextManifest);
await fs.writeFile(path.join(output, 'resource-manifest.json'), JSON.stringify(nextManifest, null, 2) + '\n');
records.sort((a, b) => a.filename.localeCompare(b.filename));
await fs.writeFile(path.join(output, 'appearance-manifest.json'), JSON.stringify({ source, skinTableSha256: hash(skinData), characterTableSha256: catalog.characterTableSha256, assets: records }, null, 2) + '\n');
console.log(JSON.stringify({ output, version: nextManifest.version, appearances: catalog.appearances.length, newFiles: records.length }));
