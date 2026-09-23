import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { splitLayers } from './container-layers.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'container-layers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const build = path.join(root, 'build');
  const publicDirectory = path.join(root, 'public');
  for (const directory of [build, publicDirectory]) {
    await mkdir(path.join(directory, 'assets/licenses'), { recursive: true });
    await writeFile(path.join(directory, 'assets/licenses/notice.txt'), 'copyright');
    await writeFile(path.join(directory, 'assets/portrait.webp'), 'fixed image');
  }
  await writeFile(path.join(build, 'index.html'), '<script src="/assets/app.js"></script>');
  await writeFile(path.join(build, 'assets/app.js'), 'application');
  return { root, build, publicDirectory, output: path.join(root, 'out') };
}

test('merging the two layers preserves application, images and license bytes at the same URLs', async t => {
  const { build, publicDirectory, output } = await fixture(t);
  await splitLayers(build, publicDirectory, output);
  for (const [file, contents] of [
    ['static/assets/licenses/notice.txt', 'copyright'],
    ['static/assets/portrait.webp', 'fixed image'],
    ['app/assets/app.js', 'application'],
    ['app/index.html', '<script src="/assets/app.js"></script>'],
  ]) assert.equal(await readFile(path.join(output, file), 'utf8'), contents);
  await assert.rejects(stat(path.join(output, 'app/assets/portrait.webp')), { code: 'ENOENT' });
  assert.equal((await stat(path.join(output, 'static/assets/portrait.webp'))).mtimeMs, 0);
});

test('a Vite/public filename collision fails before moving the build', async t => {
  const { build, publicDirectory, output } = await fixture(t);
  await writeFile(path.join(build, 'assets/portrait.webp'), 'unexpected replacement');
  await assert.rejects(splitLayers(build, publicDirectory, output), /differs from public input/);
  assert.equal(await readFile(path.join(build, 'index.html'), 'utf8'), '<script src="/assets/app.js"></script>');
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
