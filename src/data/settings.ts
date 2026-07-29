/**
 * Preferences, statistics and the saved match, persisted to `localStorage`.
 *
 * No personal data is stored: preferences, aggregate counters and the board of
 * an in-progress match only. Every read is defensive because storage can be
 * disabled, full, or hold values written by an older release.
 */

import { DEFAULT_BOARD_ID, resolveBoardId } from './boards.ts';
import type { Difficulty } from '../ai/types.ts';

const PREFIX = 'monster-territory:';
const SETTINGS_KEY = `${PREFIX}settings`;
const STATS_KEY = `${PREFIX}stats`;
const SAVE_KEY = `${PREFIX}save`;
const ANALYTICS_KEY = `${PREFIX}events`;

export type GameMode = 'vs-computer' | 'local-two-player';
export type MotionPreference = 'auto' | 'full' | 'reduced';
export type ContrastPreference = 'auto' | 'high';

export interface Settings {
  soundEnabled: boolean;
  /** 0..1 */
  volume: number;
  difficulty: Difficulty;
  boardId: string;
  mode: GameMode;
  motion: MotionPreference;
  contrast: ContrastPreference;
  /** Undo in local two-player is opt-in to avoid table-side disputes. */
  allowUndoInLocalPlay: boolean;
  tutorialCompleted: boolean;
  showCoordinates: boolean;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  // Muted until the player opts in, which also keeps us on the right side of
  // browser autoplay policies.
  soundEnabled: false,
  volume: 0.7,
  difficulty: 'normal',
  boardId: DEFAULT_BOARD_ID,
  mode: 'vs-computer',
  motion: 'auto',
  contrast: 'auto',
  allowUndoInLocalPlay: false,
  tutorialCompleted: false,
  showCoordinates: false,
});

export interface Stats {
  matchesPlayed: number;
  matchesCompleted: number;
  playerWins: number;
  computerWins: number;
  ties: number;
  localMatches: number;
  bestScoreDifference: number;
  largestConversion: number;
  fastestWinMs: number | null;
  restartsUsed: number;
}

export const DEFAULT_STATS: Stats = Object.freeze({
  matchesPlayed: 0,
  matchesCompleted: 0,
  playerWins: 0,
  computerWins: 0,
  ties: 0,
  localMatches: 0,
  bestScoreDifference: 0,
  largestConversion: 0,
  fastestWinMs: null,
  restartsUsed: 0,
});

function storage(): Storage | null {
  try {
    const test = `${PREFIX}probe`;
    globalThis.localStorage.setItem(test, '1');
    globalThis.localStorage.removeItem(test);
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): Partial<T> | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<T>) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* Quota or private-mode failure: preferences simply do not persist. */
  }
}

const DIFFICULTIES = new Set<Difficulty>(['easy', 'normal', 'hard']);

export function loadSettings(): Settings {
  const raw = readJson<Settings>(SETTINGS_KEY) ?? {};
  return {
    soundEnabled: typeof raw.soundEnabled === 'boolean' ? raw.soundEnabled : DEFAULT_SETTINGS.soundEnabled,
    volume: typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : DEFAULT_SETTINGS.volume,
    difficulty: DIFFICULTIES.has(raw.difficulty as Difficulty) ? (raw.difficulty as Difficulty) : DEFAULT_SETTINGS.difficulty,
    boardId: resolveBoardId(raw.boardId),
    mode: raw.mode === 'local-two-player' ? 'local-two-player' : 'vs-computer',
    motion: raw.motion === 'full' || raw.motion === 'reduced' ? raw.motion : 'auto',
    contrast: raw.contrast === 'high' ? 'high' : 'auto',
    allowUndoInLocalPlay: raw.allowUndoInLocalPlay === true,
    tutorialCompleted: raw.tutorialCompleted === true,
    showCoordinates: raw.showCoordinates === true,
  };
}

export function saveSettings(settings: Settings): void {
  writeJson(SETTINGS_KEY, settings);
}

export function loadStats(): Stats {
  const raw = readJson<Stats>(STATS_KEY) ?? {};
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
  return {
    matchesPlayed: num(raw.matchesPlayed, 0),
    matchesCompleted: num(raw.matchesCompleted, 0),
    playerWins: num(raw.playerWins, 0),
    computerWins: num(raw.computerWins, 0),
    ties: num(raw.ties, 0),
    localMatches: num(raw.localMatches, 0),
    bestScoreDifference: num(raw.bestScoreDifference, 0),
    largestConversion: num(raw.largestConversion, 0),
    fastestWinMs: typeof raw.fastestWinMs === 'number' && raw.fastestWinMs > 0 ? raw.fastestWinMs : null,
    restartsUsed: num(raw.restartsUsed, 0),
  };
}

export function saveStats(stats: Stats): void {
  writeJson(STATS_KEY, stats);
}

export function updateStats(mutate: (stats: Stats) => Stats): Stats {
  const next = mutate(loadStats());
  saveStats(next);
  return next;
}

export function resetStats(): Stats {
  saveStats({ ...DEFAULT_STATS });
  return { ...DEFAULT_STATS };
}

// ---------------------------------------------------------------------------
// Saved match
// ---------------------------------------------------------------------------

export function readSavedGame(): unknown {
  return readJson<Record<string, unknown>>(SAVE_KEY);
}

export function writeSavedGame(payload: unknown): void {
  writeJson(SAVE_KEY, payload);
}

export function clearSavedGame(): void {
  const store = storage();
  try {
    store?.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Anonymous, local-only analytics
// ---------------------------------------------------------------------------

export type AnalyticsEvent =
  | 'game_started'
  | 'game_completed'
  | 'board_selected'
  | 'difficulty_selected'
  | 'tutorial_started'
  | 'tutorial_completed'
  | 'restart_used'
  | 'undo_used'
  | 'player_victory'
  | 'computer_victory'
  | 'tie_result'
  | 'match_duration_bucket';

/**
 * Counts anonymous gameplay events. Nothing leaves the device unless a host
 * app installs a sink, and no board state, timing detail or identifier that
 * could single out a player is recorded — only counters.
 */
export function trackEvent(event: AnalyticsEvent, bucket?: string): void {
  try {
    const counts = (readJson<Record<string, number>>(ANALYTICS_KEY) ?? {}) as Record<string, number>;
    const key = bucket ? `${event}:${bucket}` : event;
    counts[key] = (counts[key] ?? 0) + 1;
    writeJson(ANALYTICS_KEY, counts);
    analyticsSink?.(event, bucket);
  } catch {
    /* Analytics must never interrupt play. */
  }
}

let analyticsSink: ((event: AnalyticsEvent, bucket?: string) => void) | null = null;

/** Lets a host application forward the same anonymous counters elsewhere. */
export function setAnalyticsSink(sink: ((event: AnalyticsEvent, bucket?: string) => void) | null): void {
  analyticsSink = sink;
}

export function readAnalytics(): Record<string, number> {
  return (readJson<Record<string, number>>(ANALYTICS_KEY) ?? {}) as Record<string, number>;
}

/** Buckets a duration so analytics never records an exact match length. */
export function durationBucket(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1) return 'under-1m';
  if (minutes < 2) return '1-2m';
  if (minutes < 5) return '2-5m';
  if (minutes < 10) return '5-10m';
  return 'over-10m';
}
