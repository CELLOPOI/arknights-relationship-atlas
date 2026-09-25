import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const read = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
export async function assetVersions() {
  const [atlas, preferences] = await Promise.all([
    read('../../assets/resource-manifest.json'), read('../../assets/preferences-manifest.json'),
  ]);
  // 只绑定实际文件内容；名录和构建代码变化不使图片缓存失效。
  const hash = files => createHash('sha256').update(JSON.stringify(files.map(({ path, sha256 }) => [path, sha256]).sort())).digest('hex').slice(0, 24);
  return { atlas: hash(atlas.files), preferences: hash(preferences.files) };
}

export function assetRoutes(versions) {
  return Object.entries(versions).map(([kind, version]) => {
    const prefix = `/media/${version}`;
    const paths = kind === 'preferences' ? ['/assets/preferences/*']
      : ['/avatars/*', '/illustrations/*', '/assets/emblems/*', '/assets/emblems.json', '/assets/fonts/*', '/favicon.svg'];
    return `@immutable_${kind} {
    path ${paths.map(p => prefix + p).join(' ')}
    not path ${prefix}/avatars/unknown.svg
}
handle @immutable_${kind} {
    uri strip_prefix ${prefix}
    root * /srv/web
    route {
        @existing_${kind} file
        handle @existing_${kind} {
            header Cache-Control "public, max-age=31536000, immutable"
            file_server
        }
        handle {
            header Cache-Control "no-store"
            respond 404
        }
    }
}
`;
  }).join('\n');
}

export function assetDeliveryPlugin(versions) {
  const middleware = server => { server.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/media/')) return next();
    const match = req.url.match(/^\/media\/([a-f0-9]{24})(\/.*)$/);
    const url = match?.[2] || '';
    const kind = url.startsWith('/assets/preferences/') ? 'preferences' : 'atlas';
    if (!match || match[1] !== versions[kind]
        || !/^\/(avatars\/|illustrations\/|assets\/(preferences\/|emblems[/.]|fonts\/)|favicon\.svg(?:\?|$))/.test(url)
        || url.split('?')[0] === '/avatars/unknown.svg') {
      res.statusCode = 404; res.setHeader('Cache-Control', 'no-store'); res.end(); return;
    }
    req.url = url;
    next();
  }); };
  return { name: 'atlas-asset-delivery', configureServer: middleware, configurePreviewServer: middleware };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(process.argv[2], assetRoutes(await assetVersions()));
}
