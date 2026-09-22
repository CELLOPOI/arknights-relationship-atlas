import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resourceVersion, validateIllustrationIndex, validateResourceManifest, verifyResources } from './verify-resources.mjs';

const content = Buffer.from('fixture');
function fixture() {
  const files = ['assets/a.txt', 'avatars/a.txt', 'favicon.svg', 'illustrations/a.txt'].map(name => ({
    path: name, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex')
  }));
  return { schema_version: 1, rights_status: 'unreviewed', files, version: resourceVersion(files) };
}

test('recomputed version does not excuse invalid schema, duplicate files or unsafe paths', () => {
  const mutations = [
    m => m.files.push(m.files[0]), m => { m.rights_status = 'invented'; }, m => { m.unknown = true; },
    m => { m.schema_version = true; }, m => { m.files[0].path = '../outside'; },
    m => { m.files[0].path = 'private/a.txt'; }, m => { m.files[0].bytes = true; },
    m => { m.files = m.files.filter(row => row.path !== 'favicon.svg'); },
    m => { m.files = m.files.filter(row => !row.path.startsWith('avatars/')); },
  ];
  assert.doesNotThrow(() => validateResourceManifest(fixture()));
  for (const mutate of mutations) {
    const manifest = fixture(); mutate(manifest); manifest.version = resourceVersion(manifest.files);
    assert.throws(() => validateResourceManifest(manifest));
  }
});

test('illustration references must resolve within the package and match their cache version', () => {
  const manifest = fixture();
  const file = manifest.files.find(row => row.path.startsWith('illustrations/'));
  const illustration = { src: `/${file.path}?v=${file.sha256.slice(0, 12)}`, width: 100, height: 200 };
  const index = { version: 1, people: { person: { base: illustration, generic: false } } };
  validateIllustrationIndex(index, manifest);
  for (const src of ['/illustrations/missing.webp', `/${file.path}?v=000000000000`, `https://example.test/${file.path}`, `/${file.path}?unexpected=1`]) {
    assert.throws(() => validateIllustrationIndex({ ...index, people: { person: { base: { ...illustration, src } } } }, manifest), /Missing illustration/);
  }
  for (const art of [{ elite2: illustration }, { base: { ...illustration, width: 0 } }, { base: illustration, generic: 'yes' }]) {
    assert.throws(() => validateIllustrationIndex({ ...index, people: { person: art } }, manifest), /Invalid/);
  }
});

test('build verification detects corruption, symlinks and unexpected files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-assets-test-'));
  try {
    const manifest = fixture();
    for (const row of manifest.files) {
      await mkdir(path.dirname(path.join(root, row.path)), { recursive: true });
      await writeFile(path.join(root, row.path), content);
    }
    await verifyResources(root, manifest);
    await writeFile(path.join(root, 'favicon.svg'), 'corrupt');
    await assert.rejects(verifyResources(root, manifest), /corrupt/);
    await writeFile(path.join(root, 'favicon.svg'), content);
    await symlink(path.join(root, 'favicon.svg'), path.join(root, 'extra'));
    await assert.rejects(verifyResources(root, manifest), /symlink/);
    await rm(path.join(root, 'extra'));
    await writeFile(path.join(root, 'extra'), 'unexpected');
    await assert.rejects(verifyResources(root, manifest), /file list/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
