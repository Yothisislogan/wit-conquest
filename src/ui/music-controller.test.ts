/**
 * Unit tests for the procedural music engine.
 *
 * Three suites:
 *  1. No Web Audio at all — the environment vitest actually runs in. Every
 *     entry point must be a silent no-op, and nothing may be scheduled: a
 *     leaked interval in Node would keep the test process (and a server-side
 *     render) awake forever.
 *  2. A hand-written in-memory Web Audio implementation with a clock the test
 *     advances by hand. It cannot tell us whether the music sounds good, but it
 *     does pin down the things that make it *work*: lookahead scheduling
 *     against the audio clock, cross-fades instead of cuts, deterministic note
 *     choice, and a graph that does not grow without bound.
 *  3. Hostile graphs — a bus supplier that throws, a context that refuses to
 *     resume, a node factory that fails mid-session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MUSIC_OPTIONS, MusicController, type MusicScene } from './music-controller.ts';
import { SoundController } from './sound-controller.ts';

const ALL_SCENES: MusicScene[] = ['menu', 'match', 'victory', 'defeat'];

/** Peak of the bed on the shared bus, mirroring `BED_PEAK` in the engine. */
const BED_PEAK = 0.18;

// ---------------------------------------------------------------------------
// Suite 1 — no Web Audio available
// ---------------------------------------------------------------------------

describe('MusicController without Web Audio', () => {
  const noBus = (): null => null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('constructs without touching the audio graph', () => {
    const bus = vi.fn(() => null);
    expect(() => new MusicController(bus)).not.toThrow();
    expect(() => new MusicController(bus, { enabled: true, volume: 1 })).not.toThrow();
    expect(bus).not.toHaveBeenCalled();
  });

  it('takes enabled from the constructor option', () => {
    expect(new MusicController(noBus, { enabled: true }).enabled).toBe(true);
    expect(new MusicController(noBus, { enabled: false }).enabled).toBe(false);
    expect(new MusicController(noBus).enabled).toBe(DEFAULT_MUSIC_OPTIONS.enabled);
    expect(new MusicController(noBus, { volume: 0.2 }).enabled).toBe(DEFAULT_MUSIC_OPTIONS.enabled);
  });

  it('takes volume from the constructor option and clamps it', () => {
    expect(new MusicController(noBus, { volume: 0.25 }).volume).toBe(0.25);
    expect(new MusicController(noBus, { volume: -1 }).volume).toBe(0);
    expect(new MusicController(noBus, { volume: 2 }).volume).toBe(1);
    expect(new MusicController(noBus, { volume: Number.NaN }).volume).toBe(DEFAULT_MUSIC_OPTIONS.volume);
    expect(new MusicController(noBus, { volume: Number.POSITIVE_INFINITY }).volume).toBe(
      DEFAULT_MUSIC_OPTIONS.volume,
    );
    expect(new MusicController(noBus).volume).toBe(DEFAULT_MUSIC_OPTIONS.volume);
  });

  it('clamps setVolume and ignores unusable numbers', () => {
    const music = new MusicController(noBus, { volume: 0.4 });

    music.setVolume(-1);
    expect(music.volume).toBe(0);

    music.setVolume(2);
    expect(music.volume).toBe(1);

    music.setVolume(0.5);
    expect(music.volume).toBe(0.5);

    // A bad number must not mute the game; it is simply not a volume.
    music.setVolume(Number.NaN);
    expect(music.volume).toBe(0.5);
    music.setVolume(Number.POSITIVE_INFINITY);
    expect(music.volume).toBe(0.5);
    music.setVolume(Number.NEGATIVE_INFINITY);
    expect(music.volume).toBe(0.5);

    music.setVolume(0);
    expect(music.volume).toBe(0);
    music.setVolume(1);
    expect(music.volume).toBe(1);
  });

  it('plays, repeats and switches every scene as a no-op', () => {
    const music = new MusicController(noBus, { enabled: true, volume: 1 });
    for (const scene of ALL_SCENES) {
      expect(() => music.play(scene)).not.toThrow();
      expect(() => music.play(scene)).not.toThrow();
      expect(music.scene).toBe(scene);
    }
    expect(() => music.stop()).not.toThrow();
    expect(music.scene).toBeNull();
  });

  it('never schedules a timer when there is no audio to schedule', () => {
    const music = new MusicController(noBus, { enabled: true, volume: 1 });
    for (const scene of ALL_SCENES) music.play(scene);
    music.suspend();
    music.resume();
    music.setEnabled(false);
    music.setEnabled(true);
    // A leaked interval here would keep a Node process alive forever.
    expect(vi.getTimerCount()).toBe(0);
    music.dispose();
  });

  it('stops before playing anything', () => {
    const music = new MusicController(noBus, { enabled: true, volume: 1 });
    expect(() => music.stop()).not.toThrow();
    expect(() => music.stop()).not.toThrow();
    expect(music.scene).toBeNull();
  });

  it('keeps suspend and resume idempotent, and remembers the scene', () => {
    const music = new MusicController(noBus, { enabled: true, volume: 1 });
    music.play('match');

    music.suspend();
    music.suspend();
    expect(music.scene).toBe('match');

    music.resume();
    music.resume();
    expect(music.scene).toBe('match');

    // Resuming without a matching suspend is a no-op, not a restart.
    music.resume();
    expect(music.scene).toBe('match');
  });

  it('toggles enabled without losing the scene', () => {
    const music = new MusicController(noBus, { enabled: true, volume: 1 });
    music.play('menu');

    music.setEnabled(false);
    expect(music.enabled).toBe(false);
    expect(music.scene).toBe('menu');

    music.setEnabled(false);
    expect(music.enabled).toBe(false);

    music.setEnabled(true);
    expect(music.enabled).toBe(true);
    expect(music.scene).toBe('menu');
  });

  it('disposes twice and stays inert afterwards', () => {
    const music = new MusicController(noBus, { enabled: true, volume: 1 });
    music.play('menu');

    expect(() => music.dispose()).not.toThrow();
    expect(() => music.dispose()).not.toThrow();

    for (const scene of ALL_SCENES) expect(() => music.play(scene)).not.toThrow();
    expect(() => music.stop()).not.toThrow();
    expect(() => music.suspend()).not.toThrow();
    expect(() => music.resume()).not.toThrow();
    expect(() => music.setEnabled(true)).not.toThrow();
    expect(() => music.setVolume(0.5)).not.toThrow();
    expect(music.scene).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a scene name that is not one of the four', () => {
    const music = new MusicController(noBus, { enabled: true, volume: 1 });
    // Wiring may hand us whatever a saved state or a URL contained.
    music.play('elevator' as MusicScene);
    expect(music.scene).toBeNull();
    music.play('menu');
    music.play(undefined as unknown as MusicScene);
    expect(music.scene).toBe('menu');
  });

  it('stays silent against the real sound engine in a Node environment', () => {
    // The integration that actually ships: SoundController.bus() returns null
    // when Web Audio is missing, and the music must simply not happen.
    const sound = new SoundController({ enabled: true, volume: 1 });
    const music = new MusicController(() => sound.bus(), { enabled: true, volume: 1 });
    for (const scene of ALL_SCENES) expect(() => music.play(scene)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    music.dispose();
    sound.dispose();
  });

  it('survives a bus supplier that throws on every call', () => {
    const music = new MusicController(
      () => {
        throw new Error('SecurityError: audio fingerprinting blocked');
      },
      { enabled: true, volume: 1 },
    );
    for (const scene of ALL_SCENES) expect(() => music.play(scene)).not.toThrow();
    expect(() => music.setVolume(0.2)).not.toThrow();
    expect(() => music.setEnabled(false)).not.toThrow();
    expect(() => music.setEnabled(true)).not.toThrow();
    expect(() => music.suspend()).not.toThrow();
    expect(() => music.resume()).not.toThrow();
    expect(() => music.stop()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    music.dispose();
  });
});

// ---------------------------------------------------------------------------
// A hand-written Web Audio implementation
// ---------------------------------------------------------------------------

interface ParamEvent {
  type: 'set' | 'linear' | 'exponential' | 'target' | 'cancel';
  value: number;
  time: number;
}

class FakeParam {
  value: number;
  readonly events: ParamEvent[] = [];

  constructor(value: number) {
    this.value = value;
  }

  private record(type: ParamEvent['type'], value: number, time: number): this {
    if (!Number.isFinite(value)) throw new Error(`${type}: non-finite value`);
    if (!Number.isFinite(time) || time < 0) throw new Error(`${type}: bad time ${time}`);
    this.events.push({ type, value, time });
    this.value = value;
    return this;
  }

  setValueAtTime(value: number, time: number): this {
    return this.record('set', value, time);
  }

  linearRampToValueAtTime(value: number, time: number): this {
    return this.record('linear', value, time);
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    // Mirrors the real API, which throws on a target of zero or less.
    if (value <= 0) throw new Error('exponentialRampToValueAtTime: target must be > 0');
    return this.record('exponential', value, time);
  }

  setTargetAtTime(value: number, time: number, constant: number): this {
    if (!(constant > 0)) throw new Error('setTargetAtTime: time constant must be > 0');
    return this.record('target', value, time);
  }

  cancelScheduledValues(time: number): this {
    return this.record('cancel', this.value, time);
  }

  /** Last event of a given kind, for asserting on ramps. */
  last(type: ParamEvent['type']): ParamEvent | undefined {
    return [...this.events].reverse().find((event) => event.type === type);
  }
}

class FakeNode {
  readonly connections: FakeNode[] = [];

  connect(destination: FakeNode): FakeNode {
    this.connections.push(destination);
    return destination;
  }

  disconnect(): void {
    this.connections.length = 0;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}

class FakeBiquad extends FakeNode {
  type = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
  readonly detune = new FakeParam(0);
  readonly gain = new FakeParam(0);
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
  started: number | null = null;
  stopped: number | null = null;
  onended: (() => void) | null = null;

  constructor(private readonly ctx: FakeAudioContext) {
    super();
  }

  start(when = 0): void {
    if (this.started !== null) throw new Error('start() called twice');
    if (!Number.isFinite(when) || when < 0) throw new Error(`start(): bad time ${when}`);
    this.started = when;
  }

  stop(when?: number): void {
    if (this.started === null) throw new Error('stop() before start()');
    const at = when ?? this.ctx.currentTime;
    if (!Number.isFinite(at) || at < 0) throw new Error(`stop(): bad time ${at}`);
    // A later stop() (the teardown path) wins, exactly as it does in the real
    // API, where the most recent call replaces the pending one.
    this.stopped = at;
  }
}

class FakeAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly destination = new FakeNode();
  readonly created: FakeNode[] = [];
  readonly oscillators: FakeOscillator[] = [];
  resumeCalls = 0;
  /** Set to make node construction fail, as a closed context does. */
  broken = false;

  private track<T extends FakeNode>(node: T): T {
    if (this.broken) throw new Error('InvalidStateError: context is closed');
    this.created.push(node);
    return node;
  }

  createGain(): FakeGain {
    return this.track(new FakeGain());
  }

  createBiquadFilter(): FakeBiquad {
    return this.track(new FakeBiquad());
  }

  createOscillator(): FakeOscillator {
    const osc = this.track(new FakeOscillator(this));
    this.oscillators.push(osc);
    return osc;
  }

  async resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
  }

  /** Advances the audio clock and ends every voice whose stop time has passed. */
  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const osc of this.oscillators) {
      const ended = osc.onended;
      if (!ended || osc.stopped === null || osc.stopped > this.currentTime) continue;
      osc.onended = null;
      ended();
    }
  }

  /** The bus supplier the controller is constructed with. */
  bus(): { ctx: AudioContext; destination: AudioNode } {
    return {
      ctx: this as unknown as AudioContext,
      destination: this.destination as unknown as AudioNode,
    };
  }
}

/** The one gain wired straight to the destination: the music volume trim. */
function mixGain(ctx: FakeAudioContext): FakeGain {
  const found = ctx.created.find(
    (node): node is FakeGain => node instanceof FakeGain && node.connections.includes(ctx.destination),
  );
  if (!found) throw new Error('no music trim gain is connected to the destination');
  return found;
}

/** The per-scene cross-fade gains, oldest first. */
function layerGains(ctx: FakeAudioContext): FakeGain[] {
  const mix = mixGain(ctx);
  return ctx.created.filter((node): node is FakeGain => node instanceof FakeGain && node !== mix && node.connections.includes(mix));
}

function reachable(node: FakeNode): Set<FakeNode> {
  const seen = new Set<FakeNode>();
  const queue = [...node.connections];
  while (queue.length > 0) {
    const next = queue.pop();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    queue.push(...next.connections);
  }
  return seen;
}

/** Nodes still wired into something: the engine's live footprint. */
function liveNodes(ctx: FakeAudioContext): number {
  return ctx.created.filter((node) => node.connections.length > 0).length;
}

/**
 * Runs the engine for `seconds` of audio time, moving the audio clock and the
 * scheduler timer together in the 25 ms steps the real scheduler wakes on.
 */
function run(ctx: FakeAudioContext, seconds: number): void {
  const ticks = Math.round((seconds * 1000) / 25);
  for (let i = 0; i < ticks; i++) {
    ctx.advance(0.025);
    vi.advanceTimersByTime(25);
  }
}

/** The pitch of every note scheduled so far, in scheduling order. */
function melody(ctx: FakeAudioContext): number[] {
  return ctx.oscillators.map((osc) => osc.frequency.events[0]?.value ?? 0);
}

// ---------------------------------------------------------------------------
// Suite 2 — with a hand-written Web Audio implementation
// ---------------------------------------------------------------------------

describe('MusicController with a synthetic Web Audio implementation', () => {
  let ctx: FakeAudioContext;

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = new FakeAudioContext();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function controller(options?: Partial<{ enabled: boolean; volume: number }>): MusicController {
    return new MusicController(() => ctx.bus(), { enabled: true, volume: 1, ...options });
  }

  it('builds nothing until a scene is asked for', () => {
    const bus = vi.fn(() => ctx.bus());
    const music = new MusicController(bus, { enabled: true, volume: 1 });
    music.setVolume(0.5);
    music.setEnabled(false);
    music.setEnabled(true);
    music.suspend();
    music.resume();
    music.stop();
    expect(bus).not.toHaveBeenCalled();
    expect(ctx.created).toHaveLength(0);

    music.play('menu');
    expect(bus).toHaveBeenCalled();
    expect(ctx.created.length).toBeGreaterThan(0);
    music.dispose();
  });

  it('schedules real voices for every scene', () => {
    for (const scene of ALL_SCENES) {
      ctx = new FakeAudioContext();
      const music = controller();
      music.play(scene);

      expect(ctx.oscillators.length, `${scene} scheduled nothing`).toBeGreaterThan(0);
      for (const osc of ctx.oscillators) {
        expect(osc.started, `${scene} left a voice unstarted`).not.toBeNull();
        expect(osc.stopped, `${scene} left a voice unstopped`).not.toBeNull();
        expect((osc.stopped ?? 0) > (osc.started ?? 0), `${scene} has a zero-length voice`).toBe(true);
        // Every voice must reach the speakers through the trim gain.
        const downstream = reachable(osc);
        expect(downstream.has(mixGain(ctx))).toBe(true);
        expect(downstream.has(ctx.destination)).toBe(true);
      }
      music.dispose();
    }
  });

  it('gives every voice an envelope instead of a raw connection', () => {
    const music = controller();
    music.play('menu');
    for (const osc of ctx.oscillators) {
      const gain = osc.connections
        .flatMap((node) => (node instanceof FakeGain ? [node] : node.connections))
        .find((node): node is FakeGain => node instanceof FakeGain);
      expect(gain, 'a voice reached the bus without a gain envelope').toBeDefined();
      // Silence -> peak -> silence: no click at either end.
      expect(gain?.gain.events[0]?.type).toBe('set');
      expect(gain?.gain.last('exponential')?.value).toBeLessThan(0.01);
    }
    music.dispose();
  });

  it('opens victory with a flourish and holds a chord after it', () => {
    const music = controller();
    music.play('victory');
    const flourishVoices = ctx.oscillators.length;
    expect(flourishVoices).toBeGreaterThanOrEqual(6);

    run(ctx, 30);
    // The held chord keeps being renewed, so the scene never falls silent.
    expect(ctx.oscillators.length).toBeGreaterThan(flourishVoices);
    music.dispose();
  });

  it('keeps scheduling as the audio clock advances', () => {
    const music = controller();
    music.play('menu');
    const first = ctx.oscillators.length;

    run(ctx, 10);
    const second = ctx.oscillators.length;
    expect(second).toBeGreaterThan(first);

    run(ctx, 10);
    expect(ctx.oscillators.length).toBeGreaterThan(second);

    // Notes are always committed ahead of the clock, never behind it.
    for (const osc of ctx.oscillators) {
      expect(osc.started ?? -1).toBeGreaterThanOrEqual(0);
    }
    music.dispose();
  });

  it('schedules against the audio clock, not the timer', () => {
    const music = controller();
    music.play('menu');

    // Timers fire but the audio clock is frozen (a suspended context, or a
    // machine under load). Nothing may run away: the lookahead window is full
    // and stays full.
    const before = ctx.oscillators.length;
    vi.advanceTimersByTime(5000);
    expect(ctx.oscillators.length).toBe(before);

    run(ctx, 2);
    expect(ctx.oscillators.length).toBeGreaterThan(before);
    music.dispose();
  });

  it('keeps the node count bounded over a long session', () => {
    const music = controller();
    music.play('menu');

    let peak = 0;
    for (let i = 0; i < 24; i++) {
      run(ctx, 10);
      peak = Math.max(peak, liveNodes(ctx));
    }

    // Four minutes of music: hundreds of voices came and went...
    expect(ctx.created.length).toBeGreaterThan(400);
    // ...but only a handful are ever alive at once, and the ended ones are all
    // disconnected rather than accumulating.
    expect(peak).toBeLessThan(80);
    expect(liveNodes(ctx)).toBeLessThan(80);

    const finished = ctx.oscillators.filter((osc) => (osc.stopped ?? 0) <= ctx.currentTime);
    expect(finished.length).toBeGreaterThan(100);
    expect(finished.every((osc) => osc.connections.length === 0)).toBe(true);
    music.dispose();
  });

  it('cross-fades between scenes rather than cutting', () => {
    const music = controller();
    music.play('menu');
    run(ctx, 6);

    const [menuLayer] = layerGains(ctx);
    expect(menuLayer).toBeDefined();
    const stillRinging = ctx.oscillators.filter((osc) => (osc.stopped ?? 0) > ctx.currentTime).length;
    expect(stillRinging).toBeGreaterThan(0);

    const switchedAt = ctx.currentTime;
    music.play('match');

    const gains = layerGains(ctx);
    expect(gains).toHaveLength(2);
    const [outgoing, incoming] = gains;
    expect(outgoing).toBe(menuLayer);

    // The old scene ramps down and the new one ramps up over the same window.
    const down = outgoing.gain.last('exponential');
    const up = incoming.gain.last('exponential');
    expect(down?.value).toBeLessThan(0.01);
    expect(down?.time ?? 0).toBeGreaterThan(switchedAt);
    expect(up?.value).toBeGreaterThan(0.1);
    expect(up?.time ?? 0).toBeGreaterThan(switchedAt);

    // Nothing was cut: the outgoing scene is still connected and still ringing.
    expect(outgoing.connections.length).toBeGreaterThan(0);
    expect(ctx.oscillators.filter((osc) => (osc.stopped ?? 0) > ctx.currentTime).length).toBeGreaterThan(0);

    // Once the fade is over the old layer is freed and only one remains.
    run(ctx, 3);
    expect(outgoing.connections).toHaveLength(0);
    expect(layerGains(ctx)).toHaveLength(1);
    music.dispose();
  });

  it('treats a repeated play() of the same scene as a no-op', () => {
    const music = controller();
    music.play('menu');
    run(ctx, 4);
    const layer = layerGains(ctx)[0];
    const voices = ctx.oscillators.length;

    music.play('menu');
    music.play('menu');
    // No second layer, no restarted phrase, no extra scheduling.
    expect(layerGains(ctx)).toEqual([layer]);
    expect(ctx.oscillators.length).toBe(voices);
    expect(music.scene).toBe('menu');
    music.dispose();
  });

  it('produces the same note sequence from the same seed', () => {
    const first = new FakeAudioContext();
    const second = new FakeAudioContext();
    const a = new MusicController(() => first.bus(), { enabled: true, volume: 1 });
    const b = new MusicController(() => second.bus(), { enabled: true, volume: 1 });

    a.play('menu');
    b.play('menu');
    for (let i = 0; i < 800; i++) {
      first.advance(0.025);
      second.advance(0.025);
      vi.advanceTimersByTime(25);
    }

    const left = melody(first);
    expect(left.length).toBeGreaterThan(40);
    expect(left).toEqual(melody(second));
    // ...and it is a tune, not one note held over and over.
    expect(new Set(left).size).toBeGreaterThan(4);

    a.dispose();
    b.dispose();
  });

  it('varies the arpeggio instead of repeating a four-bar loop', () => {
    const music = controller();
    music.play('menu');
    run(ctx, 120);

    // The harmony is a four-chord loop, so pitches recur; the *sequence* must
    // not. Compare the first half of the phrase list with the second.
    const notes = melody(ctx);
    const half = Math.floor(notes.length / 2);
    expect(notes.slice(0, half)).not.toEqual(notes.slice(half, half * 2));
    music.dispose();
  });

  it('applies the volume trim and keeps the bed under the effects', () => {
    const music = controller({ volume: 1 });
    music.play('menu');
    const mix = mixGain(ctx);
    expect(mix.gain.value).toBeCloseTo(BED_PEAK, 5);

    music.setVolume(0.5);
    expect(music.volume).toBe(0.5);
    expect(mix.gain.last('target')?.value).toBeCloseTo(0.5 * BED_PEAK, 5);

    music.setVolume(4);
    expect(mix.gain.last('target')?.value).toBeCloseTo(BED_PEAK, 5);
    // The bed can never reach a level that would mask a cue.
    expect(mix.gain.value).toBeLessThanOrEqual(BED_PEAK);
    music.dispose();
  });

  it('stops scheduling at zero volume and starts again above it', () => {
    const music = controller({ volume: 0 });
    music.play('menu');
    expect(ctx.oscillators).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    music.setVolume(0.6);
    expect(ctx.oscillators.length).toBeGreaterThan(0);

    const voices = ctx.oscillators.length;
    music.setVolume(0);
    run(ctx, 3);
    expect(ctx.oscillators.length).toBe(voices);
    expect(music.scene).toBe('menu');
    music.dispose();
  });

  it('fades out and stops scheduling when the music is switched off', () => {
    const music = controller();
    music.play('menu');
    run(ctx, 5);
    const layer = layerGains(ctx)[0];
    const voices = ctx.oscillators.length;

    music.setEnabled(false);
    // A fade, not a cut.
    expect(layer.gain.last('exponential')?.value).toBeLessThan(0.01);

    run(ctx, 5);
    // Nothing new was scheduled and nothing is left running.
    expect(ctx.oscillators.length).toBe(voices);
    expect(ctx.oscillators.every((osc) => (osc.stopped ?? 0) <= ctx.currentTime)).toBe(true);
    // Only the idle trim gain survives, so unmuting does not rebuild the graph.
    expect(layerGains(ctx)).toHaveLength(0);
    expect(liveNodes(ctx)).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(music.scene).toBe('menu');

    // Switching it back on picks the scene up again.
    music.setEnabled(true);
    expect(ctx.oscillators.length).toBeGreaterThan(voices);
    music.dispose();
  });

  it('cancels the scheduler and frees every node on stop()', () => {
    const music = controller();
    music.play('menu');
    run(ctx, 8);
    expect(ctx.created.length).toBeGreaterThan(10);

    music.stop();
    expect(music.scene).toBeNull();
    // The lookahead timer goes immediately; only the fade teardown remains.
    expect(vi.getTimerCount()).toBe(1);

    const voices = ctx.oscillators.length;
    run(ctx, 3);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.oscillators.length).toBe(voices);
    expect(ctx.created.every((node) => node.connections.length === 0)).toBe(true);
    expect(ctx.destination.connections).toHaveLength(0);

    // And it can start again from nothing.
    music.play('menu');
    expect(ctx.oscillators.length).toBeGreaterThan(voices);
    music.dispose();
  });

  it('suspends and resumes without losing the scene or the phrase', () => {
    const music = controller();
    music.play('menu');
    run(ctx, 12);
    const voices = ctx.oscillators.length;

    music.suspend();
    music.suspend();
    expect(music.scene).toBe('menu');

    run(ctx, 6);
    expect(ctx.oscillators.length).toBe(voices);
    // A hidden tab holds no voices open, only the idle trim gain.
    expect(layerGains(ctx)).toHaveLength(0);
    expect(liveNodes(ctx)).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    music.resume();
    music.resume();
    expect(music.scene).toBe('menu');
    expect(ctx.oscillators.length).toBeGreaterThan(voices);

    // The phrase continues where it left off rather than restarting, so the
    // pad and the melody stay in step with each other.
    run(ctx, 6);
    expect(layerGains(ctx)).toHaveLength(1);
    music.dispose();
  });

  it('does not resume a scene that was stopped while suspended', () => {
    const music = controller();
    music.play('menu');
    run(ctx, 4);

    music.suspend();
    music.stop();
    run(ctx, 2);
    const voices = ctx.oscillators.length;

    music.resume();
    run(ctx, 2);
    expect(ctx.oscillators.length).toBe(voices);
    expect(music.scene).toBeNull();
    music.dispose();
  });

  it('frees everything and cancels every timer on dispose', () => {
    const music = controller();
    music.play('menu');
    run(ctx, 6);
    music.play('victory');

    music.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.created.every((node) => node.connections.length === 0)).toBe(true);
    expect(ctx.oscillators.every((osc) => osc.stopped !== null)).toBe(true);

    const voices = ctx.oscillators.length;
    music.play('menu');
    run(ctx, 5);
    expect(ctx.oscillators.length).toBe(voices);
    expect(vi.getTimerCount()).toBe(0);
    expect(music.scene).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — hostile and failing graphs
// ---------------------------------------------------------------------------

describe('MusicController against a failing audio graph', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules anyway when the context is parked by autoplay policy', () => {
    const ctx = new FakeAudioContext();
    ctx.state = 'suspended';
    const music = new MusicController(() => ctx.bus(), { enabled: true, volume: 1 });

    music.play('menu');
    expect(ctx.resumeCalls).toBe(1);
    // The clock is frozen, so exactly one lookahead window is committed and it
    // will be heard the moment the context starts running.
    expect(ctx.oscillators.length).toBeGreaterThan(0);
    music.dispose();
  });

  it('survives a context whose resume() rejects', async () => {
    const ctx = new FakeAudioContext();
    ctx.state = 'suspended';
    ctx.resume = (): Promise<void> => Promise.reject(new Error('NotAllowedError'));
    const music = new MusicController(() => ctx.bus(), { enabled: true, volume: 1 });

    expect(() => music.play('menu')).not.toThrow();
    // An unhandled rejection here would fail the run, so the catch matters.
    await Promise.resolve();
    expect(ctx.oscillators.length).toBeGreaterThan(0);
    music.dispose();
  });

  it('gives up quietly when node construction starts failing mid-session', () => {
    const ctx = new FakeAudioContext();
    const music = new MusicController(() => ctx.bus(), { enabled: true, volume: 1 });
    music.play('menu');
    run(ctx, 4);
    expect(ctx.oscillators.length).toBeGreaterThan(0);

    // The page navigated away and the shared context was closed under us.
    ctx.broken = true;
    expect(() => run(ctx, 8)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.created.every((node) => node.connections.length === 0)).toBe(true);

    ctx.broken = false;
    expect(() => music.play('match')).not.toThrow();
    music.dispose();
  });

  it('rebuilds when the bus hands back a different context', () => {
    const first = new FakeAudioContext();
    const second = new FakeAudioContext();
    let current = first;
    const music = new MusicController(() => current.bus(), { enabled: true, volume: 1 });

    music.play('menu');
    run(first, 4);
    expect(first.created.length).toBeGreaterThan(0);

    current = second;
    music.play('match');
    run(second, 4);
    expect(second.oscillators.length).toBeGreaterThan(0);
    // The trim gain on the dead context is dropped rather than left dangling.
    expect(first.destination.connections).toHaveLength(0);
    music.dispose();
  });

  it('never throws when the bus returns a malformed graph', () => {
    const music = new MusicController(
      () => ({ ctx: null as unknown as AudioContext, destination: null as unknown as AudioNode }),
      { enabled: true, volume: 1 },
    );
    for (const scene of ALL_SCENES) expect(() => music.play(scene)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    music.dispose();
  });
});
