import type { Action } from '../types';
import { Focus, type FocusScope } from '../navigation/focus-scope';
import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { createLogger } from '../utils/logger';
import { CONFIG } from '../config';

const log = createLogger('TrailerOverlay');

// The wrapper's origin, cut by hand: URL is missing on Chromium 53.
const EMBED_ORIGIN = CONFIG.TRAILER_EMBED_URL.split('/').slice(0, 3).join('/');
const VIDEO_ID_RE = /^[\w-]{11}$/;
const LOAD_TIMEOUT_MS = 8000;
const SEEK_STEP_S = 10;
const OSD_MS = 2000;

export interface TrailerOverlayHandlers {
  onClose?: () => void;
  // The embed can't play this video (embedding disabled, or it never loaded).
  onFallback: () => void;
}

// A full-screen YouTube embed. The app keeps the keys (the iframe is never
// focused): Back closes, OK pauses or resumes, Left/Right seek 10 s, all through
// the player's postMessage API. An embed that errors or never loads hands over
// to `onFallback`.
export class TrailerOverlay {
  private el: HTMLElement | null = null;
  private frame: HTMLIFrameElement | null = null;
  private osd: HTMLElement | null = null;
  private osdTimer: ReturnType<typeof setTimeout> | null = null;
  private scope: FocusScope | null = null;
  private handlers: TrailerOverlayHandlers | null = null;
  private playing = true;
  private currentTime = 0;
  private duration = 0;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onMessage = (event: MessageEvent): void => this.handleMessage(event);
  // A pointer click focuses the cross-origin embed, which would swallow the remote keys.
  private readonly onWindowBlur = (): void => {
    setTimeout(() => {
      if (!this.visible || !this.frame || document.activeElement !== this.frame) return;
      this.frame.blur();
      window.focus();
    }, 0);
  };

  constructor(private readonly id: string) {}

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(videoId: string, handlers: TrailerOverlayHandlers): void {
    if (!VIDEO_ID_RE.test(videoId)) {
      handlers.onFallback();
      return;
    }
    if (this.visible) this.teardown();
    if (!this.scope) {
      this.scope = Focus.register({
        id: this.id,
        root: () => this.el,
        restrict: 'self-only',
        onAction: (action) => this.handleAction(action),
      });
    }
    this.handlers = handlers;
    this.playing = true;
    this.currentTime = 0;
    this.duration = 0;
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'trailer-overlay';
      this.el.setAttribute('data-self-activate', '');
      this.el.addEventListener('click', () => this.toggle());
    }
    this.el.classList.remove('hidden', 'trailer-paused');
    this.el.textContent = '';
    const pauseBadge = document.createElement('div');
    pauseBadge.className = 'trailer-pause-badge';
    const frame = document.createElement('iframe');
    frame.className = 'trailer-frame';
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('allow', 'autoplay; encrypted-media');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.addEventListener('load', () => this.onFrameLoad());
    this.frame = frame;
    this.osd = document.createElement('div');
    this.osd.className = 'trailer-osd';
    this.el.appendChild(frame);
    this.el.appendChild(pauseBadge);
    this.el.appendChild(this.osd);
    document.body.appendChild(this.el);
    window.addEventListener('message', this.onMessage);
    window.addEventListener('blur', this.onWindowBlur);
    this.loadTimer = setTimeout(() => this.fallback('timeout'), LOAD_TIMEOUT_MS);
    frame.src = `${CONFIG.TRAILER_EMBED_URL}?v=${videoId}`;
    Focus.push(this.scope);
  }

  hide(): void {
    if (!this.visible) return;
    this.teardown();
    this.handlers?.onClose?.();
    this.handlers = null;
  }

  handleAction(action: Action): void {
    if (!this.visible) return;
    if (action === 'back') this.hide();
    else if (action === 'select') this.toggle();
    else if (action === 'left' || action === 'rewind') this.seekBy(-SEEK_STEP_S);
    else if (action === 'right' || action === 'fast_forward') this.seekBy(SEEK_STEP_S);
  }

  private toggle(): void {
    if (!this.visible) return;
    this.playing = !this.playing;
    this.command(this.playing ? 'playVideo' : 'pauseVideo');
    this.el?.classList.toggle('trailer-paused', !this.playing);
    this.showOsd();
  }

  private seekBy(delta: number): void {
    const upper = this.duration > 0 ? this.duration : Infinity;
    const target = Math.min(upper, Math.max(0, this.currentTime + delta));
    // Optimistic: repeated presses accumulate before the player reports back.
    this.currentTime = target;
    this.command('seekTo', [target, true]);
    this.showOsd();
  }

  private command(func: string, args: unknown = ''): void {
    this.post({ event: 'command', func, args });
  }

  private post(message: Record<string, unknown>): void {
    try {
      this.frame?.contentWindow?.postMessage(JSON.stringify(message), EMBED_ORIGIN);
    } catch { /* the frame is gone */ }
  }

  private onFrameLoad(): void {
    if (this.loadTimer !== null) {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
    }
    // Asks the player to start reporting its events (errors, end of video, time).
    this.post({ event: 'listening', id: 1, channel: 'widget' });
  }

  private handleMessage(event: MessageEvent): void {
    if (!this.visible || event.source !== this.frame?.contentWindow) return;
    let data: unknown = event.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return; }
    }
    if (!data || typeof data !== 'object') return;
    const message = data as { event?: unknown; info?: unknown };
    if (message.event === 'onError') {
      this.fallback(`error code=${typeof message.info === 'number' ? message.info : 0}`);
    } else if (message.event === 'onStateChange' && message.info === 0) {
      this.hide();
    } else if (message.event === 'infoDelivery' && message.info && typeof message.info === 'object') {
      const info = message.info as { currentTime?: unknown; duration?: unknown };
      if (typeof info.currentTime === 'number') this.currentTime = info.currentTime;
      if (typeof info.duration === 'number') this.duration = info.duration;
      if (this.osd?.classList.contains('shown')) this.renderOsd();
    }
  }

  private showOsd(): void {
    if (!this.osd) return;
    this.renderOsd();
    this.osd.classList.add('shown');
    if (this.osdTimer !== null) clearTimeout(this.osdTimer);
    this.osdTimer = setTimeout(() => {
      this.osdTimer = null;
      this.osd?.classList.remove('shown');
    }, OSD_MS);
  }

  private renderOsd(): void {
    if (!this.osd) return;
    const percent = this.duration > 0 ? Math.min(100, (this.currentTime / this.duration) * 100) : 0;
    const total = this.duration > 0 ? formatTime(this.duration) : '--:--';
    morph(this.osd, html`<div class="trailer-osd-time">${formatTime(this.currentTime)} / ${total}</div><div class="trailer-osd-bar"><div class="trailer-osd-fill" style="width: ${percent.toFixed(2)}%"></div></div>`);
  }

  private fallback(reason: string): void {
    const handlers = this.handlers;
    log.warn(`event=trailer.embed.failed reason=${reason}`);
    this.teardown();
    this.handlers = null;
    handlers?.onFallback();
  }

  private teardown(): void {
    if (this.loadTimer !== null) {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
    }
    if (this.osdTimer !== null) {
      clearTimeout(this.osdTimer);
      this.osdTimer = null;
    }
    window.removeEventListener('message', this.onMessage);
    window.removeEventListener('blur', this.onWindowBlur);
    // Dropping the frame stops the video and its audio.
    this.frame?.remove();
    this.frame = null;
    this.osd = null;
    this.el?.classList.add('hidden');
    if (this.scope) Focus.pop(this.scope);
  }
}

function formatTime(seconds: number): string {
  const total = Math.floor(Math.max(0, seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => (n < 10 ? '0' : '') + n;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
