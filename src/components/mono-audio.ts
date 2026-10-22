import { createLogger } from '../utils/logger';

const log = createLogger('MonoAudio');

interface Wiring {
  source: MediaElementAudioSourceNode;
  resume: () => void;
}

type AudioContextCtor = new () => AudioContext;

const TEST_LEVEL = 0.3;
const TEST_RAMP = 0.01;
const TEST_MS = 4500;

let context: AudioContext | null = null;
let monoGain: GainNode | null = null;
let current: HTMLVideoElement | null = null;
let failed = false;
let monoOn = false;
let stopTest: (() => void) | null = null;
const wirings = new WeakMap<HTMLVideoElement, Wiring>();

function contextCtor(): AudioContextCtor | undefined {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext || w.webkitAudioContext;
}

function resumeContext(): void {
  if (context && context.state === 'suspended') {
    const pending = context.resume();
    if (pending && typeof pending.catch === 'function') pending.catch(() => { /* retried on play */ });
  }
}

function ensureMonoGain(ctx: AudioContext): GainNode {
  if (!monoGain) {
    monoGain = ctx.createGain();
    monoGain.channelCount = 1;
    monoGain.channelCountMode = 'explicit';
    monoGain.channelInterpretation = 'speakers';
    monoGain.connect(ctx.destination);
  }
  return monoGain;
}

function wire(video: HTMLVideoElement, enabled: boolean): void {
  let wiring = wirings.get(video);
  if (!wiring) {
    if (!enabled) return;
    const Ctor = contextCtor();
    if (!Ctor) return;
    if (!context) context = new Ctor();
    const source = context.createMediaElementSource(video);
    wiring = { source, resume: resumeContext };
    video.addEventListener('play', wiring.resume);
    wirings.set(video, wiring);
  }
  const ctx = context!;
  wiring.source.disconnect();
  if (enabled) {
    wiring.source.connect(ensureMonoGain(ctx));
  } else {
    wiring.source.connect(ctx.destination);
  }
  monoOn = enabled;
  resumeContext();
}

function fail(e: unknown): void {
  failed = true;
  const reason = e instanceof Error ? e.name : 'unknown';
  log.warn('Mono audio unavailable', `event=audio.mono_unavailable reason=${reason}`);
}

// Web Audio is touched only once mono is first enabled: a media element
// source can silence audio on some TVs, so users who keep it off are unaffected.
export function applyMonoAudio(video: HTMLVideoElement | null, enabled: boolean): void {
  if (video) current = video;
  if (!current || failed) return;
  try {
    wire(current, enabled);
  } catch (e) {
    fail(e);
  }
}

export function getMonoAudioStatus(): 'off' | 'active' | 'unavailable' {
  if (failed || !contextCtor()) return 'unavailable';
  return current && monoOn && wirings.has(current) ? 'active' : 'off';
}

// Low beeps on the left, one high tone on the right, through a channel merger
// (StereoPanner may be missing on Chromium 53). It never creates a media
// element source, so the test cannot silence the video.
export function playMonoTest(mono: boolean): void {
  if (failed) return;
  try {
    if (stopTest) stopTest();
    const Ctor = contextCtor();
    if (!Ctor) return;
    if (!context) context = new Ctor();
    const ctx = context;
    resumeContext();
    const merger = ctx.createChannelMerger(2);
    merger.connect(mono ? ensureMonoGain(ctx) : ctx.destination);
    const oscillators: OscillatorNode[] = [];
    const t0 = ctx.currentTime + 0.05;
    const tone = (freq: number, channel: number, start: number, length: number): void => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      const begin = t0 + start;
      const end = begin + length;
      gain.gain.setValueAtTime(0, begin);
      gain.gain.linearRampToValueAtTime(TEST_LEVEL, begin + TEST_RAMP);
      gain.gain.setValueAtTime(TEST_LEVEL, end - TEST_RAMP);
      gain.gain.linearRampToValueAtTime(0, end);
      osc.connect(gain);
      gain.connect(merger, 0, channel);
      osc.start(begin);
      osc.stop(end + TEST_RAMP);
      oscillators.push(osc);
    };
    for (let i = 0; i < 3; i++) tone(400, 0, i * 0.5, 0.25);
    tone(1000, 1, 2.5, 1.5);
    let timer = 0;
    const stop = (): void => {
      window.clearTimeout(timer);
      stopTest = null;
      for (const osc of oscillators) {
        try { osc.stop(); } catch { /* already ended */ }
      }
      merger.disconnect();
    };
    timer = window.setTimeout(stop, TEST_MS);
    stopTest = stop;
  } catch (e) {
    stopTest = null;
    fail(e);
  }
}

export function resetMonoAudioForTests(): void {
  if (stopTest) stopTest();
  context = null;
  monoGain = null;
  current = null;
  failed = false;
  monoOn = false;
  stopTest = null;
}
