import { HudBase } from '../crossplay/hud';
import type { WallsContext } from './context';
import { Painter as PainterDef } from './defs';
import type { Painter } from './painter';
import { PALETTE } from './yard';

/**
 * Status and announcements (see crossplay/hud.ts). A headset paints the same state onto panels in the scene
 * (wrist.ts). Frontends call `showPainter` every frame with how the device names its controls.
 */
export class Hud extends HudBase {
  status = '';
  tool = '';
  /** A swatch on the palette strip was tapped (touch only: the mouse is captured otherwise). */
  onPick: ((index: number) => void) | null = null;

  private readonly statusEl = document.getElementById('status')!;
  private readonly toolEl = document.getElementById('tool')!;
  private readonly paletteEl = document.getElementById('palette')!;
  private readonly helpEl = document.getElementById('help')!;
  private swatches: HTMLElement[] = [];
  private drawnColor = -1;

  constructor() {
    super();
    this.swatches = PALETTE.map((c, i) => {
      const el = document.createElement('button');
      el.className = 'swatch';
      el.title = c.name;
      el.style.background = hex(c.rgb);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.onPick?.(i);
      });
      this.paletteEl.appendChild(el);
      return el;
    });
  }

  /** The painter's state, worded for the platform: `help` lists its controls. */
  showPainter(ctx: WallsContext, p: Painter, help: string): void {
    const { sync, world } = ctx;
    const others = world.all(PainterDef).size - 1;
    const company = others ? `${others + 1} painting` : 'painting alone';
    const status = sync.synced ? `PEER WALLS · ${company}` : sync.fetching ? `GETTING THE WALLS FROM ${sync.fetching.toUpperCase()}…` : 'LOOKING FOR OTHER PAINTERS…';
    this.set('status', status, () => (this.statusEl.textContent = status));

    const tool = p.tool;
    const toolText = tool ? `${tool.name} · ${p.sizeName()} · ${PALETTE[p.colorIndex].name}` : PALETTE[p.colorIndex].name;
    this.set('tool', toolText, () => (this.toolEl.textContent = toolText));
    if (p.colorIndex !== this.drawnColor) {
      this.swatches[this.drawnColor]?.classList.remove('on');
      this.drawnColor = p.colorIndex;
      this.swatches[p.colorIndex].classList.add('on');
      this.toolEl.style.borderColor = hex(p.color);
      this.version++;
    }

    const aim = p.aims.find((a) => a.swatch !== null) ?? p.aims.find((a) => a.hit) ?? p.aims[0];
    let hint = '';
    if (aim.swatch !== null) hint = aim.swatch === p.colorIndex ? `${PALETTE[aim.swatch].name} is loaded` : `Load ${PALETTE[aim.swatch].name}`;
    else if (aim.hit && !aim.inReach) hint = tool && tool.spec.reach < 1 ? `Get right up to the wall with the ${tool.name.toLowerCase()}` : 'Too far away for paint to reach';
    this.setHint(hint);
    if (this.helpEl.innerHTML !== help) this.helpEl.innerHTML = help;
  }

}

export function hex(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}
