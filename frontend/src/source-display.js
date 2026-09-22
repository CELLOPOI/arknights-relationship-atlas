/** @param {import('./types').Source} source */
export function sourceTitle(source) {
  return source.title || source.source;
}

/** @param {import('./types').Source} source */
export function sourceLines(source) {
  if (source.line == null) return '';
  return `第 ${source.line}${source.endLine != null && source.endLine !== source.line ? `–${source.endLine}` : ''} 行`;
}

/** @param {import('./types').Source} source */
export function sourceReference(source) {
  if (!source.referenceUrl) return '';
  try {
    const url = new URL(source.referenceUrl);
    return url.protocol === 'https:' && url.hostname === 'prts.wiki' && !url.username && !url.password
      ? url.href : '';
  } catch { return ''; }
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/** 原生图谱与 Vue 面板使用相同的格式规则；所有来源文本在写入 HTML 前转义。
 * @param {import('./types').Source[]} sources
 */
export function renderSources(sources) {
  return `<ul class="evidence-source-list">${sources.map(source => {
    const url = sourceReference(source);
    return `<li class="evidence-source-item">
      <span class="evidence-source-title">${escape(sourceTitle(source))}</span>
      ${url ? `<a class="evidence-source-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(source.referenceLabel || 'PRTS 对照')}</a>` : ''}
      <details class="evidence-source-record"><summary>原始记录</summary><div>
        <code>${escape(source.source)}</code>
        ${sourceLines(source) ? `<span>${escape(sourceLines(source))}</span>` : ''}
        ${source.version ? `<span>版本：${escape(source.version)}</span>` : ''}
      </div></details>
    </li>`;
  }).join('')}</ul>`;
}
