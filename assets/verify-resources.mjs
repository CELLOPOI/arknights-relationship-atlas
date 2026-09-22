import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha = value => createHash('sha256').update(value).digest('hex');
export const resourceVersion = files => `atlas-assets-${sha(canonical(files)).slice(0, 24)}`;

export function validateResourceManifest(manifest) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  if (!exact(manifest, ['schema_version', 'version', 'rights_status', 'files']) || manifest.schema_version !== 1
    || !['unreviewed', 'cleared', 'limited'].includes(manifest.rights_status) || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Invalid resource manifest.');
  }
  const seen = new Set();
  for (const record of manifest.files) {
    if (!exact(record, ['path', 'bytes', 'sha256']) || typeof record.path !== 'string'
      || record.path.includes('\\') || record.path.startsWith('/') || record.path.split('/').some(part => !part || part === '.' || part === '..')
      || !(record.path === 'favicon.svg' || ['assets', 'avatars', 'illustrations'].includes(record.path.split('/')[0]))
      || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)
      || seen.has(record.path)) throw new Error('Invalid or duplicate resource record.');
    seen.add(record.path);
  }
  if (!seen.has('favicon.svg') || ['assets', 'avatars', 'illustrations'].some(directory => ![...seen].some(name => name.startsWith(`${directory}/`)))) {
    throw new Error('Resource manifest is incomplete.');
  }
  if (manifest.version !== resourceVersion(manifest.files)) throw new Error('Invalid resource version.');
  return manifest;
}

export function validateIllustrationIndex(index, manifest) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(index) || index.version !== 1 || Object.keys(index).sort().join(',') !== 'people,version' || !object(index.people)) {
    throw new Error('Invalid illustration index.');
  }
  const files = new Map(manifest.files.map(row => [`/${row.path}`, row]));
  for (const [id, art] of Object.entries(index.people)) {
    if (!id || !object(art) || !art.base || Object.keys(art).some(key => !['base', 'basePortrait', 'elite2', 'elite2Portrait', 'generic'].includes(key))) {
      throw new Error(`Invalid illustration entry: ${id}`);
    }
    for (const [layer, value] of Object.entries(art)) {
      if (layer === 'generic') {
        if (typeof value !== 'boolean') throw new Error(`Invalid generic illustration marker: ${id}`);
        continue;
      }
      if (!object(value) || Object.keys(value).sort().join(',') !== 'height,src,width'
        || !Number.isSafeInteger(value.width) || value.width <= 0 || !Number.isSafeInteger(value.height) || value.height <= 0
        || typeof value.src !== 'string') throw new Error(`Invalid illustration fields: ${id}/${layer}`);
      const match = value.src.match(/^(\/illustrations\/[^?#]+)(?:\?v=([a-f0-9]{12}))?$/);
      const file = match && files.get(match[1]);
      if (!file || (match[2] && !file.sha256.startsWith(match[2]))) {
        throw new Error(`Missing illustration or incorrect version: ${id}/${layer}`);
      }
    }
  }
}

export async function verifyResources(root, manifest) {
  validateResourceManifest(manifest);
  const expected = new Set(manifest.files.map(record => record.path));
  const actual = new Set();
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Resource symlink is not allowed: ${name}`);
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), `${name}/`);
      else actual.add(name);
    }
  }
  try {
    if ((await lstat(root)).isSymbolicLink()) throw new Error('Resource root cannot be a symlink.');
    await walk(root);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Resource package ${manifest.version} is missing. Run make assets-install ASSET_PACKAGE=/path/to/package.tar.gz from the repository root.`);
    throw error;
  }
  if (actual.size !== expected.size || [...actual].some(name => !expected.has(name))) throw new Error('Resource package file list differs from its manifest.');
  for (const record of manifest.files) {
    if (record.path.includes('\\') || record.path.startsWith('/') || record.path.split('/').some(value => !value || value === '..' || value === '.')) throw new Error('Unsafe resource path.');
    const content = await readFile(path.join(root, record.path));
    if (content.length !== record.bytes || sha(content) !== record.sha256) throw new Error(`Missing or corrupt resource: ${record.path}`);
  }
  if (expected.has('illustrations/index.json')) {
    validateIllustrationIndex(JSON.parse(await readFile(path.join(root, 'illustrations/index.json'), 'utf8')), manifest);
  }
}
