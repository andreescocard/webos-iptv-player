// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMonoAudio, resetMonoAudioForTests } from './mono-audio';

class FakeNode {
  connections: FakeNode[] = [];
  channelCount = 2;
  channelCountMode = 'max';
  channelInterpretation = 'speakers';
  connect(n: FakeNode): void { this.connections.push(n); }
  disconnect(): void { this.connections = []; }
}

let contexts: FakeContext[] = [];
let sources: FakeNode[] = [];
let failWith: Error | null = null;

class FakeContext {
  state = 'suspended';
  destination = new FakeNode();
  gains: FakeNode[] = [];
  resume = vi.fn(() => Promise.resolve());
  constructor() { contexts.push(this); }
  createMediaElementSource(): FakeNode {
    if (failWith) throw failWith;
    const n = new FakeNode();
    sources.push(n);
    return n;
  }
  createGain(): FakeNode {
    const n = new FakeNode();
    this.gains.push(n);
    return n;
  }
}

const video = (): HTMLVideoElement => document.createElement('video');

describe('mono audio', () => {
  beforeEach(() => {
    contexts = [];
    sources = [];
    failWith = null;
    resetMonoAudioForTests();
    (window as unknown as { AudioContext?: unknown }).AudioContext = FakeContext;
  });
  afterEach(() => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    vi.restoreAllMocks();
  });

  it('never creates a context while off', () => {
    applyMonoAudio(video(), false);
    expect(contexts).toHaveLength(0);
  });

  it('routes the source through a one-channel gain when enabled', () => {
    applyMonoAudio(video(), true);
    const ctx = contexts[0]!;
    const gain = ctx.gains[0]!;
    expect(gain.channelCount).toBe(1);
    expect(gain.channelCountMode).toBe('explicit');
    expect(sources[0]!.connections).toEqual([gain]);
    expect(gain.connections).toEqual([ctx.destination]);
    expect(ctx.resume).toHaveBeenCalled();
  });

  it('restores stereo passthrough when disabled', () => {
    const v = video();
    applyMonoAudio(v, true);
    applyMonoAudio(v, false);
    expect(sources[0]!.connections).toEqual([contexts[0]!.destination]);
  });

  it('keeps one source per element and one context', () => {
    const v = video();
    applyMonoAudio(v, true);
    applyMonoAudio(v, false);
    applyMonoAudio(v, true);
    expect(sources).toHaveLength(1);
    expect(contexts).toHaveLength(1);
  });

  it('wires a recreated element', () => {
    applyMonoAudio(video(), true);
    applyMonoAudio(video(), true);
    expect(sources).toHaveLength(2);
    expect(contexts).toHaveLength(1);
  });

  it('re-applies to the current element when called without one', () => {
    const v = video();
    applyMonoAudio(v, true);
    applyMonoAudio(null, false);
    expect(sources[0]!.connections).toEqual([contexts[0]!.destination]);
  });

  it('resumes a suspended context on play', () => {
    const v = video();
    applyMonoAudio(v, true);
    contexts[0]!.resume.mockClear();
    v.dispatchEvent(new Event('play'));
    expect(contexts[0]!.resume).toHaveBeenCalled();
  });

  it('is a no-op without AudioContext', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    expect(() => applyMonoAudio(video(), true)).not.toThrow();
    expect(contexts).toHaveLength(0);
  });

  it('logs the diag event once when Web Audio fails', () => {
    const warn = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(warn);
    failWith = Object.assign(new Error('boom'), { name: 'InvalidStateError' });
    applyMonoAudio(video(), true);
    applyMonoAudio(video(), true);
    const lines = warn.mock.calls.map(c => c.join(' '));
    const hits = lines.filter(l => l.includes('event=audio.mono_unavailable reason=InvalidStateError'));
    expect(hits).toHaveLength(1);
  });
});
