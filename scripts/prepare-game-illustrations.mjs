import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const output = path.join(root, 'dist/illustrations');
const manifestPath = path.join(root, 'assets/illustration-manifest.json');
const graph = JSON.parse(await fs.readFile(path.join(root, 'data/npc/graph.json')));
const digest = (data, algorithm = 'sha256') => crypto.createHash(algorithm).update(data).digest('hex');
const gitBlob = data => digest(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]), 'sha1');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

if (args.includes('--verify')) {
  const manifest = await readJson(manifestPath);
  const index = await readJson(path.join(output, 'index.json'));
  assert.deepEqual(Object.keys(index.people).sort(), graph.nodes.map(n => n.id).sort());
  for (const asset of manifest.assets) {
    const data = await fs.readFile(path.join(output, asset.filename));
    assert.equal(digest(data), asset.sha256, `Illustration checksum: ${asset.filename}`);
    const art = index.people[asset.id][asset.layer];
    assert.ok(art.src.startsWith(`/illustrations/${asset.filename}?v=`));
    assert.ok(art.width > 0 && art.height > 0);
  }
  for (const person of graph.nodes) {
    assert.ok(index.people[person.id].base, `Missing base illustration: ${person.name}`);
    if (person.isOperator === false) assert.ok(!index.people[person.id].elite2 && !index.people[person.id].elite2Portrait, `NPC has E2 artwork: ${person.name}`);
    if (index.people[person.id].elite2) assert.ok(index.people[person.id].elite2Portrait && index.people[person.id].basePortrait, `Missing phase close-up: ${person.name}`);
  }
  assert.ok(manifest.assets.find(a => a.id === 'char_002_amiya' && a.layer === 'base').sourcePath.endsWith('char_002_amiya_1+.png'));
  console.log(JSON.stringify({ verified: manifest.assets.length, people: graph.nodes.length, bytes: manifest.assets.reduce((n, a) => n + a.bytes, 0) }));
  process.exit(0);
}

const exec = promisify(execFile);
const sharp = createRequire(import.meta.url)(path.resolve(arg('--sharp', '../ArknightsEvidenceReview/node_modules/sharp')));
const source = {
  repository: 'fexli/ArknightsResource',
  commit: '3596def3267fe2b172ba20895b47e11c0523642f',
  committedAt: '2026-09-11T08:03:51Z',
  gameVersion: '26-09-09-07-16-57_d4e461',
  charpackTree: '39b1481ba3dfcfa115f93d5ee63e541ddd519a36',
  charporTree: '339b575aa6541c4205704f665ef13a652cdd2d5d',
  portraitFallback: { repository: 'yuanyan3060/ArknightsGameResource', commit: '57ef5385c1ab1315fe4f2094f399b5c803bd71fc', committedAt: '2026-09-11T10:07:52Z' },
};
const cache = path.join(root, '.runtime/game-art');
await fs.mkdir(path.join(cache, 'originals'), { recursive: true });
await fs.mkdir(output, { recursive: true });
async function download(url, file) {
  const temporary = `${file}.part`;
  await exec('curl', ['--fail', '--silent', '--show-error', '--location', '--connect-timeout', '15', '--max-time', '120', '--retry', '3', '--proto', '=https', '--proto-redir', '=https', '--output', temporary, url]);
  await fs.rename(temporary, file);
}

const treePath = path.join(cache, 'fexli-charpack-tree.json');
try { await fs.access(treePath); } catch {
  await download(`https://api.github.com/repos/${source.repository}/git/trees/${source.charpackTree}?recursive=1`, treePath);
}
const tree = await readJson(treePath);
assert.equal(tree.sha, source.charpackTree);
assert.equal(tree.truncated, false);
const files = new Map(tree.tree.map(file => [file.path, file]));
const portraitTreePath = path.join(cache, 'fexli-charpor-tree.json');
try { await fs.access(portraitTreePath); } catch {
  await download(`https://api.github.com/repos/${source.repository}/git/trees/${source.charporTree}`, portraitTreePath);
}
const portraitTree = await readJson(portraitTreePath);
assert.equal(portraitTree.sha, source.charporTree);
assert.equal(portraitTree.truncated, false);
const portraits = new Map(portraitTree.tree.map(file => [file.path, file]));
const skinFile = path.resolve(arg('--gamedata', path.join(root, '../ArknightsGameData/zh_CN/gamedata/excel/skin_table.json')));
const skinData = await fs.readFile(skinFile);
const skins = JSON.parse(skinData);
const npcs = new Map((await readJson(path.join(root, 'assets/npc-manifest.json'))).assets.map(asset => [asset.id, asset]));
let previous = new Map();
try { previous = new Map((await readJson(manifestPath)).assets.map(asset => [asset.filename, asset])); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const jobs = [];
const people = {};
for (const person of graph.nodes) {
  people[person.id] = {};
  if (person.isOperator === false) {
    const npc = npcs.get(person.id);
    assert.ok(npc, `Missing NPC source: ${person.name}`);
    people[person.id].generic = npc.generic;
    jobs.push({ id: person.id, name: person.name, layer: 'base', sourceUrl: npc.sourceUrl, sourceSha256: npc.sourceSha256, filePageUrl: npc.filePageUrl, generic: npc.generic, original: path.join(root, '.runtime/npc-originals', `${person.id}.png`) });
    continue;
  }
  const evolve = skins.buildinEvolveMap[person.id];
  assert.ok(evolve, `Missing evolution map: ${person.name}`);
  for (const [layer, skinId] of [['base', evolve['1'] || evolve['0']], ['elite2', evolve['2']]]) {
    if (!skinId && layer === 'elite2') continue;
    const skin = skins.charSkins[skinId];
    assert.ok(skin?.illustId, `Missing illustration ID: ${person.name} ${layer}`);
    const stem = skin.illustId.replace(/^illust_/, '');
    // b 文件是完整构图的低分辨率版本，不是头像；足够用于两侧的网页立绘。
    const file = files.get(`${stem}b.png`) || files.get(`${stem}.png`);
    assert.ok(file, `Missing source file: ${skin.illustId}`);
    const sourcePath = `charpack/${file.path}`;
    jobs.push({ id: person.id, name: person.name, layer, skinId, illustId: skin.illustId, sourcePath, sourceBlobSha1: file.sha, sourceUrl: `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${sourcePath.split('/').map(encodeURIComponent).join('/')}`, original: path.join(cache, 'originals', file.path) });
    if (evolve['2']) {
      const filename = `${skin.portraitId.replaceAll('#', '_')}.png`;
      const portrait = portraits.get(filename);
      const upstream = portrait ? source : source.portraitFallback;
      const portraitPath = `${portrait ? 'charpor' : 'portrait'}/${filename}`;
      jobs.push({ id: person.id, name: person.name, layer: `${layer}Portrait`, skinId, portraitId: skin.portraitId, sourcePath: portraitPath, sourceBlobSha1: portrait?.sha, sourceUrl: `https://raw.githubusercontent.com/${upstream.repository}/${upstream.commit}/${portraitPath.split('/').map(encodeURIComponent).join('/')}`, original: path.join(cache, 'portraits', filename) });
    }
  }
}

const records = [];
let cursor = 0;
async function prepare(job) {
  try { await fs.access(job.original); } catch {
    await fs.mkdir(path.dirname(job.original), { recursive: true });
    await download(job.sourceUrl, job.original);
  }
  const raw = await fs.readFile(job.original);
  const sourceSha256 = digest(raw);
  if (job.sourceSha256) assert.equal(sourceSha256, job.sourceSha256, `NPC source changed: ${job.name}`);
  if (job.sourceBlobSha1) assert.equal(gitBlob(raw), job.sourceBlobSha1, `Upstream blob mismatch: ${job.sourcePath}`);
  const filename = `${job.id}-${job.layer}.webp`;
  const existing = previous.get(filename);
  let rendered, details;
  if (existing?.sourceSha256 === sourceSha256 && existing.transform === 'alpha-bounds-1400-v1') {
    try {
      const saved = await fs.readFile(path.join(output, filename));
      if (digest(saved) === existing.sha256) { rendered = saved; details = existing; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!rendered) {
    const { data, info } = await sharp(raw).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 8) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    assert.ok(maxX > minX && maxY > minY, `Empty illustration: ${job.name}`);
    // 仅去除透明留白，保留完整人物、武器与精二背景，并保留 alpha 通道。
    const trim = { left: Math.max(0, minX - 2), top: Math.max(0, minY - 2), width: 0, height: 0 };
    trim.width = Math.min(info.width - trim.left, maxX - trim.left + 3);
    trim.height = Math.min(info.height - trim.top, maxY - trim.top + 3);
    const result = await sharp(raw).extract(trim).resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 84, alphaQuality: 95 }).toBuffer({ resolveWithObject: true });
    rendered = result.data;
    details = { width: result.info.width, height: result.info.height, originalWidth: info.width, originalHeight: info.height, trim, transform: 'alpha-bounds-1400-v1' };
    await fs.writeFile(path.join(output, filename), rendered);
  }
  const { original, ...provenance } = job;
  const record = { ...provenance, sourceSha256, filename, ...details, sha256: digest(rendered), bytes: rendered.length };
  records.push(record);
  people[job.id][job.layer] = { src: `/illustrations/${filename}?v=${record.sha256.slice(0, 12)}`, width: record.width, height: record.height };
  if (records.length % 40 === 0 || records.length === jobs.length) console.log(`Prepared ${records.length}/${jobs.length} game illustrations`);
}
await Promise.all(Array.from({ length: 6 }, async () => { while (cursor < jobs.length) await prepare(jobs[cursor++]); }));
records.sort((a, b) => a.filename.localeCompare(b.filename));
await fs.writeFile(manifestPath, JSON.stringify({ source, skinTableSha256: digest(skinData), assets: records }, null, 2) + '\n');
await fs.writeFile(path.join(output, 'index.json'), JSON.stringify({ version: 1, people }) + '\n');
console.log(JSON.stringify({ people: graph.nodes.length, illustrations: records.length, bytes: records.reduce((n, a) => n + a.bytes, 0) }));
