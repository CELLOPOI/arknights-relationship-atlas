import { effectScope, reactive, watch, type UnwrapNestedRefs } from 'vue';

// 只保存当前浏览器草稿与操作上下文；跨入口卸载不丢失，服务器状态始终另行读取。
const drafts = new Map<string, object>();
export function preferenceDraft<T extends object>(key: string, initial: T): UnwrapNestedRefs<T> {
  const name = `terra-preferences-draft:${key}`;
  if (drafts.has(name)) return drafts.get(name) as UnwrapNestedRefs<T>;
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(name) || '{}'); } catch { /* 内存草稿仍可使用。 */ }
  const draft = reactive({ ...initial, ...saved, ...('busy' in initial ? { busy: false } : {}) }) as UnwrapNestedRefs<T>;
  drafts.set(name, draft);
  effectScope(true).run(() => watch(draft, value => {
    try { sessionStorage.setItem(name, JSON.stringify({ ...value, ...('busy' in value ? { busy: false } : {}) })); }
    catch { /* 储存配额不足时仍保留当前会话的内存草稿。 */ }
  }, { deep: true, flush: 'sync' }));
  return draft;
}
