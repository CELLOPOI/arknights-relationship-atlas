import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const here = path.dirname(new URL(import.meta.url).pathname);
const output = path.resolve(process.argv[2] || here);
const plan = JSON.parse(await fs.readFile(path.join(here, 'asset-plan.json'), 'utf8'));
const earlyOnly = process.argv.includes('--early');
await fs.mkdir(path.join(output, 'avatars'), { recursive: true });
const manifest = { repository: plan.repository, commit: plan.commit, missing: [], assets: {} };
try { Object.assign(manifest.assets, JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8')).assets); } catch {}
const entries = plan.assets.filter(a => !earlyOnly || a.priority);
let next = 0;
async function worker() {
  while (next < entries.length) {
    const asset = entries[next++];
    const filename = `avatars/${asset.id}.png`;
    const target = path.join(output, filename);
    const url = `https://raw.githubusercontent.com/${plan.repository}/${plan.commit}/${asset.sourcePath}`;
    try {
      let data;
      try { data = await fs.readFile(target); } catch {}
      if (!data) {
        await run('curl', ['-fsSL', '--retry', '3', '--max-time', '90', url, '-o', `${target}.part`]);
        data = await fs.readFile(`${target}.part`);
      }
      if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG signature or IHDR');
      const blobSha = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
      if (blobSha !== asset.gitBlobSha || data.length !== asset.expectedBytes) throw new Error('Source blob hash or size mismatch');
      await fs.writeFile(target, data);
      await fs.rm(`${target}.part`, { force: true });
      manifest.assets[asset.id] = { name: asset.name, filename, sourcePath: asset.sourcePath, sourceUrl: url, commit: plan.commit, missing: false, gitBlobSha: blobSha, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
      console.log(`OK ${asset.id} ${asset.name}`);
    } catch (error) {
      manifest.assets[asset.id] = { name: asset.name, filename, sourcePath: asset.sourcePath, commit: plan.commit, missing: true, error: error.message };
      console.error(`FAILED ${asset.id}: ${error.message}`);
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
manifest.missing = Object.entries(manifest.assets).filter(([, a]) => a.missing).map(([id]) => id);
manifest.expectedCount = plan.assets.length;
manifest.downloadedCount = Object.values(manifest.assets).filter(a => !a.missing).length;
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ downloaded: manifest.downloadedCount, expected: manifest.expectedCount, missing: manifest.missing }));
if (manifest.missing.length) process.exitCode = 1;
