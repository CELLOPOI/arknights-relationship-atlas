import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const vueModules = ['@vue/shared', '@vue/reactivity', '@vue/runtime-core', '@vue/runtime-dom'];

export async function prepareNotices() {
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  async function installedPackage(name, licenseFile) {
    const directory = path.join(root, 'node_modules', name);
    const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    if (metadata.name !== name || metadata.version !== lock.packages?.[`node_modules/${name}`]?.version
        || metadata.license !== 'MIT') {
      throw new Error(`Dependency notice requires the locked MIT package: ${name}`);
    }
    return { name, version: metadata.version, license: await readFile(path.join(directory, licenseFile), 'utf8') };
  }

  const vue = await Promise.all(vueModules.map(name => installedPackage(name, 'LICENSE')));
  const vite = await installedPackage('vite', 'LICENSE.md');
  if (vue.some(module => module.license !== vue[0].license)) {
    throw new Error('Vue runtime licenses differ; review notices before combining them');
  }
  // Vite 的包内声明还包含构建工具依赖；这里只保留实际进入网站的 helper 所属 core 段。
  const headings = [...vite.license.matchAll(/^# .+$/gm)];
  if (headings[0]?.index !== 0 || headings[0][0] !== '# Vite core license'
      || headings[1]?.[0] !== '# Licenses of bundled dependencies') {
    throw new Error('Vite license sections changed; review the runtime helper notice');
  }
  const viteCore = vite.license.slice(0, headings[1].index);
  for (const [name, license] of [['Vue', vue[0].license], ['Vite', viteCore]]) {
    if (!license.includes('Permission is hereby granted, free of charge')
        || !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')
        || !license.includes('Copyright (c)')) {
      throw new Error(`${name} complete MIT license is missing`);
    }
  }

  const contents = [
    'Frontend dependency notices\n\nVue runtime modules:\n',
    vue.map(module => `- ${module.name} ${module.version}\n`).join(''),
    '\n', vue[0].license,
    `\n\nVite ${vite.version}: generated modulepreload and preload helpers.\n\n`,
    viteCore,
  ].join('');
  const directory = path.join(root, 'public/assets/licenses');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'frontend-dependencies.txt'), contents);
}
