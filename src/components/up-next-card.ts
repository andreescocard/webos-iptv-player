import { html, show, hide } from '../utils/dom';
import { morph } from '../utils/morph';
import { t, tp } from '../i18n';

export interface UpNextCardState {
  title: string;
  seconds: number;
}

// The next episode, offered in a corner of the closing credits while the
// current one keeps playing. The player routes OK and Back to it; a pointer
// click on its button plays the next episode at once.
export class UpNextCard {
  private state: UpNextCardState | null = null;

  constructor(private el: HTMLElement, onPlay: () => void) {
    el.setAttribute('data-self-activate', '');
    el.addEventListener('click', (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-up-next-play]')) onPlay();
    });
  }

  get visible(): boolean {
    return this.state !== null;
  }

  update(state: UpNextCardState | null, bottom: number): void {
    const same = state && this.state && state.title === this.state.title
      && state.seconds === this.state.seconds;
    this.state = state;
    if (!state) { hide(this.el); return; }
    this.el.style.bottom = `${bottom}px`;
    if (!same) {
      morph(this.el, html`
        <div class="osd-next-episode-label">${t('player.upNext')}</div>
        <div class="up-next-title">${state.title}</div>
        <div class="osd-next-episode-time">${tp('player.playingIn', state.seconds)}</div>
        <button class="up-next-play" data-up-next-play>${t('player.playNow')}</button>
      `);
    }
    show(this.el);
  }
}
