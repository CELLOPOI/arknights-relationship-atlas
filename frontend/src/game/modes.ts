import { buildNetwork, dataFingerprint, defaultRules, generatePuzzle, newRound, readRules, restoreRound,
  type GameData, type Network, type Round, type Rules } from './network.ts';
import { COMPLETION_GAPS, newCompletionRound, restoreCompletion, type CompletionRound } from './completion.ts';
import { chooseAppearances, restoreAppearances, type AppearanceChoices } from './appearances.ts';
import { newRecognitionRound, restoreRecognition, type RecognitionRound } from './recognition.ts';

export type GameMode = 'completion' | 'explore' | 'input' | 'recognition';
export const STORAGE_KEY = 'arknights-games-v2';
export const LEGACY_STORAGE_KEY = 'arknights-six-links-v1';
export const MODES: Record<GameMode, { label: string; description: string }> = {
  completion: { label: '普通模式', description: '根据人物关系，选出缺少的人物补全路线。' },
  explore: { label: '六步探索', description: '从可连接人物中选择，六步内从起点抵达终点。' },
  input: { label: '输入挑战', description: '给定起点和终点，自行输入下一位人物，六步内接通。' },
  recognition: { label: '双人判断', description: '先判断两人是否直接认识；不认识时，再选出连接他们的中间人。' },
};
export interface GameSession { rules: Rules; round: Round | null; completion: CompletionRound | null; recognition?: RecognitionRound | null; appearances?: AppearanceChoices }
export interface GameSave { fingerprint: string; mode: GameMode; sessions: Partial<Record<GameMode, GameSession>> }

export function modeRules(mode: GameMode): Rules {
  return { ...defaultRules(), difficulty: mode === 'completion' ? 'easy' : 'normal' };
}

export function createSession(network: Network, rules: Rules, mode: GameMode, previous?: GameSession): GameSession | null {
  if (mode === 'recognition') {
    const recognition = newRecognitionRound(network, previous?.recognition);
    return recognition ? { rules, round: null, completion: null, recognition,
      appearances: chooseAppearances({ nodes: [...network.people.values()], edges: [] }) } : null;
  }
  const last = previous?.round?.puzzle || previous?.completion?.puzzle;
  const steps = COMPLETION_GAPS[rules.difficulty] * 2;
  const puzzle = generatePuzzle(network, rules.difficulty, Math.random, last,
    mode === 'completion' ? { min: steps, max: steps } : undefined);
  if (!puzzle) return null;
  return { rules, appearances: chooseAppearances({ nodes: [...network.people.values()], edges: [] }), round: mode === 'completion' ? null : newRound(puzzle),
    completion: mode === 'completion' ? newCompletionRound(network, puzzle, rules.difficulty) : null };
}

export function readGameSave(value: unknown, legacy: unknown, data: GameData): GameSave {
  const fingerprint = dataFingerprint(data);
  const result: GameSave = { fingerprint, mode: 'completion', sessions: {} };
  const saved = value && typeof value === 'object' ? value as Partial<GameSave> : null;
  if (saved?.mode && Object.hasOwn(MODES, saved.mode)) result.mode = saved.mode;
  const previous = legacy && typeof legacy === 'object' ? legacy as Partial<GameSession> & { fingerprint?: string } : null;
  const sessions = saved?.sessions && typeof saved.sessions === 'object' ? saved.sessions : null;
  for (const mode of Object.keys(MODES) as GameMode[]) {
    const raw = sessions && Object.hasOwn(sessions, mode) ? sessions[mode] : !saved && mode === 'explore' ? previous : null;
    if (!raw || typeof raw !== 'object') continue;
    const rules = raw.rules ? readRules(raw.rules, data) : modeRules(mode);
    const network = buildNetwork(data, rules);
    const sameData = (saved ? saved.fingerprint : previous?.fingerprint) === fingerprint;
    result.sessions[mode] = { rules, appearances: restoreAppearances(raw.appearances, data),
      round: sameData && (mode === 'explore' || mode === 'input') ? restoreRound(raw.round, network, rules.difficulty) : null,
      completion: sameData && mode === 'completion' ? restoreCompletion(raw.completion, network, rules.difficulty) : null,
      recognition: sameData && mode === 'recognition' ? restoreRecognition(raw.recognition, network) : null };
    if (!saved && previous) result.mode = 'explore';
  }
  return result;
}
