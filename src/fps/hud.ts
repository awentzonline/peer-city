import { HudBase } from '../crossplay/hud';
import { drawMinimap, type MinimapBase, type MinimapDot } from '../crossplay/minimap';
import type { AvatarSim } from './avatar';
import { TILE, type City } from './city';
import { NO_TOOL } from './tool';

export type { MinimapDot } from '../crossplay/minimap';

/**
 * Heads-up display state (see crossplay/hud.ts). In VR the same state is painted onto panels in the scene (see
 * vrhud.ts), because the DOM isn't visible inside a headset.
 */
export class Hud extends HudBase {
  cash = 0;
  wanted = 0;
  hp = 100;
  /** Tool in hand and its charges, e.g. "SMG 120". */
  toolText = '';

  private readonly cashEl = document.getElementById('cash')!;
  private readonly wantedEl = document.getElementById('wanted')!;
  private readonly healthFill = document.getElementById('health-fill')!;
  private readonly toolEl = document.getElementById('tool')!;
  private readonly minimap = document.getElementById('minimap') as HTMLCanvasElement;
  private readonly mctx = this.minimap.getContext('2d')!;
  private readonly map: MinimapBase;

  constructor(city: City) {
    super();
    const overview = document.createElement('canvas');
    overview.width = city.w;
    overview.height = city.h;
    overview.getContext('2d')!.putImageData(new ImageData(city.overviewPixels() as unknown as Uint8ClampedArray<ArrayBuffer>, city.w, city.h), 0, 0);
    this.map = { image: overview, x: 0, y: 0, w: city.w * TILE, h: city.h * TILE, background: '#123', smooth: false };
  }

  setStatus(cash: number, wanted: number, hp: number): void {
    if (cash !== this.cash) {
      this.cash = cash;
      this.cashEl.textContent = `$${cash.toLocaleString()}`;
      this.version++;
    }
    if (wanted !== this.wanted) {
      this.wanted = wanted;
      this.wantedEl.innerHTML = Array.from({ length: 5 }, (_, i) => (i < wanted ? '★' : '<span class="off">★</span>')).join('');
      this.wantedEl.classList.toggle('flash', wanted > 0);
      this.version++;
    }
    if (hp !== this.hp) {
      this.hp = hp;
      this.healthFill.style.width = `${Math.max(0, hp)}%`;
      this.version++;
    }
  }

  /** Doesn't bump `version`: the wrist panel redraws on its own timer, and this changes with every shot. */
  setTool(name: string, charges: number): void {
    const text = Number.isFinite(charges) ? `${name}  ${charges}` : name;
    if (text === this.toolText) return;
    this.toolText = text;
    this.toolEl.textContent = text;
  }

  /** An avatar's status, hint and tool readout. `button` is what gets you into a car on this platform. */
  showAvatar(sim: AvatarSim, button: string): void {
    const s = sim.me?.state;
    if (!s) return;
    this.setStatus(s.cash, s.wanted, s.hp);
    this.setHint(sim.cuffed ? 'The cops have hold of you. Run!' : sim.nearCar ? `Press ${button} to take the car` : '');
    if (s.hp === 0 || sim.arrested) return;
    const tool = sim.inventory.current;
    if (tool && (s.tool !== NO_TOOL || s.ltool !== NO_TOOL)) this.setTool(tool.name, sim.inventory.charges(tool));
    else this.setTool('', Infinity);
  }

  updateMinimap(cx: number, cy: number, heading: number, dots: MinimapDot[]): void {
    this.drawMinimap(this.mctx, this.minimap.width, cx, cy, heading, dots);
  }

  /** Heading-up circular minimap centred on (cx, cy). */
  drawMinimap(ctx: CanvasRenderingContext2D, size: number, cx: number, cy: number, heading: number, dots: MinimapDot[], viewRadius = 130): void {
    drawMinimap(ctx, size, this.map, cx, cy, heading, dots, viewRadius);
  }
}
