import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNpcData, validateReviews, mergeDirections, readableQuote } from './build-npc-data.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = p => JSON.parse(fs.readFileSync(path.join(root, p)));
test('combines only independently supported directions', () => {
  const a = { directions: [{ from: 'a', to: 'b', status: 'supported' }, { from: 'b', to: 'a', status: 'not_established' }] };
  assert.deepEqual(mergeDirections([a, a]), { kind: 'awareness', from: 'a', to: 'b' });
  assert.deepEqual(mergeDirections([a, { directions: [{ from: 'b', to: 'a', status: 'supported' }] }]), { kind: 'mutual' });
  assert.equal(mergeDirections([{ directions: [{ from: 'a', to: 'b', status: 'not_established' }] }]), null);
});
test('rejects missing, stale, and unresolved human decisions', () => {
  const dataset = read('../ArknightsNpcCatalog/关系审读/人工复核/data/review-cases.json');
  const store = read('../ArknightsNpcCatalog/关系审读/人工复核/用户意见/复核意见.json');
  validateReviews(dataset, store);
  const first = dataset.cases.find(c => c.type === 'relation').id;
  for (const mutate of [s => delete s.reviews[first], s => s.reviews[first].caseFingerprint = 'stale', s => s.reviews[first].choice = 'unsure']) {
    const altered = structuredClone(store); mutate(altered); assert.throws(() => validateReviews(dataset, altered));
  }
});
test('renders dialogue and choices without erasing branch conditions or unknown text', () => {
  const raw = '[Character(name="x")]\n[name="甲"]原文。\n[Decision(options="是;否",values="1;2")]\n[Predicate(references="2")]\n[name="乙"]答复。\n[Unknown(text="不可遗漏")]';
  const text = readableQuote(raw);
  assert.ok(text.includes('甲：原文。') && text.includes('1：是') && text.includes('2：否'));
  assert.ok(text.includes('分支条件（原选项编号）：2') && text.includes('不可遗漏'));
  assert.ok(!text.includes('Character('));
});
test('real NPC bundle preserves existing records and uses all valid reviews', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'arknights-npc-test-'));
  try {
    const { graph, evidence, report, avatars } = buildNpcData(output);
    const base = read('dist/data/graph.json'), baseEvidence = read('dist/data/evidence.json');
    const nodes = new Map(graph.nodes.map(n => [n.id, n]));
    const edges = new Map(graph.edges.map(e => [e.id, e]));
    assert.equal(nodes.size, graph.nodes.length); assert.equal(edges.size, graph.edges.length);
    for (const n of base.nodes) assert.deepEqual(nodes.get(n.id), n);
    for (const e of base.edges) { assert.deepEqual(edges.get(e.id), e); assert.deepEqual(evidence[e.id], baseEvidence[e.id]); }
    assert.equal(report.counts.appliedReviews, 39);
    assert.equal(report.counts.npcs, 169);
    assert.equal(report.counts.reusedSupport, 5);
    assert.equal(report.counts.conditionalPairsKeptSeparate, 12);
    assert.equal(avatars.filter(a => a.generic).length, 5);
    assert.equal(edges.get('char_136_hsguma|npc_b554345833235f79').kind, 'mutual');
    assert.deepEqual({ kind: edges.get('char_290_vigna|npc_41a9d787ca6c83d0').kind, from: edges.get('char_290_vigna|npc_41a9d787ca6c83d0').from }, { kind: 'awareness', from: 'char_290_vigna' });
    const nymph = evidence['char_4146_nymph|npc_84fdad316566923c'];
    assert.ok(nymph.quote.includes('妮芙：') && nymph.note.includes('人工复核'));
    assert.ok(nymph.sources.some(s => s.source.includes('act17mini_st05')));
    const provenance = JSON.parse(fs.readFileSync(path.join(output, 'provenance.json')));
    const conditional = JSON.parse(fs.readFileSync(path.join(output, 'conditional.json')));
    for (const pair of conditional) for (const c of pair.contributions) assert.ok(!(provenance[pair.key] || []).some(p => p.resultPath === c.resultPath), `Conditional contribution leaked: ${pair.key}`);
    const before = fs.readFileSync(path.join(output, 'graph.json'));
    buildNpcData(output);
    assert.deepEqual(fs.readFileSync(path.join(output, 'graph.json')), before);
  } finally { fs.rmSync(output, { recursive: true, force: true }); }
});
