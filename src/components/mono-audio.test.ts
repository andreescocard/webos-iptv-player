// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMonoAudio, getMonoAudioStatus, playMonoTest, resetMonoAudioForTests } from './mono-audio';

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
let oscillators: FakeOsc[] = [];
let mergers: FakeNode[] = [];

class FakeParam {
  value = 0;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}

class FakeOsc extends FakeNode {
  frequency = new FakeParam();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
  inputs: [FakeNode, number][] = [];
  override connect(n: FakeNode, _out?: number, input?: number): void {
    super.connect(n);
    if (input !== undefined) (n as FakeGain).inputs.push([this, input]);
  }
}

class FakeContext {
  state = 'suspended';
  destination = new FakeNode();
  gains: FakeGain[] = [];
  currentTime = 0;
  resume = vi.fn(() => Promise.resolve());
  constructor() { contexts.push(this); }
  createMediaElementSource(): FakeNode {
    if (failWith) throw failWith;
    const n = new FakeNode();
    sources.push(n);
    return n;
  }
  createOscillator(): FakeOsc {
    const o = new FakeOsc();
    oscillators.push(o);
    return o;
  }
  createChannelMerger(): FakeGain {
    const m = new FakeGain();
    mergers.push(m);
    return m;
  }
  createGain(): FakeGain {
    const n = new FakeGain();
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
    oscillators = [];
    mergers = [];
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

  describe('getMonoAudioStatus', () => {
    it('reports off, active, then off again', () => {
      const v = video();
      expect(getMonoAudioStatus()).toBe('off');
      applyMonoAudio(v, true);
      expect(getMonoAudioStatus()).toBe('active');
      applyMonoAudio(v, false);
      expect(getMonoAudioStatus()).toBe('off');
    });

    it('is unavailable without AudioContext', () => {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
      expect(getMonoAudioStatus()).toBe('unavailable');
    });

    it('is unavailable after a Web Audio failure', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      failWith = new Error('boom');
      applyMonoAudio(video(), true);
      expect(getMonoAudioStatus()).toBe('unavailable');
    });
  });

  describe('playMonoTest', () => {
    it('routes through the mono gain when mono is on', () => {
      playMonoTest(true);
      const ctx = contexts[0]!;
      expect(mergers[0]!.connections).toEqual([ctx.gains[0]!]);
      expect(ctx.gains[0]!.channelCount).toBe(1);
      expect(ctx.resume).toHaveBeenCalled();
    });

    it('goes straight to the destination when mono is off', () => {
      playMonoTest(false);
      expect(mergers[0]!.connections).toEqual([contexts[0]!.destination]);
    });

    it('plays low beeps on the left and a high tone on the right', () => {
      playMonoTest(false);
      expect(oscillators.map(o => o.frequency.value)).toEqual([400, 400, 400, 1000]);
      const channels = mergers[0]!.inputs.map(i => i[1]);
      expect(channels).toEqual([0, 0, 0, 1]);
      for (const o of oscillators) expect(o.start).toHaveBeenCalledTimes(1);
    });

    it('never creates a media element source', () => {
      playMonoTest(true);
      expect(sources).toHaveLength(0);
    });

    it('stops the previous run when called again', () => {
      playMonoTest(false);
      const first = [...oscillators];
      const firstMerger = mergers[0]!;
      playMonoTest(true);
      for (const o of first) expect(o.stop).toHaveBeenCalledTimes(2);
      expect(firstMerger.connections).toEqual([]);
      expect(contexts).toHaveLength(1);
    });

    it('is a no-op without AudioContext', () => {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
      expect(() => playMonoTest(true)).not.toThrow();
      expect(contexts).toHaveLength(0);
    });

    it('logs the diag event and turns unavailable on failure', () => {
      const warn = vi.fn();
      vi.spyOn(console, 'warn').mockImplementation(warn);
      vi.spyOn(FakeContext.prototype, 'createChannelMerger').mockImplementation(() => {
        throw Object.assign(new Error('x'), { name: 'NotSupportedError' });
      });
      playMonoTest(false);
      expect(warn.mock.calls.map(c => c.join(' ')).some(l =>
        l.includes('event=audio.mono_unavailable reason=NotSupportedError'))).toBe(true);
      expect(getMonoAudioStatus()).toBe('unavailable');
    });
  });
});
