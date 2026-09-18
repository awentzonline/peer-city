import { Platform } from './platform';

/** A message in the feed, shown until `until` (performance.now() ms). */
export interface FeedLine {
  text: string;
  until: number;
}

const FEED_MS = 6000;
/** Lines the model keeps for panels to show; the page's feed keeps a few more while they fade. */
const FEED_LINES = 4;
const PAGE_FEED_LINES = 6;

/**
 * What every game's HUD has, as state and on the page: a feed of messages, a big banner, a hint, the "click to
 * play" prompt and crosshair, and flashes for hits and hurts. A game extends it with its own status.
 *
 * The state is plain fields so a headset can paint it onto panels (see headsetHud.ts), since the DOM isn't
 * visible inside one: whatever changes something a panel shows bumps `version`. On the page it drives the
 * elements with ids `hud`, `feed`, `banner`, `hint`, `crosshair`, `lock` and `hurt`, where the page has them.
 */
export class HudBase {
  hint = '';
  readonly feed: FeedLine[] = [];
  readonly banner = { text: '', color: '#fff', until: 0 };
  /** Bumped whenever something a headset's panels show changes. */
  version = 0;
  /** Whether the mouse is captured, and what the page is played on (see `setLocked`). */
  protected locked = false;
  protected platform = Platform.Desktop;

  protected readonly rootEl = document.getElementById('hud');
  protected readonly feedEl = document.getElementById('feed');
  protected readonly bannerEl = document.getElementById('banner');
  protected readonly hintEl = document.getElementById('hint');
  protected readonly crosshairEl = document.getElementById('crosshair');
  protected readonly lockEl = document.getElementById('lock');
  protected readonly hurtEl = document.getElementById('hurt');
  private bannerTimer = 0;
  private hitTimer = 0;

  show(): void {
    if (this.rootEl) this.rootEl.hidden = false;
  }

  /** The mouse was captured or let go, or the page is played on another platform now. */
  setLocked(locked: boolean, platform: Platform): void {
    this.locked = locked;
    this.platform = platform;
    this.showCursor();
  }

  /**
   * Show the "click to play" prompt only while a mouse needs capturing, and the crosshair to anyone aiming down
   * the middle of a screen. Override to hide them while something else has the screen, then call `showCursor`
   * again when that changes.
   */
  protected showCursor(): void {
    if (this.lockEl) this.lockEl.hidden = this.locked || this.platform !== Platform.Desktop;
    if (this.crosshairEl) this.crosshairEl.hidden = this.platform === Platform.Vr;
  }

  message(text: string): void {
    const el = this.feedEl;
    if (el) {
      const div = document.createElement('div');
      div.textContent = text;
      el.appendChild(div);
      while (el.children.length > PAGE_FEED_LINES) el.firstChild!.remove();
      setTimeout(() => div.remove(), FEED_MS + 200);
    }
    this.feed.push({ text, until: performance.now() + FEED_MS });
    while (this.feed.length > FEED_LINES) this.feed.shift();
    this.version++;
  }

  showBanner(text: string, color: string, ms = 2500): void {
    const el = this.bannerEl;
    if (el) {
      el.textContent = text;
      el.style.color = color;
      el.classList.add('show');
      clearTimeout(this.bannerTimer);
      this.bannerTimer = window.setTimeout(() => el.classList.remove('show'), ms);
    }
    Object.assign(this.banner, { text, color, until: performance.now() + ms });
    this.version++;
  }

  setHint(text: string): void {
    this.set('hint', text, () => this.hintEl && (this.hintEl.textContent = text));
  }

  /** Flash the crosshair for a hit (`head` for a headshot's flash, where the page styles one). */
  hitMarker(kind: 'hit' | 'head' = 'hit'): void {
    const el = this.crosshairEl;
    if (!el) return;
    el.classList.remove('hit', 'head');
    void el.offsetWidth; // restart the animation
    el.classList.add(kind);
    clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => el.classList.remove('hit', 'head'), 180);
  }

  /** Flash the edges of the screen red. */
  hurt(): void {
    const el = this.hurtEl;
    if (!el) return;
    // restart a flash already running in place; reading layout to restart it cost a frame's worth of time on every hit
    const running = el.classList.contains('show') ? el.getAnimations() : [];
    if (running.length) {
      for (const a of running) a.currentTime = 0;
      return;
    }
    el.classList.add('show');
    el.addEventListener('animationend', () => el.classList.remove('show'), { once: true });
  }

  /** Expire feed lines and banners. Call every rendered frame. Returns whether anything changed. */
  tick(now: number): boolean {
    let changed = false;
    while (this.feed.length && this.feed[0].until < now) {
      this.feed.shift();
      changed = true;
    }
    if (this.banner.text && this.banner.until < now) {
      this.banner.text = '';
      changed = true;
    }
    if (changed) this.version++;
    return changed;
  }

  /** Change a field a panel shows: when it's really different, `apply` it to the page and bump `version`. */
  protected set<K extends keyof this>(key: K, value: this[K], apply?: () => void): void {
    if (this[key] === value) return;
    this[key] = value;
    apply?.();
    this.version++;
  }
}
