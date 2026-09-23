export class PreferenceError extends Error {
  constructor(public code: string, message: string, public status: number, public details: Record<string, unknown> = {}) { super(message); }
}

export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const csrf = document.cookie.split('; ').find(value => value.startsWith('csrftoken='))?.slice(10);
  let response: Response;
  try {
    response = await fetch(`/api/preferences/${path}`, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrf && method !== 'GET' ? { 'X-CSRFToken': decodeURIComponent(csrf) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new PreferenceError('network', '连接中断，请重试。原有题目和选择仍会保留。', 0); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new PreferenceError(data.code || 'unavailable', data.message || data.detail || '服务暂时不可用，请稍后重试。', response.status, data);
  return data as T;
}

// 网络结果不明时重用原操作键；新的内容才生成新键，双击和重试不另记一票。
export function operation(scope: string, body: object) {
  const signature = JSON.stringify(body);
  const key = `terra-preferences-operation:${scope}`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (saved?.signature === signature) return { ...body, operation_key: saved.key as string };
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, JSON.stringify({ signature, key: id }));
    return { ...body, operation_key: id };
  } catch { return { ...body, operation_key: crypto.randomUUID() }; }
}
export function finishOperation(scope: string) { try { sessionStorage.removeItem(`terra-preferences-operation:${scope}`); } catch { /* 存储不可用不影响服务端已确认结果。 */ } }

type Mutation = { path: string; method: string; body: object };
const unresolved = new Map<string, Mutation>(), inFlight = new Map<string, Promise<unknown>>();
export function pendingMutation(scope: string): Mutation | null {
  if (unresolved.has(scope)) return unresolved.get(scope)!;
  try {
    const value = JSON.parse(sessionStorage.getItem(`terra-preferences-pending:${scope}`) || 'null') as Mutation | null;
    if (value) unresolved.set(scope, value);
    return value;
  } catch { return null; }
}
export async function mutate<T>(scope: string, path: string, method: string, body: object): Promise<T> {
  if (inFlight.has(scope)) return inFlight.get(scope) as Promise<T>;
  // 未知结果锁定原对象、参数与操作键，直到明确响应；切页/刷新后的重试同样适用。
  const original = pendingMutation(scope) || { path, method, body: operation(scope, body) };
  unresolved.set(scope, original);
  try { sessionStorage.setItem(`terra-preferences-pending:${scope}`, JSON.stringify(original)); } catch { /* 内存继续保存。 */ }
  const clear = () => {
    unresolved.delete(scope); finishOperation(scope);
    try { sessionStorage.removeItem(`terra-preferences-pending:${scope}`); } catch { /* 已有确定响应。 */ }
  };
  const promise = request<T>(original.path, original.method, original.body).then(value => {
    clear(); document.dispatchEvent(new Event('atlas:preferences-changed')); return value;
  }).catch(reason => {
    if (reason instanceof PreferenceError && reason.status > 0 && reason.status < 500) clear();
    throw reason;
  }).finally(() => { inFlight.delete(scope); });
  inFlight.set(scope, promise);
  return promise;
}

export function timeText(value?: string | null) {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(value)) : '暂无';
}
