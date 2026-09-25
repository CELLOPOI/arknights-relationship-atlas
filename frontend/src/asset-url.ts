declare const __ASSET_VERSIONS__: { atlas: string; preferences: string };

// 只为固定清单所属路径加版本；API、外链和运行时生成的许可文件不在此范围。
export function assetUrl(url: string): string {
  if (typeof __ASSET_VERSIONS__ === 'undefined' || url.split('?')[0] === '/avatars/unknown.svg') return url;
  const kind = url.startsWith('/assets/preferences/') ? 'preferences'
    : /^\/(avatars\/|illustrations\/|assets\/(emblems[/.]|fonts\/)|favicon\.svg(?:\?|$))/.test(url) ? 'atlas' : null;
  return kind ? `/media/${__ASSET_VERSIONS__[kind]}${url}` : url;
}
