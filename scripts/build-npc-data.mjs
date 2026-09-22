import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { parseStory } from '../../ArknightsStoryCatalog/scripts/story-parser.mjs';

const root = path.resolve(import.meta.dirname, '..');
const workspace = path.dirname(root);
const npcRoot = 'ArknightsNpcCatalog/';
const reviewRoot = npcRoot + '关系审读/';
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const uniq = values => [...new Set(values)];
const pairKey = ids => [...ids].sort().join('|');

export function readableQuote(raw) {
  return parseStory(raw).events.map(e => {
    if (e.type === 'dialogue') return `${e.speaker ? e.speaker + '：' : ''}${e.text}`;
    if (e.type === 'decision') return '选项：\n' + e.options.map(o => `${o.value}：${o.label}`).join('\n');
    if (e.type === 'branch') return e.references.length ? `分支条件（原选项编号）：${e.references.join(' / ')}` : '分支结束，继续正文';
    return e.text;
  }).filter(Boolean).join('\n');
}

// 只在网站侧派生数据，人工意见与原审读文件保留原样。规则见 docs/NPC_IMPORT.md。
export function validateReviews(dataset, store) {
  assert.equal(dataset.version, sha({ cases: dataset.cases, sourceRegistry: dataset.sources }), 'Review dataset checksum changed');
  assert.deepEqual(Object.keys(store.reviews).sort(), dataset.cases.map(c => c.id).sort(), 'Review coverage is incomplete');
  for (const c of dataset.cases) {
    const { fingerprint, ...content } = c;
    const r = store.reviews[c.id];
    assert.equal(fingerprint, sha(content), `Case checksum changed: ${c.id}`);
    assert.equal(r.caseFingerprint, fingerprint, `Stale review: ${c.id}`);
    assert.equal(r.datasetVersion, dataset.version, `Stale dataset: ${c.id}`);
    assert.ok(c.options.some(o => o.value === r.choice), `Unknown choice: ${c.id}`);
    assert.ok(!['unsure', 'other'].includes(r.choice), `Unresolved review: ${c.id}`);
  }
}

export function mergeDirections(contributions) {
  const supported = new Set(contributions.flatMap(p => p.directions.filter(d => d.status === 'supported').map(d => `${d.from}|${d.to}`)));
  if (!supported.size) return null;
  assert.ok(supported.size <= 2, 'Invalid direction count');
  if (supported.size === 2) return { kind: 'mutual' };
  const [from, to] = [...supported][0].split('|');
  return { kind: 'awareness', from, to };
}

export function buildNpcData(output = path.join(root, 'data/npc')) {
  const inputs = new Map();
  const rawCache = new Map();
  function bytes(relative) {
    const absolute = path.resolve(workspace, relative);
    assert.ok(absolute.startsWith(workspace + path.sep), 'Source outside workspace');
    if (!rawCache.has(relative)) {
      const raw = fs.readFileSync(absolute);
      rawCache.set(relative, raw);
      inputs.set(relative, sha(raw));
    }
    return rawCache.get(relative);
  }
  const read = relative => JSON.parse(bytes(relative));
  const base = read('ArknightsRelationshipGraph/dist/data/graph.json');
  const baseEvidence = read('ArknightsRelationshipGraph/dist/data/evidence.json');
  const catalog = read(npcRoot + 'catalog.json');
  const selected = new Set(read(npcRoot + '重点NPC筛选结果.json').selectedIds);
  const people = new Map(read(reviewRoot + '八组复核/人物索引.json').map(p => [p.id, p]));
  const dataset = read(reviewRoot + '人工复核/data/review-cases.json');
  const store = read(reviewRoot + '人工复核/用户意见/复核意见.json');
  validateReviews(dataset, store);
  assert.equal(sha(bytes(dataset.inputPath)), dataset.inputSha256, 'Pending source changed');
  assert.equal(sha(bytes(dataset.castPath)), dataset.castSha256, 'Cast source changed');
  for (const source of Object.values(dataset.sources)) assert.equal(sha(bytes(source.path)), source.sha256, `Review source changed: ${source.path}`);
  const decisions = dataset.cases.map(c => ({ caseId: c.id, title: c.groupTitle, question: c.question, choice: store.reviews[c.id].choice, label: c.options.find(o => o.value === store.reviews[c.id].choice).label, fingerprint: c.fingerprint, revision: store.reviews[c.id].revision, updatedAt: store.reviews[c.id].updatedAt, routeKeys: c.routeKeys, effect: c.type === 'relation' ? '关系判定按人工意见应用' : '身份判断限定于本篇及指定场景，不自动建立候选关系' }));
  const actual = read(reviewRoot + '八组复核/关系贡献汇总.json');
  const conditional = read(reviewRoot + '八组复核/条件关系贡献汇总.json');
  const results = new Map();
  function result(relative) {
    if (!results.has(relative)) results.set(relative, read(relative));
    return results.get(relative);
  }
  const contributions = actual.flatMap(p => p.contributions.map(c => ({ ...structuredClone(c), realityScope: 'actual_narrative' })));
  for (const c of contributions) {
    const original = result(c.resultPath).pairs.find(p => p.key === c.key);
    assert.ok(original, `Missing source pair: ${c.key}`);
    for (const field of ['personIds', 'label', 'directions', 'description', 'temporalScope']) assert.deepEqual(c[field], original[field], `Stale aggregate: ${c.resultPath} ${c.key} ${field}`);
    assert.ok(!original.realityScope || original.realityScope === 'actual_narrative', 'Conditional pair in actual aggregate');
  }
  const independentPath = reviewRoot + '批次/act15d0/审读记录.json';
  const independent = result(independentPath);
  for (const source of independent.sourceFiles) assert.equal(sha(bytes(source.path)), source.sha256, 'Independent source changed');
  for (const p of independent.pairs) contributions.push({ ...structuredClone(p), groupId: 'act15d0', title: independent.title, resultPath: independentPath, realityScope: 'actual_narrative' });

  function citation(relative, line, endLine) {
    const lines = bytes(relative).toString('utf8').split('\n');
    assert.ok(Number.isInteger(line) && Number.isInteger(endLine) && line > 0 && endLine >= line && endLine <= lines.length, `Invalid citation: ${relative}:${line}`);
    return { path: relative, line, endLine, quote: lines.slice(line - 1, endLine).join('\n') };
  }
  const overrides = read('ArknightsRelationshipGraph/scripts/npc-review-overrides.json');
  for (const c of dataset.cases) {
    const r = store.reviews[c.id];
    if (['unsupported', 'different'].includes(r.choice)) {
      // 排除一个候选不能抹去同一篇中另有证据支持的人物对。
      const contributed = contributions.filter(p => p.groupId === c.groupId && c.routeKeys.includes(p.key) && p.directions.some(d => d.status === 'supported'));
      assert.equal(contributed.length, 0, `Excluded candidate overlaps supported evidence: ${c.id}`);
      continue;
    }
    if (c.type === 'relation') {
      const p = contributions.find(p => p.groupId === c.groupId && p.key === pairKey(c.personIds));
      assert.ok(p, `Manual relation missing: ${c.id}`);
      const [a, b] = c.personIds;
      const block = c.blocks.find(b => b.kind === 'evidence');
      assert.ok(block, `Missing review context: ${c.id}`);
      p.manualCaseId = c.id;
      p.manualCitations = [citation(dataset.sources[block.sourceKey].path, block.line, block.endLine)];
      const supported = r.choice === 'both' ? [a, b] : r.choice === 'a_to_b' ? [a] : r.choice === 'b_to_a' ? [b] : [];
      p.directions = [[a, b], [b, a]].map(([from, to]) => ({ from, to, status: supported.includes(from) ? 'supported' : 'not_established', evidenceIds: [] }));
      p.description = `人工复核：${c.options.find(o => o.value === r.choice).label}。${r.notes || '采用已保存的人工判断；下方为复核时提供的原文上下文。'}`;
      p.label = supported.length === 2 ? '确认相识' : supported.length ? '单向知晓' : '证据不足';
    }
    for (const change of overrides[c.id] || []) {
      assert.equal(r.choice, change.expectedChoice, `Manual override choice changed: ${c.id}`);
      for (const s of change.citations) assert.ok(c.blocks.some(b => dataset.sources[b.sourceKey].path === s.path && b.line <= s.line && b.endLine >= s.endLine), `Override outside reviewed context: ${c.id}`);
      const key = pairKey(change.personIds);
      let p = contributions.find(p => p.groupId === c.groupId && p.key === key);
      if (!p) {
        p = { key, personIds: change.personIds, groupId: c.groupId, title: c.groupTitle, resultPath: c.resultPath, temporalScope: change.temporalScope || `《${c.groupTitle}》叙事范围`, realityScope: 'actual_narrative' };
        contributions.push(p);
      }
      p.manualCaseId = c.id;
      p.description = change.description;
      p.manualCitations = change.citations.map(s => citation(s.path, s.line, s.endLine));
      p.directions = change.directions.map(([from, to]) => ({ from, to, status: 'supported', evidenceIds: [] }));
      p.label = p.directions.length === 2 ? '确认相识' : '单向知晓';
    }
  }

  const config = read('ArknightsRelationshipGraph/scripts/npc-display-config.json');
  const factions = new Map(base.factions.map(f => [f.id, f]));
  for (const f of config.factions) factions.set(f.id, f);
  const assignments = new Map(Object.entries(config.groups).flatMap(([faction, names]) => names.map(name => [name, faction])));
  assert.equal(assignments.size, Object.values(config.groups).flat().length, 'Duplicate display assignment');
  const nodes = structuredClone(base.nodes);
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const avatars = [];
  for (const p of catalog.characters.filter(p => selected.has(p.id))) {
    if (nodeMap.has(p.id)) continue;
    const factionId = assignments.get(p.name) || 'unknown';
    const faction = factions.get(factionId);
    assert.ok(faction, `Unknown faction ${factionId}`);
    const first = p.portraits[0];
    assert.ok(first?.imageUrl, `Missing portrait: ${p.name}`);
    const file = config.portraits?.[p.id]?.fileName || first.fileName;
    const portrait = p.portraits.find(x => x.fileName === file);
    assert.ok(portrait, `Unknown portrait variant: ${p.name}`);
    const url = new URL(portrait.imageUrl);
    assert.equal(url.hostname, 'media.prts.wiki');
    url.pathname = url.pathname.replace(/^\/thumb\/([^/]+\/[^/]+\/[^/]+)\/.*$/, '/$1');
    url.search = '';
    const asset = { id: p.id, name: p.name, sourceUrl: url.href, filePageUrl: portrait.filePageUrl, fileName: portrait.fileName, generic: portrait.generic, variant: portrait.variant || '', ...(config.portraits?.[p.id]?.crop ? { crop: config.portraits[p.id].crop } : {}) };
    avatars.push(asset);
    const node = { id: p.id, name: p.displayName || p.name, aliases: uniq([p.name, ...(p.aliases || []), ...(people.get(p.id)?.names || [])]).sort(), factionId, factionName: faction.name, isOperator: false, avatar: `/avatars/${p.id}.webp`, avatarSource: portrait.filePageUrl, avatarIsGeneric: portrait.generic };
    nodes.push(node); nodeMap.set(p.id, node);
  }
  const groups = new Map();
  for (const c of contributions) {
    assert.equal(pairKey(c.personIds), c.key, 'Pair key changed');
    assert.ok(c.personIds.every(id => nodeMap.has(id)), `Unknown endpoint: ${c.key}`);
    if (!groups.has(c.key)) groups.set(c.key, []);
    groups.get(c.key).push(c);
  }
  const edges = structuredClone(base.edges);
  const edgeMap = new Map(edges.map(e => [e.id, e]));
  const evidence = structuredClone(baseEvidence);
  const overlaps = [], insufficient = [], provenance = {};
  let checkedCitations = 0;
  for (const [key, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const direction = mergeDirections(list);
    if (!direction) { insufficient.push(key); continue; }
    if (edgeMap.has(key)) {
      const previous = edgeMap.get(key);
      overlaps.push({ key, names: key.split('|').map(id => nodeMap.get(id).name), existing: { kind: previous.kind, ...(previous.kind === 'awareness' ? { from: previous.from, to: previous.to } : {}) }, npcReview: direction, action: '保留网站既有判定与证据；新审读贡献保存在 provenance.json' });
    }
    const entries = [];
    for (const p of list.filter(p => p.directions.some(d => d.status === 'supported'))) {
      const citations = p.manualCitations || uniq(p.directions.flatMap(d => d.status === 'supported' ? d.evidenceIds : [])).flatMap(id => {
        const e = result(p.resultPath).evidence.find(e => e.id === id);
        assert.ok(e?.citations?.length, `Evidence missing: ${p.resultPath}#${id}`);
        return e.citations;
      });
      assert.ok(citations.length, `No evidence: ${key}`);
      for (const c of citations) { assert.equal(c.quote, citation(c.path, c.line, c.endLine).quote, `Source quote changed: ${c.path}:${c.line}`); checkedCitations++; }
      const sources = citations.map(c => ({ kind: 'story', source: c.path, line: c.line, endLine: c.endLine, version: catalog.operatorSourceCommit }));
      if (p.manualCaseId) sources.push({ kind: 'manual', source: `${reviewRoot}人工复核/用户意见/复核意见.json#${p.manualCaseId}`, version: `revision:${store.reviews[p.manualCaseId].revision}; ${store.reviews[p.manualCaseId].updatedAt}` });
      entries.push({ title: p.title, temporalScope: p.temporalScope || '', description: p.description, directions: p.directions, resultPath: p.resultPath, ...(p.manualCaseId ? { manualCaseId: p.manualCaseId } : {}), citations, sources });
    }
    provenance[key] = entries;
    if (edgeMap.has(key)) continue;
    const [source, target] = key.split('|');
    const edge = { id: key, source, target, ...direction, stableKeys: [key] };
    edges.push(edge); edgeMap.set(key, edge);
    // 正文按篇章保留配对说明与引用；不将审读猜测写成原文。
    const quote = entries.map(e => `【${e.title}】\n${e.citations.map(c => readableQuote(c.quote)).join('\n\n')}`).join('\n\n');
    const sources = [...new Map(entries.flatMap(e => e.sources).map(s => [JSON.stringify(s), s])).values()];
    const label = direction.kind === 'mutual' ? '确认相识' : `${nodeMap.get(direction.from).name} → ${nodeMap.get(direction.to).name}`;
    evidence[key] = { quote, note: `${label}。跨篇同一人物对按独立知晓方向合并。\n\n` + entries.map(e => `【${e.title}】${e.temporalScope}\n${e.description}`).join('\n\n'), sources };
  }
  const graph = { nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)), edges: edges.sort((a, b) => a.id.localeCompare(b.id)), factions: [...factions.values()].filter(f => nodes.some(n => n.factionId === f.id)).sort((a, b) => a.order - b.order) };
  const report = { schemaVersion: 1, reviewVersion: dataset.version, baseline: { people: base.nodes.length, relationships: base.edges.length }, counts: { people: nodes.length, npcs: avatars.length, reusedSupport: selected.size - avatars.length, relationships: edges.length, newRelationships: edges.length - base.edges.length, mutual: edges.filter(e => e.kind === 'mutual').length, awareness: edges.filter(e => e.kind === 'awareness').length, appliedReviews: decisions.length, excludedIdentityCandidates: decisions.filter(d => ['unsupported', 'different'].includes(d.choice)).length, conditionalPairsKeptSeparate: conditional.length, existingPairsPreserved: overlaps.length, insufficient: insufficient.length, checkedCitations }, unclassified: nodes.filter(n => n.factionId === 'unknown').map(n => n.name), genericAvatars: avatars.filter(a => a.generic).map(a => a.name), overlaps, decisions, insufficient, inputs: [...inputs].map(([file, sha256]) => ({ path: file, sha256 })) };
  fs.mkdirSync(output, { recursive: true });
  for (const [name, value] of Object.entries({ graph, evidence, provenance, report, 'avatar-plan': avatars, conditional })) fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(value, null, name === 'evidence' || name === 'provenance' ? 0 : 2) + '\n');
  return { graph, evidence, report, avatars };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--output');
  const { report } = buildNpcData(index < 0 ? undefined : path.resolve(process.argv[index + 1]));
  console.log(JSON.stringify({ ...report.counts, unclassified: report.unclassified, genericAvatars: report.genericAvatars }, null, 2));
}
