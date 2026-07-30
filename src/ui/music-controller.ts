/**
 * Monster Territory — procedural music engine.
 *
 * ORIGINALITY: every note, chord and timbre here is synthesised at runtime by
 * the Web Audio API from oscillators, gain envelopes and biquad filters. The
 * game ships **no audio files, no samples, no data-URI blobs and no
 * third-party or licensed material of any kind** — there is nothing to license
 * because there is nothing recorded. The score (scale, chord voicings, motifs,
 * rhythms) was written for this project and lives in the tables below; the
 * arrangement is generated from them by a seeded hash, never `Math.random`, so
 * the same scene always produces the same music on every device and run. See
 * `docs/ORIGINALITY.md`.
 *
 * Design notes:
 *  - Nothing is constructed at import time and no AudioContext is touched until
 *    `play()` is first called. The context is not ours: it is borrowed from the
 *    sound engine through the `bus` supplier so the whole app owns exactly one
 *    (iOS refuses extras) and one compressor limits cues and music together.
 *  - Timing uses the standard lookahead pattern: a 25 ms timer that schedules
 *    every note that falls inside the next 120 ms against `ctx.currentTime`.
 *    Timers alone drift and stutter under load; the audio clock does not.
 *  - Nothing here may throw into gameplay. Missing Web Audio, a context that
 *    refuses to resume, a graph torn down underneath us — all degrade to
 *    silence.
 *  - Every voice is finite and disconnects itself on `ended`, so a session of
 *    any length holds a bounded number of nodes.
 *
 * The music: a slow D-minor bed — warm pad, sparse pentatonic arpeggio, a bass
 * root that moves every two bars — under the deep-indigo palette. The menu
 * loop is hopeful and the match loop is the same harmony made quieter and
 * sparser so it never argues with a cue or with a player thinking. Victory and
 * defeat are short flourishes that resolve into a held chord.
 */

export type MusicScene = 'menu' | 'match' | 'victory' | 'defeat';

export interface MusicControllerOptions {
  enabled: boolean;
  /** 0..1 */
  volume: number;
}

/**
 * Off until asked for: browser autoplay policy blocks unprompted sound anyway,
 * and a soundtrack nobody opted into is a bug, not a feature. The level matches
 * `DEFAULT_SETTINGS.musicVolume` so the two agree on a fresh install.
 */
export const DEFAULT_MUSIC_OPTIONS: MusicControllerOptions = Object.freeze({
  enabled: false,
  volume: 0.55,
});

/** Supplies the shared audio graph, or null while Web Audio is unavailable. */
export type MusicBus = () => { ctx: AudioContext; destination: AudioNode } | null;

// ---------------------------------------------------------------------------
// Engine constants
// ---------------------------------------------------------------------------

/** How often the scheduler wakes. Short enough to be inaudible if a tick is late. */
const TICK_MS = 25;
/** How far ahead of the audio clock notes are committed. */
const LOOKAHEAD = 0.12;
/** Start a hair ahead of `currentTime` so an attack is not clipped by the
 *  render quantum already in flight. */
const LEAD = 0.02;
/** Scene-to-scene cross-fade. Long enough to read as a transition, not a cut. */
const CROSSFADE = 1.2;
/** Fade used when the music is being taken away (mute, stop, tab hidden). */
const RELEASE_FADE = 0.6;
/** Extra time a source stays alive after its envelope closes. */
const TAIL = 0.05;
/** Exponential ramps cannot reach zero; this is our practical silence. */
const MIN_GAIN = 0.0001;
/**
 * Ceiling of the whole music bed on the shared bus, before the volume trim.
 * The voices sum to roughly unity at their busiest, so a full-volume bed peaks
 * near 0.13 — under the shared compressor's -18 dBFS threshold and far below
 * the cues, which is the point: music must never mask a move.
 */
const BED_PEAK = 0.18;
/**
 * A frozen tab can leave the scheduler seconds behind. Cap the catch-up so it
 * resyncs (see `tick`) instead of firing a minute of music at once.
 */
const MAX_STEPS_PER_TICK = 24;
/** Pad voices outlast their chord by this factor so changes overlap and the
 *  loop has no seam. */
const PAD_OVERLAP = 1.3;

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

/** Equal-tempered frequency for a semitone offset from A4 = 440 Hz. */
function note(semitonesFromA4: number): number {
  return 440 * Math.pow(2, semitonesFromA4 / 12);
}

/** D4 is the tonal centre of the whole score; every table below is relative to it. */
const D4 = -7;

/** Frequency for a semitone offset above D4. */
function dNote(semitonesAboveD4: number): number {
  return note(D4 + semitonesAboveD4);
}

/** D minor pentatonic (D F G A C): consonant against every chord in the loop. */
const PENTATONIC = [0, 3, 5, 7, 10] as const;

/** Arpeggio home octave (D5) and the registers a phrase may sit in. */
const ARP_OCTAVE = 12;
const REGISTERS = [0, 0, -12, 0, -12, 0] as const;

interface Chord {
  /** Bass root, semitones above D2. */
  readonly bass: number;
  /** Pad voicing, semitones above D3. */
  readonly voicing: readonly number[];
}

/**
 * i – VI – III – VII in D natural minor (Dm – B♭ – F – C): the most settled
 * loop there is, and it never resolves hard enough to demand attention.
 *
 * Every voicing keeps D4 on top. That common tone is what makes the four
 * chords feel like one held sound rather than a chord chart going past, and it
 * anchors the D-rooted arpeggio over all of them.
 */
const PROGRESSION: readonly Chord[] = [
  { bass: 0, voicing: [0, 3, 7, 12] }, //  Dm  D3 F3 A3 D4
  { bass: 8, voicing: [0, 3, 9, 12] }, //  B♭  D3 F3 B♭3 D4
  { bass: 3, voicing: [3, 7, 10, 12] }, // F   F3 A3 C4 D4
  { bass: 10, voicing: [2, 5, 10, 12] }, // C  E3 G3 C4 D4
];

/** The relative major, for victory: same notes, opposite mood. */
const F_MAJOR: Chord = { bass: 3, voicing: [3, 7, 10, 15] };
/** The tonic minor, for defeat. */
const D_MINOR: Chord = { bass: 0, voicing: [0, 3, 7, 12] };

/**
 * Arpeggio phrases as indices into {@link PENTATONIC}, and the bar-relative
 * eighth-note slots they land on. One of each is chosen per bar, so the melody
 * is built from phrases a listener can recognise instead of a coin flip per
 * note — and because the choice is a hash of the bar number, it keeps finding
 * new combinations for as long as the music plays rather than looping every
 * four bars.
 */
const MOTIFS: readonly (readonly number[])[] = [
  [0, 2, 4],
  [4, 2, 0],
  [0, 1, 3],
  [2, 4, 3],
  [3, 1, 0],
  [0, 4, 2, 1],
  [1, 2, 4, 2],
  [4, 3, 1, 0],
];

const RHYTHMS: readonly (readonly number[])[] = [
  [0, 3, 6],
  [0, 2, 5],
  [2, 6],
  [0, 4, 6],
  [1, 3, 7],
  [0, 3, 5],
  [4, 7],
  [0, 6],
];

interface FlourishNote {
  /** Seconds after the scene starts. */
  readonly at: number;
  /** Semitones above D4. */
  readonly semitone: number;
  readonly duration: number;
  readonly peak: number;
  readonly type: OscillatorType;
}

/** Victory: an F-major arpeggio that climbs and lands on its own tonic. */
const VICTORY_FLOURISH: readonly FlourishNote[] = [
  { at: 0, semitone: 3, duration: 0.5, peak: 0.15, type: 'triangle' }, //   F4
  { at: 0.16, semitone: 7, duration: 0.5, peak: 0.15, type: 'triangle' }, // A4
  { at: 0.32, semitone: 10, duration: 0.6, peak: 0.16, type: 'triangle' }, // C5
  { at: 0.48, semitone: 15, duration: 1.7, peak: 0.18, type: 'triangle' }, // F5, held
  { at: 0.48, semitone: 22, duration: 1.1, peak: 0.05, type: 'sine' }, //    C6 shimmer
  { at: 0.96, semitone: 19, duration: 1.5, peak: 0.09, type: 'sine' }, //    A5, the major third ringing
];

/** Defeat: a slow step down the tonic minor that settles on D. Soft, not harsh. */
const DEFEAT_FLOURISH: readonly FlourishNote[] = [
  { at: 0, semitone: 12, duration: 0.8, peak: 0.12, type: 'triangle' }, //   D5
  { at: 0.3, semitone: 10, duration: 0.8, peak: 0.11, type: 'triangle' }, // C5
  { at: 0.6, semitone: 7, duration: 0.9, peak: 0.11, type: 'triangle' }, //  A4
  { at: 0.9, semitone: 3, duration: 1.0, peak: 0.1, type: 'triangle' }, //   F4
  { at: 1.2, semitone: 0, duration: 2.4, peak: 0.11, type: 'sine' }, //      D4, settling
];

interface ArpSpec {
  /** Fraction of bars that carry a phrase at all; the rest are rests. */
  readonly barChance: number;
  readonly peak: number;
  /** Seconds a plucked note rings for. */
  readonly length: number;
}

interface SceneSpec {
  /** Seconds per grid step (an eighth note). */
  readonly step: number;
  readonly stepsPerBar: number;
  readonly barsPerChord: number;
  readonly progression: readonly Chord[];
  /** Peak of the layer gain: where this scene sits in the mix. */
  readonly level: number;
  /** Seconds to fade in over. */
  readonly fadeIn: number;
  /** Seed for this scene's arrangement — fixed, so playback is reproducible. */
  readonly seed: number;
  readonly padPeak: number;
  readonly bassPeak: number;
  /** Travel of the pad's low-pass sweep, in Hz. */
  readonly filterLo: number;
  readonly filterHi: number;
  readonly arp: ArpSpec | null;
  readonly flourish: readonly FlourishNote[] | null;
}

/** Seconds per eighth note at a tempo. */
function eighth(bpm: number): number {
  return 30 / bpm;
}

const SCENES: Record<MusicScene, SceneSpec> = {
  // Warm and hopeful at a walking 76 BPM. The full progression takes 25s and
  // the melody never repeats, so it can sit under the menu for as long as a
  // player wants to browse.
  menu: {
    step: eighth(76),
    stepsPerBar: 8,
    barsPerChord: 2,
    progression: PROGRESSION,
    level: 1,
    fadeIn: CROSSFADE,
    seed: 0x6d656e75,
    padPeak: 0.075,
    bassPeak: 0.24,
    filterLo: 620,
    filterHi: 1550,
    arp: { barChance: 0.72, peak: 0.16, length: 0.9 },
    flourish: null,
  },

  // The same harmony, slower and mostly rests: two thirds of the bars carry no
  // melody at all, so what a player hears during a turn is pad and bass.
  match: {
    step: eighth(62),
    stepsPerBar: 8,
    barsPerChord: 2,
    progression: PROGRESSION,
    level: 0.6,
    fadeIn: CROSSFADE,
    seed: 0x6d617463,
    padPeak: 0.07,
    bassPeak: 0.2,
    filterLo: 460,
    filterHi: 900,
    arp: { barChance: 0.3, peak: 0.1, length: 1.4 },
    flourish: null,
  },

  // Flourish first (hence the fast fade-in), then a single held F major with
  // the odd sparkle over it.
  victory: {
    step: eighth(96),
    stepsPerBar: 8,
    barsPerChord: 4,
    progression: [F_MAJOR],
    level: 1,
    fadeIn: 0.25,
    seed: 0x77696e21,
    padPeak: 0.08,
    bassPeak: 0.22,
    filterLo: 900,
    filterHi: 2100,
    arp: { barChance: 0.45, peak: 0.11, length: 0.8 },
    flourish: VICTORY_FLOURISH,
  },

  // Descent, then a held D minor and nothing else: losing should feel quiet,
  // not punished.
  defeat: {
    step: eighth(58),
    stepsPerBar: 8,
    barsPerChord: 4,
    progression: [D_MINOR],
    level: 0.85,
    fadeIn: 0.3,
    seed: 0x6c6f7373,
    padPeak: 0.075,
    bassPeak: 0.2,
    filterLo: 380,
    filterHi: 720,
    arp: null,
    flourish: DEFEAT_FLOURISH,
  },
};

// ---------------------------------------------------------------------------
// Deterministic arrangement
// ---------------------------------------------------------------------------

/**
 * Seeded hash -> [0, 1). A pure function of (seed, index) rather than a running
 * generator, so the arrangement of any bar can be recomputed from its number
 * alone: the music resumes mid-phrase after a tab switch and is identical on
 * every device and in every test run.
 */
function rand(seed: number, index: number): number {
  let h = (Math.imul(seed ^ index, 0x27d4eb2d) + 0x165667b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

function pick<T>(table: readonly T[], seed: number, index: number): T {
  return table[Math.floor(rand(seed, index) * table.length) % table.length];
}

/** Salts, so the four decisions taken per bar are independent of each other. */
const REST_SALT = 0x5bf03635;
const MOTIF_SALT = 0x9e3779b9;
const REGISTER_SALT = 0x2545f491;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

interface Voice {
  readonly source: OscillatorNode;
  /** Every node between the source and the layer, so we can free the graph. */
  readonly chain: AudioNode[];
}

interface Sink {
  readonly ctx: AudioContext;
  /** Melody and bass go straight to the layer's cross-fade gain. */
  readonly out: AudioNode;
  /** Pad voices go through the layer's slowly sweeping low-pass. */
  readonly pad: AudioNode;
  voice(source: OscillatorNode, chain: AudioNode[], start: number, stop: number): void;
}

interface ToneSpec {
  readonly type: OscillatorType;
  readonly freq: number;
  readonly start: number;
  readonly duration: number;
  readonly peak: number;
  readonly attack: number;
  readonly hold?: number;
  readonly detune?: number;
  readonly toPad?: boolean;
  readonly filter?: { readonly freq: number; readonly to?: number; readonly q?: number };
}

/**
 * Attack / hold / decay on a gain node. Every voice gets one: an oscillator
 * connected straight to a bus clicks on both ends, and a bed of clicks is worse
 * than no music.
 */
function envelope(
  ctx: AudioContext,
  start: number,
  duration: number,
  peak: number,
  attack: number,
  hold: number,
): GainNode {
  const gain = ctx.createGain();
  const end = start + duration;
  const level = clamp(peak, MIN_GAIN * 10, 1);
  const rise = clamp(attack, 0.004, duration * 0.6);
  const decayStart = Math.max(start + rise, Math.min(start + rise + Math.max(0, hold), end - 0.005));
  gain.gain.setValueAtTime(MIN_GAIN, start);
  gain.gain.linearRampToValueAtTime(level, start + rise);
  gain.gain.setValueAtTime(level, decayStart);
  gain.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
  return gain;
}

function tone(sink: Sink, spec: ToneSpec): void {
  const { ctx } = sink;
  const duration = Math.max(0.05, spec.duration);
  const start = spec.start;
  const end = start + duration;

  const osc = ctx.createOscillator();
  osc.type = spec.type;
  osc.frequency.setValueAtTime(clamp(spec.freq, 20, 12000), start);
  if (spec.detune) osc.detune.setValueAtTime(spec.detune, start);

  const gain = envelope(ctx, start, duration, spec.peak, spec.attack, spec.hold ?? 0);
  gain.connect(spec.toPad ? sink.pad : sink.out);

  const chain: AudioNode[] = [gain];
  let head: AudioNode = gain;
  if (spec.filter) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(clamp(spec.filter.freq, 40, 18000), start);
    if (spec.filter.to !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(clamp(spec.filter.to, 40, 18000), end);
    }
    filter.Q.setValueAtTime(spec.filter.q ?? 0.7, start);
    filter.connect(gain);
    chain.push(filter);
    head = filter;
  }
  osc.connect(head);
  sink.voice(osc, chain, start, end + TAIL);
}

/**
 * The pad: each chord tone as a pair of triangles a few cents apart. The slow
 * beating between them is the whole timbre — it is what makes a stack of
 * oscillators sound like an instrument breathing rather than a test tone.
 */
function padChord(sink: Sink, chord: Chord, start: number, duration: number, peak: number): void {
  chord.voicing.forEach((semitone, index) => {
    const freq = dNote(semitone - 12);
    for (const detune of [-7, 6]) {
      tone(sink, {
        type: 'triangle',
        freq,
        detune,
        start,
        duration,
        peak,
        toPad: true,
        // Very long attack and hold: the chord swells in and only starts
        // fading once the next one has already begun.
        attack: duration * 0.35,
        hold: duration * 0.3,
      });
    }
    // One sine an octave above the lowest voice adds body without adding a
    // note anyone can pick out.
    if (index === 0) {
      tone(sink, {
        type: 'sine',
        freq: freq * 2,
        start,
        duration,
        peak: peak * 0.45,
        toPad: true,
        attack: duration * 0.4,
        hold: duration * 0.25,
      });
    }
  });
}

/** Root note under the chord: a sine for weight, a quiet octave for phones. */
function bassRoot(sink: Sink, chord: Chord, start: number, duration: number, peak: number): void {
  const freq = dNote(chord.bass - 24);
  tone(sink, {
    type: 'sine',
    freq,
    start,
    duration,
    peak,
    attack: Math.min(0.9, duration * 0.2),
    hold: duration * 0.35,
    filter: { freq: 320, q: 0.5 },
  });
  // Phone speakers reproduce almost nothing below ~150 Hz, so the octave is
  // what actually carries the root on the device most people play on.
  tone(sink, {
    type: 'triangle',
    freq: freq * 2,
    start,
    duration: duration * 0.8,
    peak: peak * 0.3,
    attack: Math.min(1.2, duration * 0.25),
    hold: duration * 0.25,
    filter: { freq: 700, q: 0.5 },
  });
}

/** One slow open-and-close of the pad filter per chord: movement, not effect. */
function sweep(filter: BiquadFilterNode, start: number, duration: number, lo: number, hi: number): void {
  filter.frequency.setValueAtTime(lo, start);
  filter.frequency.linearRampToValueAtTime(hi, start + duration * 0.55);
  filter.frequency.linearRampToValueAtTime(lo, start + duration);
}

/** Schedules the arpeggio note (if any) that belongs to this grid step. */
function arpeggio(sink: Sink, spec: SceneSpec, step: number, time: number): void {
  const arp = spec.arp;
  if (!arp) return;

  const bar = Math.floor(step / spec.stepsPerBar);
  // Rests are chosen per bar, not per note: silence that lands on a bar line
  // reads as phrasing, silence that lands anywhere reads as a fault.
  if (rand(spec.seed ^ REST_SALT, bar) > arp.barChance) return;

  const rhythm = pick(RHYTHMS, spec.seed, bar);
  const slot = rhythm.indexOf(step % spec.stepsPerBar);
  if (slot < 0) return;

  const motif = pick(MOTIFS, spec.seed ^ MOTIF_SALT, bar);
  const register = pick(REGISTERS, spec.seed ^ REGISTER_SALT, bar);
  const freq = dNote(ARP_OCTAVE + register + PENTATONIC[motif[slot % motif.length]]);

  tone(sink, {
    type: 'triangle',
    freq,
    start: time,
    duration: arp.length,
    peak: arp.peak,
    attack: 0.02,
    hold: arp.length * 0.08,
    // Opening dull and closing duller keeps a pluck soft-edged; a bare
    // triangle in this register is glassy enough to distract.
    filter: { freq: 3200, to: 1400, q: 0.7 },
  });
  tone(sink, {
    type: 'sine',
    freq: freq * 2,
    start: time,
    duration: arp.length * 0.45,
    peak: arp.peak * 0.28,
    attack: 0.02,
  });
}

function flourish(sink: Sink, notes: readonly FlourishNote[], start: number): void {
  for (const item of notes) {
    const freq = dNote(item.semitone);
    tone(sink, {
      type: item.type,
      freq,
      start: start + item.at,
      duration: item.duration,
      peak: item.peak,
      attack: item.type === 'sine' ? 0.08 : 0.012,
      hold: item.duration * 0.1,
      // Cutoff tracks the note so the timbre is even across the run instead of
      // brightening as it climbs.
      filter: { freq: Math.max(900, freq * 5), to: Math.max(600, freq * 2), q: 0.6 },
    });
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

interface Mix {
  readonly ctx: AudioContext;
  readonly destination: AudioNode;
  /** Volume trim for the whole bed. */
  readonly gain: GainNode;
}

interface Layer {
  readonly scene: MusicScene;
  readonly spec: SceneSpec;
  /** Cross-fade gain: the only thing that changes when scenes swap. */
  readonly gain: GainNode;
  readonly pad: BiquadFilterNode;
  readonly voices: Set<Voice>;
  /** Index of the next grid step to schedule. */
  step: number;
  /** Absolute context time of that step. */
  nextTime: number;
  cleanup: ReturnType<typeof setTimeout> | null;
}

export class MusicController {
  private readonly bus: MusicBus;

  private enabledFlag: boolean;
  private volumeLevel: number;

  private desired: MusicScene | null = null;
  private suspended = false;
  private disposed = false;

  private mix: Mix | null = null;
  private active: Layer | null = null;
  /** Layers that are fading out; they still own voices until the fade ends. */
  private readonly retiring = new Set<Layer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Where the phrase was when the tab was hidden, so `resume()` continues it. */
  private carried: { scene: MusicScene; step: number } | null = null;

  constructor(bus: MusicBus, options?: Partial<MusicControllerOptions>) {
    // Deliberately inert: the supplier is not called and no node is built until
    // a scene is actually asked for.
    this.bus = typeof bus === 'function' ? bus : () => null;
    this.enabledFlag = options?.enabled ?? DEFAULT_MUSIC_OPTIONS.enabled;
    const requested = options?.volume;
    this.volumeLevel =
      typeof requested === 'number' && Number.isFinite(requested)
        ? clamp(requested, 0, 1)
        : DEFAULT_MUSIC_OPTIONS.volume;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledFlag) return;
    this.enabledFlag = enabled;
    if (this.disposed) return;
    // `sync()` fades rather than cuts, and stops the scheduler outright when
    // the music is switched off — no silent oscillators left burning battery.
    this.sync();
  }

  get volume(): number {
    return this.volumeLevel;
  }

  setVolume(volume: number): void {
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
    const next = clamp(volume, 0, 1);
    const previous = this.volumeLevel;
    this.volumeLevel = next;
    if (this.disposed) return;

    const mix = this.mix;
    if (mix) {
      try {
        // Ramp rather than jump so dragging a slider does not zipper.
        mix.gain.gain.setTargetAtTime(next * BED_PEAK, mix.ctx.currentTime, 0.05);
      } catch {
        /* A rejected schedule only costs us the smoothing. */
      }
    }
    // Crossing zero is a mute: below it there is nothing to hear, so there is
    // no reason to keep synthesising.
    if (previous <= 0 !== next <= 0) this.sync();
  }

  get scene(): MusicScene | null {
    return this.desired;
  }

  /** Cross-fades to a scene. Safe to call repeatedly with the same scene. */
  play(scene: MusicScene): void {
    if (this.disposed) return;
    // Guard the table lookup: this is called from wiring that may hand us
    // whatever a saved state or a URL contained.
    if (!SCENES[scene]) return;
    this.desired = scene;
    this.sync();
  }

  /** Fades out and stops all scheduling. */
  stop(): void {
    this.desired = null;
    this.carried = null;
    if (this.disposed) return;
    this.sync();
  }

  /** Pause for tab visibility. Idempotent; the current scene is remembered. */
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    if (this.disposed) return;
    const active = this.active;
    // Remember the position too, so coming back continues the piece instead of
    // restarting it — which would also re-fire a victory flourish.
    this.carried = active ? { scene: active.scene, step: active.step } : null;
    this.sync();
  }

  /** Resume after {@link suspend}. Idempotent. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    if (this.disposed) return;
    this.sync();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.desired = null;
    this.carried = null;
    this.stopScheduler();

    const active = this.active;
    this.active = null;
    if (active) this.destroyLayer(active);
    for (const layer of [...this.retiring]) this.destroyLayer(layer);
    this.retiring.clear();
    // The context itself belongs to the sound engine: we only ever unhook from
    // it, never close it.
    this.releaseMix();
  }

  // -------------------------------------------------------------------------
  // State machine
  // -------------------------------------------------------------------------

  /** Brings the graph in line with what the flags say should be playing. */
  private sync(): void {
    const wanted =
      this.disposed || !this.enabledFlag || this.suspended || this.volumeLevel <= 0 ? null : this.desired;

    const active = this.active;
    if (active && active.scene === wanted) return;

    if (active) {
      this.active = null;
      this.retire(active, wanted === null ? RELEASE_FADE : CROSSFADE);
    }

    if (wanted === null) {
      this.stopScheduler();
      this.collect();
      return;
    }

    const layer = this.startLayer(wanted);
    this.active = layer;
    if (!layer) {
      // No audio available. Stay inert; a later call retries cheaply because
      // the supplier latches its own failure.
      this.stopScheduler();
      return;
    }
    this.ensureScheduler();
    // Prime the first notes now rather than waiting a tick, so a cue-like
    // scene (victory, defeat) starts on the frame it was asked for.
    this.tick();
  }

  /** Builds the shared trim gain on first use. Returns null when unsupported. */
  private graph(): Mix | null {
    if (this.disposed) return null;

    let bus: { ctx: AudioContext; destination: AudioNode } | null = null;
    try {
      bus = this.bus();
    } catch {
      // A supplier that throws is indistinguishable from "no audio here".
      return null;
    }
    if (!bus || !bus.ctx || !bus.destination) return null;

    const existing = this.mix;
    if (existing && existing.ctx === bus.ctx && existing.destination === bus.destination) return existing;
    // The sound engine rebuilt its graph underneath us; drop the stale trim.
    if (existing) this.releaseMix();

    try {
      const gain = bus.ctx.createGain();
      gain.gain.value = this.volumeLevel * BED_PEAK;
      gain.connect(bus.destination);
      this.mix = { ctx: bus.ctx, destination: bus.destination, gain };
      return this.mix;
    } catch {
      return null;
    }
  }

  private startLayer(scene: MusicScene): Layer | null {
    const mix = this.graph();
    if (!mix) return null;
    const { ctx } = mix;

    try {
      // Autoplay policy parks the context until a gesture. Ask once; if it
      // refuses, notes still schedule against a clock that is not moving and
      // will be heard the moment it does.
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    } catch {
      /* Nothing to do but carry on quietly. */
    }

    try {
      const spec = SCENES[scene];
      const start = ctx.currentTime + LEAD;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(MIN_GAIN, start);
      gain.gain.exponentialRampToValueAtTime(spec.level, start + spec.fadeIn);
      gain.connect(mix.gain);

      const pad = ctx.createBiquadFilter();
      pad.type = 'lowpass';
      pad.frequency.setValueAtTime(spec.filterLo, start);
      pad.Q.setValueAtTime(0.6, start);
      pad.connect(gain);

      const carried = this.carried;
      this.carried = null;
      return {
        scene,
        spec,
        gain,
        pad,
        voices: new Set<Voice>(),
        step: carried && carried.scene === scene ? carried.step : 0,
        nextTime: start,
        cleanup: null,
      };
    } catch {
      return null;
    }
  }

  /** Fades a layer out, then frees it. Its voices keep playing through the fade. */
  private retire(layer: Layer, fade: number): void {
    const now = this.now();
    try {
      const param = layer.gain.gain;
      // Re-anchor on the value the fade-in reached before overriding it;
      // cancelling alone would snap the gain and click.
      param.cancelScheduledValues(now);
      param.setValueAtTime(Math.max(MIN_GAIN, param.value), now);
      param.exponentialRampToValueAtTime(MIN_GAIN, now + fade);
    } catch {
      /* Fall through: the teardown below still frees everything. */
    }
    this.retiring.add(layer);
    layer.cleanup = setTimeout(
      () => {
        layer.cleanup = null;
        this.destroyLayer(layer);
      },
      Math.round((fade + TAIL) * 1000),
    );
  }

  private destroyLayer(layer: Layer): void {
    if (layer.cleanup !== null) {
      clearTimeout(layer.cleanup);
      layer.cleanup = null;
    }
    for (const voice of [...layer.voices]) {
      try {
        voice.source.stop();
      } catch {
        /* Never started, or already finished. */
      }
      this.release(layer, voice);
    }
    layer.voices.clear();
    try {
      layer.pad.disconnect();
      layer.gain.disconnect();
    } catch {
      /* Disconnecting twice is harmless. */
    }
    this.retiring.delete(layer);
    this.collect();
  }

  /** Drops the trim gain once nothing is playing and nothing is wanted. */
  private collect(): void {
    if (this.active || this.retiring.size > 0) return;
    if (!this.disposed && this.desired !== null) return;
    this.releaseMix();
  }

  private releaseMix(): void {
    const mix = this.mix;
    this.mix = null;
    if (!mix) return;
    try {
      mix.gain.disconnect();
    } catch {
      /* Already torn down. */
    }
  }

  /** The audio clock, or 0 if even reading it fails on a dead context. */
  private now(): number {
    try {
      return this.mix?.ctx.currentTime ?? 0;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private ensureScheduler(): void {
    if (this.timer !== null || !this.active) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopScheduler(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Commits every note that falls inside the lookahead window. The timer only
   * decides *when we look*; the audio clock decides when notes actually sound,
   * which is why a late or coalesced timer costs nothing.
   */
  private tick(): void {
    const layer = this.active;
    const mix = this.mix;
    if (!layer || !mix) {
      this.stopScheduler();
      return;
    }
    try {
      const now = mix.ctx.currentTime;
      // A backgrounded tab throttles timers to once a minute; rather than dump
      // a minute of backlog into the graph, pick the phrase up from here.
      if (layer.nextTime < now) layer.nextTime = now + LEAD;

      const horizon = now + LOOKAHEAD;
      for (let i = 0; i < MAX_STEPS_PER_TICK && layer.nextTime < horizon; i++) {
        this.scheduleStep(layer, mix.ctx);
        layer.step += 1;
        layer.nextTime += layer.spec.step;
      }
    } catch {
      // The graph died under us (a closed context, a hostile environment).
      // Tear down quietly; a later play() rebuilds from whatever the bus hands
      // back next.
      this.panic();
    }
  }

  private scheduleStep(layer: Layer, ctx: AudioContext): void {
    const { spec, step } = layer;
    const time = layer.nextTime;
    const sink: Sink = {
      ctx,
      out: layer.gain,
      pad: layer.pad,
      voice: (source, chain, start, stop) => this.track(layer, source, chain, start, stop),
    };

    const stepsPerChord = spec.stepsPerBar * spec.barsPerChord;
    if (step % stepsPerChord === 0) {
      const chord = spec.progression[Math.floor(step / stepsPerChord) % spec.progression.length];
      const span = stepsPerChord * spec.step;
      padChord(sink, chord, time, span * PAD_OVERLAP, spec.padPeak);
      bassRoot(sink, chord, time, span * PAD_OVERLAP, spec.bassPeak);
      sweep(layer.pad, time, span, spec.filterLo, spec.filterHi);
    }

    // Scenes that open with a flourish schedule it once, on their first step.
    if (step === 0 && spec.flourish) flourish(sink, spec.flourish, time);

    arpeggio(sink, spec, step, time);
  }

  private track(layer: Layer, source: OscillatorNode, chain: AudioNode[], start: number, stop: number): void {
    const voice: Voice = { source, chain };
    layer.voices.add(voice);
    // Every voice frees its own nodes when it ends, which is what keeps a
    // multi-hour session from growing the graph without bound.
    source.onended = () => this.release(layer, voice);
    source.start(start);
    source.stop(stop);
  }

  private release(layer: Layer, voice: Voice): void {
    if (!layer.voices.delete(voice)) return;
    try {
      voice.source.onended = null;
      voice.source.disconnect();
      for (const node of voice.chain) node.disconnect();
    } catch {
      /* Disconnecting twice is harmless. */
    }
  }

  /** Emergency teardown after an unexpected graph failure. */
  private panic(): void {
    this.stopScheduler();
    const active = this.active;
    this.active = null;
    try {
      if (active) this.destroyLayer(active);
      for (const layer of [...this.retiring]) this.destroyLayer(layer);
    } catch {
      /* Best effort; the references are dropped either way. */
    }
    this.retiring.clear();
    this.releaseMix();
  }
}
