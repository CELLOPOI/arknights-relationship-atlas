import catalog from './appearance-catalog.json' with { type: 'json' };
import type { GameData, GamePerson } from './network.ts';

export type AppearanceChoices = Record<string, string>;
export const APPEARANCES = catalog.appearances;
const nicknames: Record<string, string[]> = {
  char_1013_chen2: ['水陈'], char_1028_texas2: ['异德', '张飞'], char_1016_agoat2: ['羊奶'],
  char_1012_skadi2: ['红蒂'], char_1023_ghost2: ['归鲨'], char_1026_gvial2: ['百嘉'],
  char_1020_reed2: ['焰苇'], char_1032_excu2: ['圣葬'], char_1021_kroos2: ['克天使'],
};

// 形象只改变游戏展示；人物、关系、禁用和重复判定始终使用正式人物 ID。
export function appearancesFor(person: GamePerson) {
  return person.isOperator === false ? [] : APPEARANCES.filter(art => art.personId === person.id && person.aliases.includes(art.name));
}

export function chooseAppearances(data: GameData, random = Math.random): AppearanceChoices {
  const result: AppearanceChoices = {};
  for (const person of data.nodes) {
    const forms = appearancesFor(person);
    if (!forms.length) continue;
    const ids = [person.id, ...forms.map(form => form.id)];
    result[person.id] = ids[Math.floor(random() * ids.length)];
  }
  return result;
}

export function restoreAppearances(value: unknown, data: GameData): AppearanceChoices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(data.nodes.flatMap(person => {
    const id = raw[person.id];
    return typeof id === 'string' && (id === person.id || appearancesFor(person).some(form => form.id === id)) ? [[person.id, id]] : [];
  }));
}

export function presentPerson(person: GamePerson, appearanceId = person.id): GamePerson {
  const form = appearancesFor(person).find(item => item.id === appearanceId);
  const canonicalName = person.canonicalName || person.name;
  const canonicalAvatar = person.canonicalAvatar || person.avatar || `/avatars/${person.id}.webp`;
  return { ...person, name: form?.name || canonicalName, canonicalName, canonicalAvatar,
    appearanceId: form?.id || person.id, avatar: form ? `/avatars/${form.id}.webp` : canonicalAvatar };
}

export function appearanceForAlias(person: GamePerson, alias: string): string | undefined {
  return appearancesFor(person).find(form => [form.name, ...form.aliases, ...(nicknames[form.id] || [])].includes(alias))?.id;
}
