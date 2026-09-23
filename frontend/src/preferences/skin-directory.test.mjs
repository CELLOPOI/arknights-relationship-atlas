import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { skinDirectoryForms } from './skin-directory.ts';

const catalog = JSON.parse(readFileSync(new URL('../../../data/preferences/catalog.json', import.meta.url)));

test('support copies have one skin entry per named operator', () => {
  const directory = skinDirectoryForms(catalog.forms);
  for (const name of ['Sharp', 'Pith', 'Touch', 'Stormeye', '郁金香', '暮落']) {
    assert.equal(directory.filter(form => form.name === name).length, 1, name);
  }
  assert.equal(directory.length, catalog.forms.length - 6);
  assert.ok(directory.find(form => form.id === 'char_4025_aprot2').appearance_ids.length > 1);
});

test('real alters and profession forms remain separate', () => {
  const ids = new Set(skinDirectoryForms(catalog.forms).map(form => form.id));
  for (const id of ['char_002_amiya', 'char_1001_amiya2', 'char_1037_amiya3',
    'char_263_skadi', 'char_1012_skadi2', 'char_508_aguard', 'char_617_sharp2']) {
    assert.ok(ids.has(id), id);
  }
  const sameName = { ...catalog.forms[0], id: 'synthetic-same-name' };
  assert.equal(skinDirectoryForms([catalog.forms[0], sameName]).length, 2);
});

test('a support entry survives when its canonical entry is unavailable or unrelated', () => {
  const support = catalog.forms.find(form => form.id === 'char_512_aprot');
  const canonical = catalog.forms.find(form => form.id === 'char_4025_aprot2');
  assert.deepEqual(skinDirectoryForms([support]), [support]);
  for (const override of [{ eligible: false }, { complete: false }, { default_appearance_id: null },
    { person_id: 'synthetic-other-person' }, { profession: 'MEDIC' }]) {
    assert.ok(skinDirectoryForms([support, { ...canonical, ...override }]).includes(support));
  }
});

test('directory filtering preserves source IDs, appearances and legacy detail targets', () => {
  const before = structuredClone(catalog);
  skinDirectoryForms(catalog.forms);
  assert.deepEqual(catalog, before);
  assert.ok(catalog.forms.some(form => form.id === 'char_613_acmedc'));
});
