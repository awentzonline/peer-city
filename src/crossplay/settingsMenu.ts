import type { DesktopInput } from './input';
import type { Settings, SettingsRow } from './settings';

/** How often the open menu is redrawn: often enough for the talking meters, rarely enough to be free. */
const REDRAW_MS = 100;

interface RowEls {
  el: HTMLElement;
  label: HTMLElement;
  detail: HTMLElement;
  state: HTMLElement;
  meter: HTMLElement;
  row: SettingsRow;
}

/**
 * The settings menu on desktop: an overlay over the game, built here rather than in each game's HTML so
 * every game on the crossplay layer gets the same one. Escape opens it, which is also what hands the mouse
 * back; closing it takes the mouse again. The headset has its own (settingsPanel.ts) drawn from the same
 * rows, because the DOM isn't visible inside one.
 */
export class SettingsMenu {
  private readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private readonly rows = new Map<string, RowEls>();
  private nextDraw = 0;

  constructor(
    private readonly settings: Settings,
    private readonly input: DesktopInput,
    parent: HTMLElement = document.body,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'settings';
    this.root.hidden = true;
    this.root.innerHTML =
      '<div class="settings-panel"><h2>SETTINGS</h2><div class="settings-rows"></div>' +
      '<div class="settings-foot"><small><b>Esc</b> close · <b>V</b> microphone · <b>N</b> game sound</small>' +
      '<button class="settings-close">CLOSE</button></div></div>';
    this.list = this.root.querySelector('.settings-rows')!;
    this.root.querySelector('.settings-close')!.addEventListener('click', () => this.setOpen(false));
    // Clicking the dimmed area around the panel closes it, as it does everywhere else.
    this.root.addEventListener('click', (e) => e.target === this.root && this.setOpen(false));
    parent.appendChild(this.root);
  }

  get open(): boolean {
    return this.settings.open;
  }

  toggle(): void {
    this.setOpen(!this.settings.open);
  }

  setOpen(open: boolean): void {
    if (open === this.settings.open) return;
    this.settings.open = open;
    this.root.hidden = !open;
    // The games' "click to play" prompt and crosshair belong to their own HUDs; this is how they keep clear.
    document.body.classList.toggle('settings-open', open);
    if (open) {
      this.nextDraw = 0;
      this.draw();
      document.exitPointerLock();
    } else {
      this.input.requestLock();
    }
  }

  /** Redraw the open menu. Cheap to call every frame. */
  update(now: number): void {
    if (!this.settings.open || now < this.nextDraw) return;
    this.nextDraw = now + REDRAW_MS;
    this.draw();
  }

  dispose(): void {
    document.body.classList.remove('settings-open');
    this.root.remove();
  }

  private draw(): void {
    const wanted = this.settings.rows();
    const seen = new Set<string>();
    wanted.forEach((row, i) => {
      seen.add(row.id);
      const els = this.rows.get(row.id) ?? this.build(row);
      els.row = row;
      this.fill(els, row);
      // Keep the DOM in the rows' order; people walk in and out of earshot while the menu is up.
      if (this.list.children[i] !== els.el) this.list.insertBefore(els.el, this.list.children[i] ?? null);
    });
    for (const [id, els] of this.rows) {
      if (seen.has(id)) continue;
      els.el.remove();
      this.rows.delete(id);
    }
  }

  private build(row: SettingsRow): RowEls {
    const el = document.createElement(row.kind === 'toggle' ? 'button' : 'div');
    el.className = `settings-row settings-${row.kind}`;
    const label = document.createElement('b');
    const detail = document.createElement('span');
    const state = document.createElement('i');
    const meter = document.createElement('u');
    el.append(label, detail, state, meter);
    const els: RowEls = { el, label, detail, state, meter, row };
    if (row.kind === 'toggle') {
      el.addEventListener('click', () => {
        els.row.toggle();
        this.nextDraw = 0;
      });
    }
    this.rows.set(row.id, els);
    return els;
  }

  private fill(els: RowEls, row: SettingsRow): void {
    if (els.label.textContent !== row.label) els.label.textContent = row.label;
    if (els.detail.textContent !== row.detail) els.detail.textContent = row.detail;
    const state = row.kind === 'toggle' ? (row.on ? 'ON' : 'OFF') : '';
    if (els.state.textContent !== state) els.state.textContent = state;
    els.el.classList.toggle('on', row.kind === 'toggle' && row.on);
    els.meter.style.transform = `scaleX(${row.level > 0 ? Math.min(1, row.level) : 0})`;
  }
}
