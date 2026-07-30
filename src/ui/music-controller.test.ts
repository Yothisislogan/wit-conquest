/**
 * Unit tests for the procedural music engine.
 *
 * Four suites:
 *  1. No Web Audio at all — the environment vitest actually runs in. Every
 *     entry point must be a silent no-op, and nothing may be scheduled: a
 *     leaked interval in Node would keep the test process (and a server-side
 *     render) awake forever.
 *  2. A hand-written in-memory Web Audio implementation with a clock the test
 *     advances by hand. It cannot tell us whether the music sounds good, but it
 *     does pin down the things that make it *work*: lookahead scheduling
 *     against the audio clock, cross-fades instead of cuts, deterministic note
 *     choice, a bed that stays under the cues, and a graph that does not grow
 *     without bound. Several of those are questions about *level over time*
 *     rather than about which nodes exist, so the fake records automation
 *     events and `valueAt` replays them.
 *  3. The real SoundController underneath, because the two engines share a
 *     context and the settings panel exposes them as independent sliders.
 *  4. Hostile graphs — a bus supplier that throws, a context that refuses to
 *     resume, a node factory that fails mid-session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MUSIC_OPTIONS, MusicController, type MusicScene } from './music-controller.ts';
import { SoundController } from './sound-controller.ts';

const ALL_SCENES: MusicScene[] = ['menu', 'match', 'victory', 'defeat'];

/** Peak of the bed before the volume trim, mirroring `BED_PEAK` in the engine. */
const BED_PEAK = 0.08;
/**
 * Where the sound engine's shared compressor starts working (-18 dBFS). The bed
 * must stay under it even at maximum: above it the music drives the limiter
 * continuously and ducks every cue it is supposed to sit beneath.
 */
const LIMITER_THRESHOLD = 0.126;

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
  /**
   * Everything this node was ever wired to. `disconnect()` deliberately does
   * not clear it, so a voice that has already ended and been freed can still be
   * traced back to its envelope when measuring the mix after the fact.
   */
  readonly wiring: FakeNode[] = [];

  connect(destination: FakeNode): FakeNode {
    this.connections.push(destination);
    this.wiring.push(destination);
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

/** Only ever built by the *sound* engine; the music never asks for one. */
class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);
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

  createDynamicsCompressor(): FakeCompressor {
    return this.track(new FakeCompressor());
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

  async close(): Promise<void> {
    this.state = 'closed';
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
  return ctx.created.filter(
    (node): node is FakeGain => node instanceof FakeGain && node !== mix && node.connections.includes(mix),
  );
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

/**
 * Evaluates a recorded automation curve at `time`, the way Web Audio would.
 *
 * This is what makes it possible to test the *shape* of a fade rather than just
 * its endpoints — and the shape is the whole question, because an exponential
 * ramp and a linear one to the same target sound nothing alike in between.
 */
function valueAt(param: FakeParam, time: number): number {
  const events = param.events;
  if (events.length === 0) return param.value;
  if (time <= events[0].time) return events[0].value;

  let current = events[0].value;
  let anchor = events[0].time;
  for (let i = 1; i < events.length; i++) {
    const event = events[i];
    if (event.time <= time) {
      current = event.value;
      anchor = event.time;
      continue;
    }
    const span = event.time - anchor;
    const progress = span > 0 ? (time - anchor) / span : 1;
    if (event.type === 'linear') return current + (event.value - current) * progress;
    if (event.type === 'exponential' && current > 0 && event.value > 0) {
      return current * Math.pow(event.value / current, progress);
    }
    // A `set` or a `cancel` ahead of us holds whatever we are already at.
    return current;
  }
  return current;
}

/** The gain carrying a voice's envelope, reachable even after it was freed. */
function envelopeOf(osc: FakeOscillator): FakeGain | null {
  for (const first of osc.wiring) {
    if (first instanceof FakeGain) return first;
    const next = first.wiring.find((node): node is FakeGain => node instanceof FakeGain);
    if (next) return next;
  }
  return null;
}

interface BedSample {
  /** Pad voices: the ones routed through the layer's sweeping low-pass. */
  readonly pad: number;
  /** The root under the chord, which is everything else below the melody. */
  readonly bass: number;
  readonly total: number;
}

/**
 * Sums every voice envelope alive at `at`, through its layer gain and the trim:
 * the amplitude the shared bus actually sees, which is the number `BED_PEAK` is
 * supposed to budget. Assumes a single active layer.
 */
function bedAt(ctx: FakeAudioContext, at: number): BedSample {
  const trim = valueAt(mixGain(ctx).gain, at);
  const layer = layerGains(ctx)[0];
  const level = layer ? valueAt(layer.gain, at) : 0;

  let pad = 0;
  let bass = 0;
  let total = 0;
  for (const osc of ctx.oscillators) {
    if (osc.started === null || at < osc.started || at > (osc.stopped ?? 0)) continue;
    const envelope = envelopeOf(osc);
    if (!envelope) continue;
    const amplitude = valueAt(envelope.gain, at) * level * trim;
    total += amplitude;
    if (envelope.wiring.some((node) => node instanceof FakeBiquad)) {
      // Routed through the layer's sweeping low-pass: a pad voice.
      pad += amplitude;
    } else {
      // The root is the only voice with a low-pass under 1 kHz in front of it;
      // the arpeggio opens at 3.2 kHz. Pitch alone will not do it, because the
      // C chord's bass octave lands higher than the arpeggio's lowest note.
      const head = osc.wiring[0];
      if (head instanceof FakeBiquad && (head.frequency.events[0]?.value ?? 0) <= 1000) bass += amplitude;
    }
  }
  return { pad, bass, total };
}

/** The layer's shared low-pass: the one biquad wired into a cross-fade gain. */
function padFilter(ctx: FakeAudioContext): FakeBiquad | undefined {
  const layers = layerGains(ctx);
  return ctx.created.find(
    (node): node is FakeBiquad =>
      node instanceof FakeBiquad && layers.some((gain) => node.connections.includes(gain)),
  );
}

/** Samples `bedAt` across a window, every 50 ms. */
function bedOver(ctx: FakeAudioContext, from: number, to: number): BedSample[] {
  const samples: BedSample[] = [];
  for (let at = from; at <= to; at += 0.05) samples.push(bedAt(ctx, at));
  return samples;
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
      // Silence -> peak -> silence: no click at either end, and the decay ends
      // at a true zero rather than trailing off towards one.
      expect(gain?.gain.events[0]?.type).toBe('set');
      expect(gain?.gain.events[0]?.value).toBe(0);
      const close = gain?.gain.events.at(-1);
      expect(close?.type).toBe('linear');
      expect(close?.value).toBe(0);
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
    const down = outgoing.gain.last('linear');
    const up = incoming.gain.last('linear');
    expect(down?.value).toBe(0);
    expect(down?.time ?? 0).toBeGreaterThan(switchedAt);
    expect(up?.value).toBeGreaterThan(0.1);
    expect(up?.time ?? 0).toBeGreaterThan(switchedAt);

    // And they sum to a steady bed the whole way across, which is the part that
    // makes it a cross-fade at all. Exponential ramps to silence on both sides
    // would satisfy every assertion above and still drop to -34 dB at the
    // midpoint, because an exponential ramp is linear in dB: a hole, not a fade.
    const floor = Math.min(valueAt(outgoing.gain, switchedAt), up?.value ?? 0) * 0.9;
    expect(floor).toBeGreaterThan(0);
    for (let at = switchedAt + 0.05; at <= switchedAt + 1.2; at += 0.05) {
      const sum = valueAt(outgoing.gain, at) + valueAt(incoming.gain, at);
      expect(sum, `bed collapsed to ${sum.toFixed(4)} at +${(at - switchedAt).toFixed(2)}s`).toBeGreaterThan(
        floor,
      );
    }

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

  it('keeps the whole bed under the shared limiter at maximum volume', () => {
    for (const scene of ALL_SCENES) {
      ctx = new FakeAudioContext();
      const music = controller({ volume: 1 });
      music.play(scene);
      run(ctx, 30);

      // Every voice alive at once, through its layer and the trim — not the
      // trim on its own, which says nothing about how many voices stack on it.
      const peak = Math.max(...bedOver(ctx, 1, 28).map((sample) => sample.total));
      expect(peak, `${scene} measured nothing`).toBeGreaterThan(0.02);
      expect(peak, `${scene} bed peaks at ${peak.toFixed(4)}`).toBeLessThan(LIMITER_THRESHOLD);
      music.dispose();
    }
  });

  it('holds the pad and the bass through a chord change instead of pumping', () => {
    for (const [scene, span] of [
      ['menu', (30 / 76) * 16],
      ['match', (30 / 62) * 16],
    ] as const) {
      ctx = new FakeAudioContext();
      const music = controller({ volume: 1 });
      music.play(scene);
      run(ctx, span * 5);

      // From halfway through the second chord to halfway through the fifth:
      // three changes, with the bed fully established either side of each.
      const samples = bedOver(ctx, span * 1.5, span * 4.5);
      const swing = (values: number[]): number => Math.min(...values) / Math.max(...values);
      const pad = swing(samples.map((sample) => sample.pad));
      const bass = swing(samples.map((sample) => sample.bass));

      // The chord is supposed to hand over, not hand back: before the fix both
      // voices began decaying while the old chord was still the only thing
      // playing, so the pad dropped 19 dB and the bass 40 dB once a chord.
      expect(pad, `${scene} pad swings to ${pad.toFixed(3)} of its steady level`).toBeGreaterThan(0.6);
      expect(bass, `${scene} bass swings to ${bass.toFixed(3)} of its steady level`).toBeGreaterThan(0.6);
      music.dispose();
    }
  });

  it('is at full level before the first flourish note peaks', () => {
    for (const scene of ['victory', 'defeat'] as MusicScene[]) {
      ctx = new FakeAudioContext();
      const music = controller();
      music.play(scene);

      const layer = layerGains(ctx)[0];
      const start = layer.gain.events[0]?.time ?? 0;
      const target = layer.gain.events[1]?.value ?? 0;
      // The flourish is scheduled on the layer's very first step and its opening
      // note reaches its peak 12 ms later, so any real fade-in eats the one
      // transient the whole transition is built around: at 0.25 s, victory's F4
      // arrived 27 dB down and the arpeggio was heard from its third note.
      const reached = valueAt(layer.gain, start + 0.012);
      expect(reached, `${scene} swallowed its opening note`).toBeGreaterThan(target * 0.99);
      music.dispose();
    }
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
    // A fade, not a cut — and one that reaches silence rather than approaching
    // it asymptotically for the whole of its length.
    const fade = layer.gain.last('linear');
    expect(fade?.value).toBe(0);
    expect(fade?.time ?? 0).toBeGreaterThan(ctx.currentTime);

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

  it('brings the bed back at once whatever phase of a chord a resume lands in', () => {
    const step = 30 / 62; // match: an eighth note at 62 BPM
    const stepsPerChord = 16;

    for (let phase = 0; phase < stepsPerChord; phase++) {
      ctx = new FakeAudioContext();
      const music = controller();
      music.play('match');
      // Hide the tab `phase` steps into a chord. Only one of the sixteen is a
      // chord boundary; the pad, bass and filter sweep used to wait for the
      // next one, which in 'match' is up to 7.3 s of arpeggio — over bars that
      // are 70% rests, so mostly of nothing at all.
      run(ctx, phase * step + 0.05);
      music.suspend();
      run(ctx, 2);

      const resumedAt = ctx.currentTime;
      music.resume();
      run(ctx, 1);

      const bed = bedAt(ctx, resumedAt + 0.6);
      expect(bed.pad, `phase ${phase} came back without a pad`).toBeGreaterThan(0);
      expect(bed.bass, `phase ${phase} came back without a bass`).toBeGreaterThan(0);
      music.dispose();
    }
  });

  it('re-establishes the bed when a throttled tab catches up', () => {
    const music = controller();
    music.play('menu');
    run(ctx, 20);

    // No visibility change, just a background tab: the audio clock ran on for a
    // minute while the 25 ms timer fired perhaps once.
    ctx.advance(60);
    const caughtUpAt = ctx.currentTime;
    vi.advanceTimersByTime(25);

    const fresh = ctx.oscillators.filter((osc) => (osc.started ?? 0) >= caughtUpAt);
    // The backlog is dropped rather than dumped into the graph...
    expect(fresh.length).toBeLessThan(20);
    // ...but the bed picks up from here instead of leaving a hole until the
    // next chord boundary, which for menu is up to 5.9 s away.
    const bed = bedAt(ctx, caughtUpAt + 0.8);
    expect(bed.pad).toBeGreaterThan(0);
    expect(bed.bass).toBeGreaterThan(0);

    // And the layer's low-pass sweeps again rather than sitting parked at its
    // floor for the rest of the chord.
    const filter = padFilter(ctx);
    expect(filter?.frequency.last('linear')?.time ?? 0).toBeGreaterThan(caughtUpAt);
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
// Suite 3 — wired to the sound engine it actually ships with
//
// Music volume and effects volume are two separate, unqualified sliders in the
// settings panel. Nothing the player does to one may move the other.
// ---------------------------------------------------------------------------

describe('MusicController on the real sound engine', () => {
  const scope = globalThis as unknown as { AudioContext?: unknown };

  beforeEach(() => {
    vi.useFakeTimers();
    scope.AudioContext = FakeAudioContext;
  });

  afterEach(() => {
    delete scope.AudioContext;
    vi.useRealTimers();
  });

  /** The engine's effects trim: the first gain it wires to the speakers. */
  function effectsTrim(ctx: FakeAudioContext): FakeGain {
    const found = ctx.created.find(
      (node): node is FakeGain => node instanceof FakeGain && node.connections.includes(ctx.destination),
    );
    if (!found) throw new Error('no effects trim is connected to the destination');
    return found;
  }

  function playing(): { sound: SoundController; music: MusicController; ctx: FakeAudioContext } {
    const sound = new SoundController({ enabled: true, volume: 1 });
    const music = new MusicController(() => sound.bus(), { enabled: true, volume: 1 });
    music.play('menu');
    const bus = sound.bus();
    if (!bus) throw new Error('the sound engine handed back no bus');
    return { sound, music, ctx: bus.ctx as unknown as FakeAudioContext };
  }

  it('keeps the bed audible when the effects volume is dragged to zero', () => {
    const { sound, music, ctx } = playing();
    const trim = effectsTrim(ctx);
    const voices = ctx.oscillators.length;
    expect(voices).toBeGreaterThan(0);

    sound.setVolume(0);

    // The cue path really is muted...
    expect(sound.volume).toBe(0);
    expect(trim.gain.value).toBe(0);
    // ...and the music, which the player never touched, is untouched: it does
    // not pass through that trim at all.
    expect(music.volume).toBe(1);
    expect(music.scene).toBe('menu');
    for (const osc of ctx.oscillators) {
      const downstream = reachable(osc);
      expect(downstream.has(ctx.destination), 'the bed lost its way to the speakers').toBe(true);
      expect(downstream.has(trim), 'the bed is scaled by the effects slider').toBe(false);
    }

    // And it is still worth synthesising: the scheduler keeps running because
    // there is something to hear, not in spite of there being nothing.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    run(ctx, 2);
    expect(ctx.oscillators.length).toBeGreaterThan(voices);

    music.dispose();
    sound.dispose();
  });

  it('leaves the bed alone when the cues are switched off', () => {
    const { sound, music, ctx } = playing();
    const voices = ctx.oscillators.length;

    sound.setEnabled(false);
    // "Sound off" cuts cue tails and has never touched the music. The volume
    // slider must behave the same way round, which is the asymmetry that gave
    // the coupling away.
    expect(ctx.oscillators.every((osc) => (osc.stopped ?? 0) > ctx.currentTime)).toBe(true);
    run(ctx, 2);
    expect(ctx.oscillators.length).toBeGreaterThan(voices);
    expect(music.scene).toBe('menu');

    music.dispose();
    sound.dispose();
  });

  it('unhooks the bed when the sound engine is disposed', () => {
    const { sound, music, ctx } = playing();

    sound.dispose();
    music.dispose();
    expect(ctx.created.every((node) => node.connections.length === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — hostile and failing graphs
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
