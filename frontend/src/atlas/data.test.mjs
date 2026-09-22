import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateAtlasData } from './data.js';
const data = JSON.parse(readFileSync(new URL('../../../data/npc/graph.json', import.meta.url), 'utf8'));

test('accepts current graph without changing stable IDs, direction or array order', () => {
  const snapshot = JSON.stringify(data);
  assert.equal(validateAtlasData(data), data);
  assert.equal(JSON.stringify(data), snapshot);
});

test('rejects dangling, self, duplicate and unsupported relations before graph mutation', () => {
  for (const patch of [{ target: 'missing-person' }, { target: data.edges[0].source }, { kind: 'inferred' }, { id: data.edges[1].id }]) {
    const next = structuredClone(data);
    Object.assign(next.edges[0], patch);
    assert.throws(() => validateAtlasData(next), /Invalid relationship/);
  }
});

test('rejects missing collections, duplicate people, unknown factions and non-text aliases', () => {
  assert.throws(() => validateAtlasData({ nodes: [] }), /Invalid atlas/);
  for (const patch of [{ id: data.nodes[1].id }, { factionId: 'missing-faction' }, { aliases: [null] }]) {
    const next = structuredClone(data);
    Object.assign(next.nodes[0], patch);
    assert.throws(() => validateAtlasData(next), /Invalid or duplicate person/);
  }
});
