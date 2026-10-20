// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Focus } from '../navigation/focus-scope';
import { TrailerOverlay } from './trailer-overlay';

const ID = 'abcdefghijk';
let overlay: TrailerOverlay;
let onClose: ReturnType<typeof vi.fn>;
let onFallback: ReturnType<typeof vi.fn>;

const frame = () => document.querySelector<HTMLIFrameElement>('.trailer-frame');

// Records what the app posts to the embedded player.
function spyPosts(): ReturnType<typeof vi.fn> {
  const post = vi.fn();
  Object.defineProperty(frame()!, 'contentWindow', { configurable: true, value: { postMessage: post } });
  return post;
}

function fromFrame(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: JSON.stringify(data),
    source: frame()!.contentWindow as Window,
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  overlay = new TrailerOverlay('trailer.test');
  onClose = vi.fn();
  onFallback = vi.fn();
});

afterEach(() => {
  overlay.hide();
  Focus.uninstall();
  vi.useRealTimers();
});

describe('TrailerOverlay', () => {
  it('embeds only a validated 11-character id', () => {
    overlay.show('bad id"><script>', { onFallback });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(frame()).toBeNull();
    overlay.show(ID, { onFallback });
    expect(frame()!.getAttribute('src')).toBe(
      `https://andreescocard.github.io/webos-iptv-player/pages/trailer.html?v=${ID}`,
    );
    expect(frame()!.getAttribute('tabindex')).toBe('-1');
  });

  it('closes on Back and removes the frame', () => {
    overlay.show(ID, { onFallback, onClose });
    overlay.handleAction('back');
    expect(overlay.visible).toBe(false);
    expect(frame()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('toggles play and pause with OK through postMessage', () => {
    overlay.show(ID, { onFallback });
    const post = spyPosts();
    overlay.handleAction('select');
    expect(JSON.parse(post.mock.calls[0][0] as string)).toMatchObject({ event: 'command', func: 'pauseVideo' });
    expect(post.mock.calls[0][1]).toBe('https://andreescocard.github.io');
    expect(document.querySelector('.trailer-overlay')!.classList.contains('trailer-paused')).toBe(true);
    overlay.handleAction('select');
    expect(JSON.parse(post.mock.calls[1][0] as string)).toMatchObject({ func: 'playVideo' });
    expect(document.querySelector('.trailer-overlay')!.classList.contains('trailer-paused')).toBe(false);
  });

  it('falls back when embedding is disabled', () => {
    overlay.show(ID, { onFallback, onClose });
    spyPosts();
    fromFrame({ event: 'onError', info: 150 });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(overlay.visible).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores messages from anything but its frame', () => {
    overlay.show(ID, { onFallback });
    spyPosts();
    window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onError', info: 150 }) }));
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('falls back when the frame never loads, but not once it has', () => {
    overlay.show(ID, { onFallback });
    vi.advanceTimersByTime(8001);
    expect(onFallback).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    overlay.show(ID, { onFallback: second });
    spyPosts();
    frame()!.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(9000);
    expect(second).not.toHaveBeenCalled();
  });

  it('closes when the video ends', () => {
    overlay.show(ID, { onFallback, onClose });
    spyPosts();
    fromFrame({ event: 'onStateChange', info: 0 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('seeks 10 seconds forward on Right from the reported time', () => {
    overlay.show(ID, { onFallback });
    const post = spyPosts();
    fromFrame({ event: 'infoDelivery', info: { currentTime: 30, duration: 150 } });
    overlay.handleAction('right');
    expect(JSON.parse(post.mock.calls[0][0] as string)).toEqual({
      event: 'command', func: 'seekTo', args: [40, true],
    });
    overlay.handleAction('fast_forward');
    expect(JSON.parse(post.mock.calls[1][0] as string)).toMatchObject({ args: [50, true] });
  });

  it('clamps Left at zero and Right at the reported duration', () => {
    overlay.show(ID, { onFallback });
    const post = spyPosts();
    fromFrame({ event: 'infoDelivery', info: { currentTime: 4, duration: 95 } });
    overlay.handleAction('left');
    expect(JSON.parse(post.mock.calls[0][0] as string)).toMatchObject({ args: [0, true] });
    fromFrame({ event: 'infoDelivery', info: { currentTime: 90, duration: 95 } });
    overlay.handleAction('right');
    expect(JSON.parse(post.mock.calls[1][0] as string)).toMatchObject({ args: [95, true] });
  });

  it('tracks the time from infoDelivery and shows the OSD for two seconds', () => {
    overlay.show(ID, { onFallback });
    spyPosts();
    fromFrame({ event: 'infoDelivery', info: { currentTime: 83, duration: 150 } });
    overlay.handleAction('select');
    const osd = document.querySelector('.trailer-osd')!;
    expect(osd.classList.contains('shown')).toBe(true);
    expect(osd.querySelector('.trailer-osd-time')!.textContent).toBe('1:23 / 2:30');
    vi.advanceTimersByTime(2001);
    expect(osd.classList.contains('shown')).toBe(false);
  });

  // jsdom ignores blur() on an iframe, so assert the call instead of activeElement.
  it('takes focus back from the embed so the app keeps the keys', () => {
    overlay.show(ID, { onFallback });
    const blur = vi.spyOn(frame()!, 'blur');
    const focus = vi.spyOn(window, 'focus');
    frame()!.focus();
    window.dispatchEvent(new Event('blur'));
    expect(blur).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(frame()).not.toBeNull();
    expect(blur).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('removes the focus guard on close', () => {
    overlay.show(ID, { onFallback });
    const remove = vi.spyOn(window, 'removeEventListener');
    overlay.hide();
    expect(remove).toHaveBeenCalledWith('blur', expect.any(Function));
    remove.mockRestore();
  });
});
