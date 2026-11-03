// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UpNextCard } from './up-next-card';

describe('UpNextCard', () => {
  let el: HTMLElement;
  let onPlay: ReturnType<typeof vi.fn>;
  let card: UpNextCard;

  beforeEach(() => {
    document.body.innerHTML = '<div id="up-next" class="hidden"></div>';
    el = document.getElementById('up-next')!;
    onPlay = vi.fn();
    card = new UpNextCard(el, onPlay);
  });

  it('marks its root self-activating so the global click handler skips it', () => {
    expect(el.hasAttribute('data-self-activate')).toBe(true);
  });

  it('shows the next title, countdown, and play button at the given offset', () => {
    card.update({ title: 'Episode 2', seconds: 42 }, 120);
    expect(card.visible).toBe(true);
    expect(el.classList.contains('hidden')).toBe(false);
    expect(el.style.bottom).toBe('120px');
    expect(el.querySelector('.up-next-title')!.textContent).toBe('Episode 2');
    expect(el.querySelector('.osd-next-episode-time')!.textContent).toContain('42');
    expect(el.querySelector('[data-up-next-play]')).not.toBeNull();
  });

  it('escapes an untrusted title', () => {
    card.update({ title: '<img src=x onerror=alert(1)>', seconds: 5 }, 0);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.up-next-title')!.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('keeps the rendered nodes when the state is unchanged', () => {
    card.update({ title: 'Episode 2', seconds: 10 }, 0);
    const button = el.querySelector('[data-up-next-play]');
    card.update({ title: 'Episode 2', seconds: 10 }, 40);
    expect(el.querySelector('[data-up-next-play]')).toBe(button);
    expect(el.style.bottom).toBe('40px');
  });

  it('updates the countdown as it ticks', () => {
    card.update({ title: 'Episode 2', seconds: 10 }, 0);
    card.update({ title: 'Episode 2', seconds: 9 }, 0);
    expect(el.querySelector('.osd-next-episode-time')!.textContent).toContain('9');
  });

  it('hides on a null state and renders again when re-offered', () => {
    card.update({ title: 'Episode 2', seconds: 10 }, 0);
    card.update(null, 0);
    expect(card.visible).toBe(false);
    expect(el.classList.contains('hidden')).toBe(true);
    card.update({ title: 'Episode 2', seconds: 10 }, 0);
    expect(card.visible).toBe(true);
    expect(el.classList.contains('hidden')).toBe(false);
  });

  it('plays the next episode on a click on its button only', () => {
    card.update({ title: 'Episode 2', seconds: 10 }, 0);
    el.querySelector<HTMLElement>('.up-next-title')!.click();
    expect(onPlay).not.toHaveBeenCalled();
    el.querySelector<HTMLElement>('[data-up-next-play]')!.click();
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});
