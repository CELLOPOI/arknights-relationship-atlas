import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSources, sourceLines, sourceReference, sourceTitle } from './source-display.js';

test('readable names preserve raw citations and avoid duplicate single-line ranges', () => {
  const source = { kind: 'story', source: 'activities/act23side/level_act23side_07_end.txt', title: '《登临意》 · WB-7 · “屏风卫” · 行动后', line: 251, endLine: 259, version: 'version-1' };
  const html = renderSources([source]);
  assert.ok(html.includes(source.title));
  assert.ok(html.includes(source.source));
  assert.ok(html.includes('第 251–259 行'));
  assert.ok(html.includes('version-1'));
  assert.ok(html.includes('<summary>原始记录</summary>'));
  assert.ok(!html.includes('<details class="evidence-source-record" open'));
  assert.equal(sourceLines({ ...source, endLine: 251 }), '第 251 行');
  assert.equal(sourceTitle({ source: 'new-source.txt' }), 'new-source.txt');
});

test('untrusted titles, paths, versions and link labels cannot become HTML', () => {
  const source = { kind: 'story', source: '<img src=x onerror=alert(1)>', title: '<script>bad()</script>', version: '<iframe>', referenceUrl: 'https://prts.wiki/w/剧情', referenceLabel: '<img src=x>' };
  const html = renderSources([source]);
  assert.ok(!/<script>|<img|<iframe>/.test(html));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  for (const referenceUrl of ['javascript:alert(1)', 'https://prts.wiki.evil.test/', 'http://prts.wiki/', 'https://user:pass@prts.wiki/']) {
    assert.equal(sourceReference({ ...source, referenceUrl }), '');
    assert.ok(!renderSources([{ ...source, referenceUrl }]).includes('<a '));
  }
});
