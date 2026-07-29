/**
 * Monster Territory — procedural sound engine.
 *
 * ORIGINALITY: every cue in this file is synthesised at runtime with the Web
 * Audio API from oscillators, an algorithmically generated noise buffer, gain
 * envelopes and biquad filters. The game ships **no sampled or third-party
 * audio whatsoever** — no recordings, no audio files, no data-URI blobs, no
 * licensed sound packs. All cues are original works composed for this project
 * in code. Besides settling provenance, this keeps the bundle at zero extra
 * bytes of assets and makes the game audible offline and on first load.
 *
 * Design notes:
 *  - The AudioContext is built lazily on the first `unlock()`/`play()`. Creating
 *    it at import time trips browser autoplay policy warnings and would crash
 *    the module in Node/jsdom where Web Audio does not exist at all.
 *  - Nothing here may throw into gameplay. Every entry point is wrapped or
 *    guarded so a missing/failed audio stack degrades to silence, never to a
 *    broken turn.
 *  - Cues are deliberately short (< 900 ms) and quiet (peaks well under unity)
 *    because several can overlap during a conversion cascade.
 */

export type SoundName =
  | 'select'
  | 'deselect'
  | 'clone'
  | 'jump'
  | 'convert'
  | 'turn-change'
  | 'win'
  | 'lose'
  | 'tie'
  | 'invalid'
  | 'ui-tap';

export interface SoundControllerOptions {
  enabled: boolean;
  /** 0..1 */
  volume: number;
}

export const DEFAULT_SOUND_OPTIONS: SoundControllerOptions = Object.freeze({
  enabled: true,
  volume: 0.7,
});

/**
 * A cue repeated faster than this is inaudible as a separate event and only
 * adds level, so extras past {@link RATE_LIMIT} inside the window are dropped.
 */
const RATE_WINDOW_MS = 100;
const RATE_LIMIT = 6;

/** Exponential ramps cannot reach zero; this is our practical silence. */
const MIN_GAIN = 0.0001;
/** Schedule a hair ahead of `currentTime` so the attack is not clipped by the
 *  render quantum that is already in flight. */
const LEAD = 0.005;
/** Extra time a source stays alive after its envelope closes. */
const TAIL = 0.03;
/** Longest a single cue may occupy, used to size the noise buffer. */
const MAX_CUE_SECONDS = 0.9;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  // Looked up on every attempt rather than cached at module scope: the module
  // may be imported long before a DOM exists (SSR, worker bootstrap, tests).
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Equal-tempered frequency for a semitone offset from A4 = 440 Hz. */
function note(semitonesFromA4: number): number {
  return 440 * Math.pow(2, semitonesFromA4 / 12);
}

interface Voice {
  source: AudioScheduledSourceNode;
  /** Every node between the source and the bus, so we can free the graph. */
  chain: AudioNode[];
}

interface CueContext {
  ctx: AudioContext;
  /** Bus input every cue connects to. */
  out: AudioNode;
  /** Absolute context time at which this cue begins. */
  t: number;
  /** Intensity-derived amplitude multiplier applied to every voice peak. */
  amp: number;
  /** Lazy so cues without noise never allocate the buffer. */
  noise: () => AudioBuffer;
  voice: (source: AudioScheduledSourceNode, chain: AudioNode[], start: number, stop: number) => void;
}

interface ToneSpec {
  type: OscillatorType;
  /** Offset from the cue start, in seconds. */
  at: number;
  duration: number;
  freq: number;
  /** Optional glide target reached at the end of the tone. */
  to?: number;
  peak: number;
  attack?: number;
  /** Time held at peak before the decay begins. */
  hold?: number;
  detune?: number;
  filter?: { type: BiquadFilterType; freq: number; to?: number; q?: number };
}

interface NoiseSpec {
  at: number;
  duration: number;
  peak: number;
  attack?: number;
  hold?: number;
  type?: BiquadFilterType;
  freq: number;
  to?: number;
  q?: number;
  rate?: number;
}

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
  const rise = clamp(attack, 0.001, duration * 0.5);
  const decayStart = Math.min(start + rise + Math.max(0, hold), end - 0.001);
  gain.gain.setValueAtTime(MIN_GAIN, start);
  gain.gain.linearRampToValueAtTime(level, start + rise);
  gain.gain.setValueAtTime(level, decayStart);
  gain.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
  return gain;
}

function tone(cue: CueContext, spec: ToneSpec): void {
  const { ctx } = cue;
  const start = cue.t + spec.at;
  const duration = Math.max(0.01, spec.duration);
  const end = start + duration;

  const osc = ctx.createOscillator();
  osc.type = spec.type;
  osc.frequency.setValueAtTime(Math.max(20, spec.freq), start);
  if (spec.to !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, spec.to), end);
  }
  if (spec.detune) osc.detune.setValueAtTime(spec.detune, start);

  const gain = envelope(ctx, start, duration, spec.peak * cue.amp, spec.attack ?? 0.006, spec.hold ?? 0);
  gain.connect(cue.out);

  const chain: AudioNode[] = [gain];
  let head: AudioNode = gain;
  if (spec.filter) {
    const filter = ctx.createBiquadFilter();
    filter.type = spec.filter.type;
    filter.frequency.setValueAtTime(Math.max(20, spec.filter.freq), start);
    if (spec.filter.to !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, spec.filter.to), end);
    }
    filter.Q.setValueAtTime(spec.filter.q ?? 0.7, start);
    filter.connect(gain);
    chain.push(filter);
    head = filter;
  }
  osc.connect(head);
  cue.voice(osc, chain, start, end + TAIL);
}

function noiseBurst(cue: CueContext, spec: NoiseSpec): void {
  const { ctx } = cue;
  const start = cue.t + spec.at;
  const duration = Math.max(0.01, spec.duration);
  const end = start + duration;

  const source = ctx.createBufferSource();
  source.buffer = cue.noise();
  // The buffer is longer than any cue, but looping removes the possibility of
  // an early end if a device ever reports an unusually low sample rate.
  source.loop = true;
  if (spec.rate !== undefined) source.playbackRate.setValueAtTime(Math.max(0.05, spec.rate), start);

  const filter = ctx.createBiquadFilter();
  filter.type = spec.type ?? 'bandpass';
  filter.frequency.setValueAtTime(Math.max(20, spec.freq), start);
  if (spec.to !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, spec.to), end);
  }
  filter.Q.setValueAtTime(spec.q ?? 1, start);

  const gain = envelope(ctx, start, duration, spec.peak * cue.amp, spec.attack ?? 0.003, spec.hold ?? 0);

  source.connect(filter);
  filter.connect(gain);
  gain.connect(cue.out);
  cue.voice(source, [filter, gain], start, end + TAIL);
}

/** Major pentatonic, in semitones — always consonant however many notes play. */
const PENTATONIC = [0, 2, 4, 7, 9, 12];

/**
 * Renders one cue into the graph. Each cue has a deliberately distinct shape so
 * a player can follow the match by ear alone.
 */
function renderCue(cue: CueContext, name: SoundName, intensity: number): void {
  switch (name) {
    // Short soft blip: a single rising sine with a whisper of sub for body.
    case 'select':
      tone(cue, {
        type: 'sine',
        at: 0,
        duration: 0.1,
        freq: 880,
        to: 990,
        peak: 0.16,
        attack: 0.004,
        filter: { type: 'lowpass', freq: 3200 },
      });
      tone(cue, { type: 'triangle', at: 0, duration: 0.07, freq: 440, peak: 0.05 });
      return;

    // The mirror image of `select` so picking up and putting down a monster are
    // obviously the same gesture in reverse.
    case 'deselect':
      tone(cue, {
        type: 'sine',
        at: 0,
        duration: 0.11,
        freq: 780,
        to: 520,
        peak: 0.12,
        attack: 0.004,
        filter: { type: 'lowpass', freq: 2600 },
      });
      return;

    // Warm two-note rise (G4 -> C5): growth, not travel.
    case 'clone':
      tone(cue, {
        type: 'triangle',
        at: 0,
        duration: 0.13,
        freq: note(-2),
        peak: 0.14,
        attack: 0.008,
        filter: { type: 'lowpass', freq: 2400 },
      });
      tone(cue, {
        type: 'triangle',
        at: 0.085,
        duration: 0.2,
        freq: note(3),
        peak: 0.15,
        attack: 0.008,
        hold: 0.03,
        filter: { type: 'lowpass', freq: 2600, to: 1600 },
      });
      tone(cue, { type: 'sine', at: 0, duration: 0.18, freq: note(-14), peak: 0.06 });
      return;

    // Pitch-swept whoosh plus a landing thud: travel, then arrival.
    case 'jump':
      noiseBurst(cue, {
        at: 0,
        duration: 0.19,
        peak: 0.13,
        freq: 420,
        to: 2600,
        q: 1.4,
        attack: 0.03,
        type: 'bandpass',
      });
      tone(cue, {
        type: 'sine',
        at: 0.19,
        duration: 0.22,
        freq: 190,
        to: 62,
        peak: 0.24,
        attack: 0.004,
        filter: { type: 'lowpass', freq: 900, to: 220 },
      });
      // A dry tick on impact so the landing reads on phone speakers, which
      // reproduce almost nothing of the sub-bass thud.
      noiseBurst(cue, { at: 0.19, duration: 0.05, peak: 0.09, freq: 1400, to: 500, q: 0.8, type: 'lowpass' });
      return;

    // Bright arpeggio whose length and pitch grow with the conversion count.
    case 'convert': {
      const notes = Math.round(clamp(1 + intensity * 2.5, 2, PENTATONIC.length));
      // Bigger cascades also transpose up, so a six-piece flip is unmistakably
      // higher and longer than a single one. Whole-tone steps only: shifting a
      // major pentatonic by a whole tone keeps it consonant against the fixed
      // C-rooted win/lose cues, a semitone shift would not.
      const lift = Math.round(clamp(intensity - 1, -1, 1)) * 2;
      const step = 0.055;
      for (let i = 0; i < notes; i++) {
        const last = i === notes - 1;
        const freq = note(3 + lift + PENTATONIC[i]);
        tone(cue, {
          type: 'triangle',
          at: i * step,
          duration: last ? 0.25 : 0.14,
          freq,
          peak: 0.11,
          attack: 0.004,
          filter: { type: 'lowpass', freq: 5200, to: last ? 2200 : 3600 },
        });
        // Octave sparkle, quiet enough to read as timbre rather than a note.
        tone(cue, { type: 'sine', at: i * step, duration: 0.07, freq: freq * 2, peak: 0.035 });
      }
      return;
    }

    // Low soft pulse: felt more than heard, so it never competes with a move.
    case 'turn-change':
      tone(cue, {
        type: 'sine',
        at: 0,
        duration: 0.34,
        freq: 130,
        to: 168,
        peak: 0.17,
        attack: 0.05,
        hold: 0.04,
        filter: { type: 'lowpass', freq: 700 },
      });
      tone(cue, { type: 'triangle', at: 0.02, duration: 0.22, freq: 196, peak: 0.045, attack: 0.05 });
      return;

    // Major triad flourish, arpeggio then a short pad.
    case 'win': {
      const arpeggio = [3, 7, 10, 15]; // C5 E5 G5 C6
      arpeggio.forEach((semitone, i) => {
        tone(cue, {
          type: 'triangle',
          at: i * 0.08,
          duration: i === arpeggio.length - 1 ? 0.45 : 0.3,
          freq: note(semitone),
          peak: 0.12,
          attack: 0.006,
          hold: 0.02,
          filter: { type: 'lowpass', freq: 5000, to: 2400 },
        });
      });
      for (const semitone of [3, 7, 10]) {
        tone(cue, {
          type: 'sine',
          at: 0.28,
          duration: 0.45,
          freq: note(semitone),
          peak: 0.05,
          attack: 0.06,
          hold: 0.08,
        });
      }
      return;
    }

    // Descending minor fall (A4 F4 D4 A3), soft-edged so defeat is not harsh.
    case 'lose': {
      const fall = [0, -4, -7, -12];
      fall.forEach((semitone, i) => {
        tone(cue, {
          type: 'sawtooth',
          at: i * 0.13,
          duration: i === fall.length - 1 ? 0.42 : 0.24,
          freq: note(semitone),
          peak: 0.1,
          attack: 0.01,
          filter: { type: 'lowpass', freq: 1200, to: 520 },
        });
      });
      tone(cue, { type: 'sine', at: 0.39, duration: 0.4, freq: note(-24), peak: 0.08, attack: 0.02 });
      return;
    }

    // Two notes at the same pitch: no resolution up or down — a draw.
    case 'tie':
      tone(cue, {
        type: 'triangle',
        at: 0,
        duration: 0.22,
        freq: note(7),
        peak: 0.11,
        filter: { type: 'lowpass', freq: 2600 },
      });
      tone(cue, {
        type: 'triangle',
        at: 0.18,
        duration: 0.3,
        freq: note(7),
        // A few cents flat: the pair sits slightly unresolved without becoming
        // a different note.
        detune: -8,
        peak: 0.11,
        filter: { type: 'lowpass', freq: 2200 },
      });
      return;

    // Short dull buzz. Two detuned squares beat against each other, and a hard
    // lowpass keeps it thuddy instead of piercing — a rejection, not a scold.
    case 'invalid':
      tone(cue, {
        type: 'square',
        at: 0,
        duration: 0.15,
        freq: 98,
        peak: 0.12,
        attack: 0.004,
        hold: 0.05,
        filter: { type: 'lowpass', freq: 420 },
      });
      tone(cue, {
        type: 'square',
        at: 0,
        duration: 0.15,
        freq: 104,
        peak: 0.07,
        attack: 0.004,
        hold: 0.05,
        filter: { type: 'lowpass', freq: 380 },
      });
      return;

    // Tiny click for generic UI chrome: nearly all transient, no pitch.
    case 'ui-tap':
      noiseBurst(cue, { at: 0, duration: 0.022, peak: 0.1, freq: 2400, q: 0.6, type: 'highpass' });
      tone(cue, { type: 'sine', at: 0, duration: 0.03, freq: 1400, peak: 0.05, attack: 0.002 });
      return;
  }
}

export class SoundController {
  private enabledFlag: boolean;
  private volumeLevel: number;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noise: AudioBuffer | null = null;

  private disposed = false;
  /** Latched once we know this environment cannot do Web Audio at all, so we
   *  do not retry (and re-throw) on every cue. */
  private unavailable = false;

  private readonly voices = new Set<Voice>();
  /** Cue name -> recent trigger times in ms on the audio clock. */
  private readonly recent = new Map<SoundName, number[]>();

  constructor(options?: Partial<SoundControllerOptions>) {
    this.enabledFlag = options?.enabled ?? DEFAULT_SOUND_OPTIONS.enabled;
    const requested = options?.volume;
    this.volumeLevel =
      typeof requested === 'number' && Number.isFinite(requested)
        ? clamp(requested, 0, 1)
        : DEFAULT_SOUND_OPTIONS.volume;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabledFlag) return;
    this.enabledFlag = enabled;
    if (!enabled) {
      // Cut tails immediately: a player hitting mute expects silence now, not
      // after the current flourish finishes.
      this.stopVoices();
      return;
    }
    // Re-enabling almost always happens from a settings tap, which is a user
    // gesture — a good moment to lift a context parked in `suspended`.
    this.resume();
  }

  get volume(): number {
    return this.volumeLevel;
  }

  setVolume(volume: number): void {
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return;
    this.volumeLevel = clamp(volume, 0, 1);
    const { master, ctx } = this;
    if (!master || !ctx) return;
    try {
      // Ramp rather than jump so dragging a slider does not zipper.
      master.gain.setTargetAtTime(this.volumeLevel, ctx.currentTime, 0.02);
    } catch {
      /* A rejected schedule only costs us the smoothing. */
    }
  }

  /**
   * Must be called from a user gesture; resumes a suspended AudioContext.
   *
   * Runs even while muted: priming the graph on the first tap means switching
   * sound on mid-match is audible immediately rather than one cue later.
   */
  async unlock(): Promise<void> {
    const ctx = this.context();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {
      /* Autoplay policy or a closed context: stay silent, never reject. */
    }
  }

  play(name: SoundName, options?: { intensity?: number }): void {
    if (this.disposed || !this.enabledFlag || this.volumeLevel <= 0) return;
    const ctx = this.context();
    if (!ctx) return;

    try {
      if (ctx.state !== 'running') {
        // Nothing can be heard before the first gesture. Ask for a resume so the
        // next cue lands, and drop this one instead of queueing stale audio.
        this.resume();
        return;
      }

      const now = ctx.currentTime * 1000;
      if (this.throttled(name, now)) return;

      const requested = options?.intensity;
      const level = typeof requested === 'number' && Number.isFinite(requested) ? clamp(requested, 0.25, 2) : 1;
      const cue: CueContext = {
        ctx,
        out: this.compressor ?? ctx.destination,
        t: ctx.currentTime + LEAD,
        // Loudness moves far less than intensity does: intensity mostly shapes
        // the cue, and the mix must stay stable during a cascade.
        amp: 0.7 + 0.3 * level,
        noise: () => this.noiseBuffer(ctx),
        voice: (source, chain, start, stop) => this.trackVoice(source, chain, start, stop),
      };
      renderCue(cue, name, level);
    } catch {
      /* A cue must never break a turn. */
    }
  }

  /** convert cue scales with how many pieces flipped (1..6+) */
  playConversion(count: number): void {
    const safe = typeof count === 'number' && Number.isFinite(count) ? clamp(Math.floor(count), 1, 6) : 1;
    // 1..6 pieces map onto the 0.33..2 intensity range the convert cue reads
    // for note count and transposition.
    this.play('convert', { intensity: safe / 3 });
  }

  dispose(): void {
    this.disposed = true;
    this.stopVoices();
    this.recent.clear();
    const ctx = this.ctx;
    try {
      this.compressor?.disconnect();
      this.master?.disconnect();
    } catch {
      /* Already torn down. */
    }
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this.noise = null;
    if (!ctx) return;
    try {
      void ctx.close().catch(() => undefined);
    } catch {
      /* Some engines throw instead of rejecting on a double close. */
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Builds the audio graph on first use. Returns null when unsupported. */
  private context(): AudioContext | null {
    if (this.disposed || this.unavailable) return null;
    if (this.ctx) return this.ctx;

    const Ctor = audioContextCtor();
    if (!Ctor) {
      this.unavailable = true;
      return null;
    }

    try {
      let ctx: AudioContext;
      try {
        ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        // Older WebKit builds reject the options bag outright.
        ctx = new Ctor();
      }

      const master = ctx.createGain();
      master.gain.value = this.volumeLevel;
      master.connect(ctx.destination);

      const compressor = ctx.createDynamicsCompressor();
      // Sits *ahead* of the volume trim so its threshold describes a fixed
      // property of the mix rather than something that moves with the slider.
      compressor.threshold.value = -18;
      compressor.knee.value = 24;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.18;
      compressor.connect(master);

      this.ctx = ctx;
      this.master = master;
      this.compressor = compressor;
      return ctx;
    } catch {
      this.unavailable = true;
      return null;
    }
  }

  private resume(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    try {
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    } catch {
      /* Nothing to do but stay silent. */
    }
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * MAX_CUE_SECONDS));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // A seeded LCG rather than Math.random: the noise texture is part of the
    // sound design, so it must be byte-identical on every device and run.
    let seed = 0x2f6e2b1;
    for (let i = 0; i < frames; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    this.noise = buffer;
    return buffer;
  }

  /** True when this cue has already fired {@link RATE_LIMIT} times recently. */
  private throttled(name: SoundName, now: number): boolean {
    const stamps = this.recent.get(name);
    if (!stamps) {
      this.recent.set(name, [now]);
      return false;
    }
    let kept = 0;
    for (const at of stamps) {
      if (now - at < RATE_WINDOW_MS) stamps[kept++] = at;
    }
    stamps.length = kept;
    if (kept >= RATE_LIMIT) return true;
    stamps.push(now);
    return false;
  }

  private trackVoice(source: AudioScheduledSourceNode, chain: AudioNode[], start: number, stop: number): void {
    const voice: Voice = { source, chain };
    this.voices.add(voice);
    source.onended = () => this.releaseVoice(voice);
    source.start(start);
    source.stop(stop);
  }

  private releaseVoice(voice: Voice): void {
    if (!this.voices.delete(voice)) return;
    try {
      voice.source.onended = null;
      voice.source.disconnect();
      for (const node of voice.chain) node.disconnect();
    } catch {
      /* Disconnecting twice is harmless. */
    }
  }

  private stopVoices(): void {
    // Copy first: releasing mutates the set.
    for (const voice of [...this.voices]) {
      try {
        voice.source.stop();
      } catch {
        /* Never started, or already finished. */
      }
      this.releaseVoice(voice);
    }
  }
}
