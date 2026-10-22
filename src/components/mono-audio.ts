import { createLogger } from '../utils/logger';

const log = createLogger('MonoAudio');

interface Wiring {
  source: MediaElementAudioSourceNode;
  resume: () => void;
}

type AudioContextCtor = new () => AudioContext;

let context: AudioContext | null = null;
let monoGain: GainNode | null = null;
let current: HTMLVideoElement | null = null;
let failed = false;
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
    if (!monoGain) {
      monoGain = ctx.createGain();
      monoGain.channelCount = 1;
      monoGain.channelCountMode = 'explicit';
      monoGain.channelInterpretation = 'speakers';
      monoGain.connect(ctx.destination);
    }
    wiring.source.connect(monoGain);
  } else {
    wiring.source.connect(ctx.destination);
  }
  resumeContext();
}

// Web Audio is touched only once mono is first enabled: a media element
// source can silence audio on some TVs, so users who keep it off are unaffected.
export function applyMonoAudio(video: HTMLVideoElement | null, enabled: boolean): void {
  if (video) current = video;
  if (!current || failed) return;
  try {
    wire(current, enabled);
  } catch (e) {
    failed = true;
    const reason = e instanceof Error ? e.name : 'unknown';
    log.warn('Mono audio unavailable', `event=audio.mono_unavailable reason=${reason}`);
  }
}

export function resetMonoAudioForTests(): void {
  context = null;
  monoGain = null;
  current = null;
  failed = false;
}
