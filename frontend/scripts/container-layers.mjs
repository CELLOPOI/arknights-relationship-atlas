import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rename, utimes } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(directory, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Unsupported static entry: ${name}`);
  }
  return result.sort();
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function normalize(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await normalize(file);
    else {
      await chmod(file, 0o644);
      await utimes(file, 0, 0);
    }
  }
  await chmod(directory, 0o755);
  await utimes(directory, 0, 0);
}

export async function splitLayers(build, publicDirectory, output) {
  // 以 public 的完整清单分层，不依赖扩展名，保留字体许可、头像、索引等所有文件。
  const names = await files(publicDirectory);
  for (const name of names) {
    const built = path.join(build, name);
    if (!(await lstat(built)).isFile()
        || digest(await readFile(built)) !== digest(await readFile(path.join(publicDirectory, name)))) {
      throw new Error(`Built static file differs from public input: ${name}`);
    }
  }
  await mkdir(output); // 拒绝覆盖上次构建输出。
  const application = path.join(output, 'app');
  const assets = path.join(output, 'static');
  await rename(build, application);
  await mkdir(assets);
  for (const name of names) {
    const target = path.join(assets, name);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(path.join(application, name), target);
  }
  // Node 复制素材时会产生新时间；固定元数据让冷构建也能复用相同的素材层。
  await normalize(assets);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 5) throw new Error('Usage: container-layers.mjs BUILD PUBLIC OUTPUT');
  await splitLayers(...process.argv.slice(2).map(value => path.resolve(value)));
}
