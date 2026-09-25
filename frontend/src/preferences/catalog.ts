import { PreferenceError, request } from './api';
import type { Catalog, Config } from './types';

export type Runtime = { catalog_version: string | null; server_time: string; config: Config };

export async function readCatalog(previous: Catalog | null = null): Promise<{ catalog: Catalog; config: Config }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const runtime = await request<Runtime>('runtime/');
    if (!runtime.catalog_version) throw new Error('喜好目录尚未发布，请稍后重试。');
    if (runtime.catalog_version === previous?.version) return { catalog: previous, config: runtime.config };
    try {
      const result = await request<{ catalog: Catalog }>(`directory/?version=${encodeURIComponent(runtime.catalog_version)}`, 'GET', undefined, 'no-cache');
      if (result.catalog.version !== runtime.catalog_version) throw new Error('喜好目录已变化，请重新读取。');
      return { catalog: result.catalog, config: runtime.config };
    } catch (reason) {
      if (!(reason instanceof PreferenceError) || reason.code !== 'catalog_conflict' || attempt === 2) throw reason;
    }
  }
  throw new Error('喜好目录已变化，请重新读取。');
}
