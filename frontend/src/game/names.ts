import type { GamePerson } from './network.ts';
import { appearanceForAlias, presentPerson } from './appearances.ts';

// 仅用于输入识别，不作为官方姓名或关系依据；来源与扩充边界见 docs/GAME.md。
export const NICKNAMES: Record<string, readonly string[]> = {
  '史尔特尔': ['42'], '玛恩纳': ['叔叔', '老玛'], '琴柳': ['76'], '棘刺': ['鸡翅'],
  '艾雅法拉': ['小羊', '羊奶'], '伊芙利特': ['小火龙'], '陈': ['水陈'],
  '德克萨斯': ['德狗', '异德', '张飞'], '拉普兰德': ['拉狗'], '银灰': ['银老板'],
  '斯卡蒂': ['红蒂'], '幽灵鲨': ['归鲨'], '嘉维尔': ['百嘉'], '苇草': ['焰苇'],
  '白面鸮': ['白咕咕'], '塞雷娅': ['塞爹'], '华法琳': ['ff0'], '菲亚梅塔': ['肥鸭'],
  '安洁莉娜': ['杰哥'], '星熊': ['鬼姐'], '蛇屠箱': ['龟龟'], '鸿雪': ['鸿太狼'],
  '阿米娅': ['兔兔'], '克洛丝': ['KKDY', '克天使'], '送葬人': ['圣葬', '葬哥'],
};

export interface NameMatch { person: GamePerson; alias: string; exact: boolean; score: number }

export function normalizeName(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, '');
}

function oneEditAway(a: string, b: string): boolean {
  const x = [...a], y = [...b];
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (x.length >= y.length) i++;
    if (y.length >= x.length) j++;
  }
  return edits + (i < x.length || j < y.length ? 1 : 0) <= 1;
}

function scoreName(alias: string, term: string): number {
  if (alias === term) return 0;
  if (alias.startsWith(term)) return 1;
  if (alias.includes(term)) return 2;
  // 两字输入不做错字推断，避免把短人名或数字绰号扩散成大量无关人物。
  if ([...term].length < 3) return Infinity;
  let at = 0;
  for (const char of alias) if (char === term[at]) at++;
  if (at === term.length && alias.length <= term.length * 2) return 3;
  return oneEditAway(alias, term) ? 4 : Infinity;
}

export function matchNames(people: Iterable<GamePerson>, input: string): NameMatch[] {
  const term = normalizeName(input.trim().slice(0, 100));
  if (!term) return [];
  const results: NameMatch[] = [];
  for (const person of people) {
    let best: NameMatch | null = null;
    const names = [person.name, ...person.aliases, ...(NICKNAMES[person.canonicalName || person.name] || [])];
    for (const alias of new Set(names)) {
      const score = scoreName(normalizeName(alias), term);
      if (Number.isFinite(score) && (!best || score < best.score)) best = { person, alias, exact: score === 0, score };
    }
    if (best) {
      const appearance = appearanceForAlias(person, best.alias);
      if (appearance) best.person = presentPerson(person, appearance);
      else if (person.canonicalName && (best.alias === person.canonicalName || best.alias !== person.name)) best.person = presentPerson(person);
      results.push(best);
    }
  }
  return results.sort((a, b) => a.score - b.score || a.person.name.localeCompare(b.person.name, 'zh-CN'));
}

export function uniqueExactMatch(matches: NameMatch[]): GamePerson | null {
  const exact = matches.filter(match => match.exact);
  return exact.length === 1 ? exact[0].person : null;
}
