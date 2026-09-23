import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const arg = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
assert.ok(arg('--gamedata'), 'Provide an explicit fixed gamedata directory');
const directory = path.resolve(arg('--gamedata'));
const commit = arg('--commit');
assert.match(commit || '', /^[a-f0-9]{40}$/, 'Provide the verified source commit');
const cutoff = arg('--cutoff') || '2026-09-23T23:59:59+08:00';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const names = ['character_table', 'skin_table', 'char_patch_table', 'char_meta_table', 'story_review_table'];
const raw = await Promise.all(names.map(n => fs.readFile(path.join(directory, `${n}.json`))));
const [characters, skins, patch, identities, stories] = raw.map(x => JSON.parse(x));
const graph = JSON.parse(await fs.readFile(path.join(root, 'data/npc/graph.json'), 'utf8'));
const known = new Map(graph.nodes.map(x => [x.id, x]));
const aliases = new Map(graph.nodes.flatMap(x => [x.name, ...(x.aliases || [])].map(n => [n, x.id])));
const grouped = new Map(Object.entries(identities.spCharGroups).flatMap(([owner, ids]) => ids.map(id => [id, owner])));
const supportOwners = { char_512_aprot: 'char_4025_aprot2', char_608_acpion: 'char_513_apionr',
  char_609_acguad: 'char_508_aguard', char_617_sharp2: 'char_508_aguard', char_611_acnipe: 'char_511_asnipe',
  char_612_accast: 'char_509_acast', char_613_acmedc: 'char_510_amedic' };
const data = { version: 2, cutoff, source: { repository: 'Kengxxiao/ArknightsGameData', commit },
  inputs: Object.fromEntries(names.map((n, i) => [n, { sha256: hash(raw[i]),
    url: `https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData/${commit}/zh_CN/gamedata/excel/${n}.json` }])),
  characters: {}, skins: {}, evolve: {}, patch: skins.buildinPatchMap, identities: {}, excluded_forms: [], excluded_skins: [], story_units: [] };
for (const [id, c] of Object.entries({ ...characters, ...patch.patchChars })) {
  if (!id.startsWith('char_')) continue;
  if (c.isNotObtainable && /^(预备干员|盟约·)/.test(c.name)) {
    data.excluded_forms.push({ id, name: c.name, reason: '通用预备/功能占位单位，无独立具名人物身份' }); continue;
  }
  if (!skins.buildinEvolveMap[id] && !Object.values(skins.buildinPatchMap).some(x => x[id])) {
    data.excluded_forms.push({ id, name: c.name, reason: '没有已实装阶段映射' }); continue;
  }
  const owner = Object.entries(patch.infos).find(([, p]) => p.tmplIds.includes(id))?.[0]
    || supportOwners[id] || grouped.get(id) || id;
  const personId = known.has(owner) ? owner : c.isNotObtainable && aliases.has(c.name) ? aliases.get(c.name) : owner;
  data.characters[id] = { name: c.name, profession: c.profession, sub_profession: c.subProfessionId,
    sortIndex: c.sortIndex, isNotObtainable: c.isNotObtainable, appellation: c.appellation,
    nation_id: c.nationId, group_id: c.groupId, team_id: c.teamId, obtain_approach: c.itemObtainApproach,
    person_id: personId, identity_basis: supportOwners[id] ? '同名临时支援形态；保留既有稳定人物ID' :
      patch.patchChars[id] ? 'char_patch_table.infos' : 'char_meta_table.spCharGroups',
    availability: c.isNotObtainable ? '已实装具名临时招募/支援单位' : '国服公开实装可获得干员' };
  data.evolve[id] = skins.buildinEvolveMap[id] || null;
  data.identities[personId] ||= { id: personId, name: known.get(personId)?.name || characters[owner]?.name || c.name,
    aliases: known.get(personId)?.aliases || [c.appellation].filter(Boolean), existing: known.has(personId) };
  if (!data.identities[personId].aliases.includes(c.name)) data.identities[personId].aliases.push(c.name);
}
for (const [id, skin] of Object.entries(skins.charSkins)) {
  const form = skin.tmplId || skin.charId;
  if (!data.characters[form]) continue;
  const d = skin.displaySkin;
  if (d.skinName && (!d.getTime || !d.obtainApproach || d.getTime > Date.parse(cutoff) / 1000)) {
    data.excluded_skins.push({ id, form_id: form, name: d.skinName, get_time: d.getTime,
      reason: d.getTime > Date.parse(cutoff) / 1000 ? '获取时间晚于内容截止点' : '缺少正式获取依据' }); continue;
  }
  data.skins[id] = { id, form_id: form, char_id: skin.charId, illust_id: skin.illustId,
    portrait_id: skin.portraitId, name: d.skinName, get_time: d.getTime, obtain_approach: d.obtainApproach,
    sort_id: d.sortId, dynamic_id: skin.dynIllustId || null };
}
for (const unit of Object.values(stories)) {
  if (!['MAINLINE', 'ACTIVITY', 'MINI_ACTIVITY'].includes(unit.entryType) || unit.startTime > Date.parse(cutoff) / 1000) continue;
  data.story_units.push({ id: unit.id, name: unit.name, type: unit.entryType, start_time: unit.startTime,
    stories: unit.infoUnlockDatas.map(x => ({ id: x.storyId, code: x.storyCode, name: x.storyName, path: `${x.storyTxt}.txt` })) });
}
data.selected_form_ids = Object.keys(data.characters).sort((a, b) => data.characters[a].sortIndex - data.characters[b].sortIndex || a.localeCompare(b));
await fs.writeFile(path.join(root, 'data/preferences/metadata.json'), JSON.stringify(data, null, 2) + '\n');
console.log(JSON.stringify({ forms: data.selected_form_ids.length, persons: Object.keys(data.identities).length,
  new_persons: Object.values(data.identities).filter(x => !x.existing), excluded_skins: data.excluded_skins, story_units: data.story_units.length }));
