/**
 * Unit tests for the procedural sound engine.
 *
 * Two suites:
 *  1. No Web Audio at all (the environment vitest actually runs in). Every
 *     entry point must be a silent no-op — the engine is imported by UI code
 *     that also runs in Node during tests and must never crash it.
 *  2. A synthetic in-memory Web Audio implementation. It is not a browser, but
 *     it does verify the graph is wired the way the design requires, that the
 *     rate limiter drops cascade spam, and that no cue schedules an illegal
 *     ramp (exponential ramps to zero are a classic Web Audio crash).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SOUND_OPTIONS, SoundController, type SoundName } from './sound-controller.ts';

const ALL_SOUNDS: SoundName[] = [
  'select',
  'deselect',
  'clone',
  'jump',
  'convert',
  'turn-change',
  'win',
  'lose',
  'tie',
  'invalid',
  'ui-tap',
];

const scope = globalThis as unknown as {
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
};

function removeWebAudio(): void {
  delete scope.AudioContext;
  delete scope.webkitAudioContext;
}

// ---------------------------------------------------------------------------
// Suite 1 — no Web Audio available
// ---------------------------------------------------------------------------

describe('SoundController without Web Audio', () => {
  beforeEach(removeWebAudio);

  it('constructs without touching audio APIs', () => {
    expect(() => new SoundController()).not.toThrow();
    expect(() => new SoundController({ enabled: true, volume: 1 })).not.toThrow();
  });

  it('takes enabled from the constructor option', () => {
    expect(new SoundController({ enabled: true }).enabled).toBe(true);
    expect(new SoundController({ enabled: false }).enabled).toBe(false);
    expect(new SoundController().enabled).toBe(DEFAULT_SOUND_OPTIONS.enabled);
    expect(new SoundController({ volume: 0.2 }).enabled).toBe(DEFAULT_SOUND_OPTIONS.enabled);
  });

  it('toggles enabled without throwing', () => {
    const sound = new SoundController({ enabled: false });
    sound.setEnabled(true);
    expect(sound.enabled).toBe(true);
    sound.setEnabled(true);
    expect(sound.enabled).toBe(true);
    sound.setEnabled(false);
    expect(sound.enabled).toBe(false);
  });

  it('clamps volume to 0..1', () => {
    const sound = new SoundController({ volume: 0.5 });
    expect(sound.volume).toBe(0.5);

    sound.setVolume(-3);
    expect(sound.volume).toBe(0);

    sound.setVolume(42);
    expect(sound.volume).toBe(1);

    sound.setVolume(0.25);
    expect(sound.volume).toBe(0.25);

    sound.setVolume(0);
    expect(sound.volume).toBe(0);

    sound.setVolume(1);
    expect(sound.volume).toBe(1);
  });

  it('clamps the constructor volume and ignores unusable numbers', () => {
    expect(new SoundController({ volume: -1 }).volume).toBe(0);
    expect(new SoundController({ volume: 9 }).volume).toBe(1);
    expect(new SoundController({ volume: Number.NaN }).volume).toBe(DEFAULT_SOUND_OPTIONS.volume);
    expect(new SoundController().volume).toBe(DEFAULT_SOUND_OPTIONS.volume);
  });

  it('ignores non-finite volumes rather than muting', () => {
    const sound = new SoundController({ volume: 0.4 });
    sound.setVolume(Number.NaN);
    expect(sound.volume).toBe(0.4);
    sound.setVolume(Number.POSITIVE_INFINITY);
    expect(sound.volume).toBe(0.4);
  });

  it('plays every cue as a no-op', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    for (const name of ALL_SOUNDS) {
      expect(() => sound.play(name)).not.toThrow();
      expect(() => sound.play(name, { intensity: 1.5 })).not.toThrow();
    }
  });

  it('survives hostile intensities', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    for (const intensity of [0, -10, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      expect(() => sound.play('convert', { intensity })).not.toThrow();
    }
  });

  it('handles any conversion count', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    for (const count of [0, 1, 2, 6, 12, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sound.playConversion(count)).not.toThrow();
    }
  });

  it('resolves unlock() instead of rejecting', async () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    await expect(sound.unlock()).resolves.toBeUndefined();
    await expect(sound.unlock()).resolves.toBeUndefined();
  });

  it('disposes safely and stays inert afterwards', async () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    sound.play('win');
    expect(() => sound.dispose()).not.toThrow();
    expect(() => sound.dispose()).not.toThrow();
    expect(() => sound.play('select')).not.toThrow();
    expect(() => sound.playConversion(3)).not.toThrow();
    expect(() => sound.setVolume(0.3)).not.toThrow();
    expect(() => sound.setEnabled(false)).not.toThrow();
    await expect(sound.unlock()).resolves.toBeUndefined();
  });

  it('stays silent when a rapid cascade is fired', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    expect(() => {
      for (let i = 0; i < 200; i++) sound.playConversion((i % 7) + 1);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// A synthetic Web Audio implementation
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

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);
}

class FakeSource extends FakeNode {
  started: number | null = null;
  stopped: number | null = null;
  onended: (() => void) | null = null;

  start(when = 0): void {
    if (this.started !== null) throw new Error('start() called twice');
    if (!Number.isFinite(when) || when < 0) throw new Error(`start(): bad time ${when}`);
    this.started = when;
  }

  stop(when = 0): void {
    if (this.started === null) throw new Error('stop() before start()');
    if (!Number.isFinite(when) || when < 0) throw new Error(`stop(): bad time ${when}`);
    this.stopped = when;
  }
}

class FakeOscillator extends FakeSource {
  type = 'sine';
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
}

class FakeBuffer {
  private readonly channel: Float32Array;

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channel = new Float32Array(length);
  }

  getChannelData(): Float32Array {
    return this.channel;
  }
}

class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: 'suspended' | 'running' | 'closed' = 'running';
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly destination = new FakeNode();
  readonly created: FakeNode[] = [];
  readonly sources: FakeSource[] = [];
  resumeCalls = 0;
  closeCalls = 0;

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  private track<T extends FakeNode>(node: T): T {
    this.created.push(node);
    if (node instanceof FakeSource) this.sources.push(node);
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
    return this.track(new FakeOscillator());
  }

  createBufferSource(): FakeBufferSource {
    return this.track(new FakeBufferSource());
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }

  async resume(): Promise<void> {
    this.resumeCalls++;
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.state = 'closed';
  }

  /** Fires `onended` for every started source, as the real clock eventually does. */
  finishAll(): void {
    for (const source of this.sources) {
      const ended = source.onended;
      if (source.started === null || !ended) continue;
      source.onended = null;
      ended();
    }
  }
}

function installFakeAudio(): void {
  FakeAudioContext.instances = [];
  scope.AudioContext = FakeAudioContext;
}

function latestContext(): FakeAudioContext {
  const ctx = FakeAudioContext.instances.at(-1);
  if (!ctx) throw new Error('no AudioContext was created');
  return ctx;
}

/** The one gain node wired straight to the destination: the volume trim. */
function masterGain(ctx: FakeAudioContext): FakeGain {
  const master = ctx.created.find(
    (node): node is FakeGain => node instanceof FakeGain && node.connections.includes(ctx.destination),
  );
  if (!master) throw new Error('no master gain is connected to the destination');
  return master;
}

function compressorOf(ctx: FakeAudioContext): FakeCompressor {
  const compressor = ctx.created.find((node): node is FakeCompressor => node instanceof FakeCompressor);
  if (!compressor) throw new Error('no compressor was inserted on the master bus');
  return compressor;
}

/** Every node reachable downstream of `node`. */
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

// ---------------------------------------------------------------------------
// Suite 2 — with a synthetic Web Audio implementation
// ---------------------------------------------------------------------------

describe('SoundController with a synthetic Web Audio implementation', () => {
  beforeEach(installFakeAudio);
  afterEach(removeWebAudio);

  it('does not create an AudioContext until a cue or unlock happens', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    sound.setVolume(0.5);
    sound.setEnabled(false);
    sound.setEnabled(true);
    expect(FakeAudioContext.instances).toHaveLength(0);

    sound.play('select');
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('creates the context from unlock() and resumes it', async () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    await sound.unlock();
    const ctx = latestContext();
    expect(FakeAudioContext.instances).toHaveLength(1);

    ctx.state = 'suspended';
    await sound.unlock();
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe('running');
  });

  it('schedules a bounded, well-formed cue for every sound', () => {
    for (const name of ALL_SOUNDS) {
      installFakeAudio();
      const sound = new SoundController({ enabled: true, volume: 1 });
      sound.play(name);
      const ctx = latestContext();

      expect(ctx.sources.length, `${name} scheduled nothing`).toBeGreaterThan(0);
      const starts = ctx.sources.map((s) => s.started ?? Number.NaN);
      const stops = ctx.sources.map((s) => s.stopped ?? Number.NaN);
      expect(starts.every(Number.isFinite), `${name} left a source unstarted`).toBe(true);
      expect(stops.every(Number.isFinite), `${name} left a source unstopped`).toBe(true);
      for (const source of ctx.sources) {
        expect((source.stopped ?? 0) > (source.started ?? 0), `${name} has a zero-length voice`).toBe(true);
      }
      const span = Math.max(...stops) - Math.min(...starts);
      expect(span, `${name} runs for ${span}s`).toBeLessThanOrEqual(0.9);
      sound.dispose();
    }
  });

  it('routes every voice through a compressor and the master gain to the destination', () => {
    const sound = new SoundController({ enabled: true, volume: 0.6 });
    sound.play('jump');
    const ctx = latestContext();

    const master = masterGain(ctx);
    expect(master.gain.value).toBeCloseTo(0.6, 5);

    const compressor = compressorOf(ctx);
    expect(compressor.connections).toContain(master);

    for (const source of ctx.sources) {
      const downstream = reachable(source);
      expect(downstream.has(compressor)).toBe(true);
      expect(downstream.has(master)).toBe(true);
      expect(downstream.has(ctx.destination)).toBe(true);
    }
  });

  it('applies volume changes to the master gain', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    sound.play('ui-tap');
    const ctx = latestContext();
    const master = masterGain(ctx);

    sound.setVolume(0.25);
    expect(sound.volume).toBe(0.25);
    expect(master.gain.value).toBeCloseTo(0.25, 5);

    sound.setVolume(5);
    expect(master.gain.value).toBeCloseTo(1, 5);
  });

  it('stays silent when disabled or at zero volume', () => {
    const muted = new SoundController({ enabled: false, volume: 1 });
    for (const name of ALL_SOUNDS) muted.play(name);
    muted.playConversion(4);
    expect(FakeAudioContext.instances).toHaveLength(0);

    const silent = new SoundController({ enabled: true, volume: 0 });
    silent.play('win');
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('drops a cue while the context is suspended and asks for a resume', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    // Prime the context, then park it as an autoplay-blocked browser would.
    sound.play('select');
    const ctx = latestContext();
    const before = ctx.sources.length;
    ctx.state = 'suspended';

    sound.play('win');
    expect(ctx.sources.length).toBe(before);
    expect(ctx.resumeCalls).toBe(1);
  });

  it('rate-limits a repeated cue inside the window', () => {
    const sourcesAfter = (calls: number): number => {
      installFakeAudio();
      const sound = new SoundController({ enabled: true, volume: 1 });
      for (let i = 0; i < calls; i++) sound.play('convert');
      return latestContext().sources.length;
    };

    const three = sourcesAfter(3);
    const six = sourcesAfter(6);
    const many = sourcesAfter(60);

    expect(three).toBeGreaterThan(0);
    expect(six).toBeGreaterThan(three);
    // Everything past the limit inside the window is dropped, so a 60-cue
    // cascade costs exactly as much as a 6-cue one.
    expect(many).toBe(six);
  });

  it('allows the cue again once the window has passed', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    for (let i = 0; i < 20; i++) sound.play('select');
    const ctx = latestContext();
    const throttled = ctx.sources.length;

    ctx.currentTime += 0.25;
    sound.play('select');
    expect(ctx.sources.length).toBeGreaterThan(throttled);
  });

  it('rate-limits per cue, not globally', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    for (let i = 0; i < 20; i++) sound.play('select');
    const ctx = latestContext();
    const afterSelect = ctx.sources.length;

    sound.play('turn-change');
    expect(ctx.sources.length).toBeGreaterThan(afterSelect);
  });

  it('scales the conversion cue with the number of pieces flipped', () => {
    const voicesFor = (count: number): number => {
      installFakeAudio();
      const sound = new SoundController({ enabled: true, volume: 1 });
      sound.playConversion(count);
      return latestContext().sources.length;
    };

    const one = voicesFor(1);
    const three = voicesFor(3);
    const six = voicesFor(6);

    expect(one).toBeGreaterThan(0);
    expect(three).toBeGreaterThan(one);
    expect(six).toBeGreaterThan(three);
    // Anything past six is clamped, so a runaway cascade cannot grow forever.
    expect(voicesFor(50)).toBe(six);
  });

  it('frees each voice once it has ended', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    sound.play('win');
    const ctx = latestContext();
    expect(ctx.sources.every((source) => source.connections.length > 0)).toBe(true);

    ctx.finishAll();
    expect(ctx.sources.every((source) => source.connections.length === 0)).toBe(true);

    // Ending a voice must not tear down the shared bus.
    expect(() => masterGain(ctx)).not.toThrow();
    expect(compressorOf(ctx).connections).toContain(masterGain(ctx));
  });

  it('cuts running voices when sound is switched off', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    sound.play('lose');
    const ctx = latestContext();

    sound.setEnabled(false);
    expect(ctx.sources.every((source) => source.stopped !== null)).toBe(true);
    expect(ctx.sources.every((source) => source.connections.length === 0)).toBe(true);

    const before = ctx.sources.length;
    sound.play('win');
    expect(ctx.sources.length).toBe(before);
  });

  it('closes the context on dispose and ignores later calls', () => {
    const sound = new SoundController({ enabled: true, volume: 1 });
    sound.play('clone');
    const ctx = latestContext();

    sound.dispose();
    expect(ctx.closeCalls).toBe(1);
    expect(ctx.state).toBe('closed');
    expect(ctx.destination.connections).toHaveLength(0);

    const before = FakeAudioContext.instances.length;
    sound.play('clone');
    sound.playConversion(5);
    expect(FakeAudioContext.instances).toHaveLength(before);
    expect(ctx.closeCalls).toBe(1);

    sound.dispose();
    expect(ctx.closeCalls).toBe(1);
  });

  it('gives up quietly when the AudioContext constructor throws', () => {
    let attempts = 0;
    scope.AudioContext = class {
      constructor() {
        attempts++;
        throw new Error('audio hardware unavailable');
      }
    };

    const sound = new SoundController({ enabled: true, volume: 1 });
    expect(() => sound.play('select')).not.toThrow();
    const afterFirst = attempts;
    expect(afterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 10; i++) sound.play('select');
    // The failure is latched: we do not re-enter a broken constructor per cue.
    expect(attempts).toBe(afterFirst);
    expect(() => sound.dispose()).not.toThrow();
  });

  it('falls back to a prefixed webkitAudioContext', () => {
    delete scope.AudioContext;
    scope.webkitAudioContext = FakeAudioContext;

    const sound = new SoundController({ enabled: true, volume: 1 });
    sound.play('select');
    expect(FakeAudioContext.instances).toHaveLength(1);
    sound.dispose();
  });
});
