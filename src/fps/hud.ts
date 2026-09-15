import type { AvatarSim } from './avatar';
import { TILE, type City } from './city';
import { NO_TOOL } from './tool';

export interface MinimapDot {
  x: number;
  y: number;
  color: string;
  size?: number;
}

/**
 * Heads-up display state. On desktop it drives DOM elements; in VR the same
 * state is painted onto panels in the scene (see vrhud.ts), because the DOM
 * isn't visible inside a headset.
 */
export class Hud {
  cash = 0;
  wanted = 0;
  hp = 100;
  hint = '';
  /** Tool in hand and its charges, e.g. "SMG 120". */
  toolText = '';
  readonly banner = { text: '', color: '#fff', until: 0 };
  readonly feed: { text: string; until: number }[] = [];
  /** Bumped whenever something the VR panels show changes. */
  version = 0;

  private readonly root = document.getElementById('hud')!;
  private readonly cashEl = document.getElementById('cash')!;
  private readonly wantedEl = document.getElementById('wanted')!;
  private readonly healthFill = document.getElementById('health-fill')!;
  private readonly toolEl = document.getElementById('tool')!;
  private readonly feedEl = document.getElementById('feed')!;
  private readonly bannerEl = document.getElementById('banner')!;
  private readonly hintEl = document.getElementById('hint')!;
  private readonly crosshair = document.getElementById('crosshair')!;
  private readonly hurtEl = document.getElementById('hurt')!;
  private readonly lockEl = document.getElementById('lock')!;
  private readonly minimap = document.getElementById('minimap') as HTMLCanvasElement;
  private readonly mctx = this.minimap.getContext('2d')!;
  private readonly overview: HTMLCanvasElement;
  private bannerTimer = 0;
  private hitTimer = 0;

  constructor(private readonly city: City) {
    this.overview = document.createElement('canvas');
    this.overview.width = city.w;
    this.overview.height = city.h;
    this.overview
      .getContext('2d')!
      .putImageData(new ImageData(city.overviewPixels() as unknown as Uint8ClampedArray<ArrayBuffer>, city.w, city.h), 0, 0);
  }

  show(): void {
    this.root.hidden = false;
  }

  /** Desktop: whether the "click to play" prompt shows (pointer not captured). */
  setLocked(locked: boolean, vr: boolean): void {
    this.lockEl.hidden = locked || vr;
    this.crosshair.hidden = vr;
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

  setHint(text: string): void {
    if (text === this.hint) return;
    this.hint = text;
    this.hintEl.textContent = text;
    this.version++;
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

  message(text: string): void {
    const div = document.createElement('div');
    div.textContent = text;
    this.feedEl.appendChild(div);
    while (this.feedEl.children.length > 6) this.feedEl.firstChild!.remove();
    setTimeout(() => div.remove(), 6200);
    this.feed.push({ text, until: performance.now() + 6000 });
    while (this.feed.length > 4) this.feed.shift();
    this.version++;
  }

  showBanner(text: string, color: string, ms = 2500): void {
    this.bannerEl.textContent = text;
    this.bannerEl.style.color = color;
    this.bannerEl.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.bannerEl.classList.remove('show'), ms);
    Object.assign(this.banner, { text, color, until: performance.now() + ms });
    this.version++;
  }

  hitMarker(head: boolean): void {
    this.crosshair.classList.remove('hit', 'head');
    void this.crosshair.offsetWidth; // restart the animation
    this.crosshair.classList.add(head ? 'head' : 'hit');
    clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => this.crosshair.classList.remove('hit', 'head'), 180);
  }

  hurt(): void {
    this.hurtEl.classList.remove('show');
    void this.hurtEl.offsetWidth;
    this.hurtEl.classList.add('show');
  }

  /** Expire feed lines and banners; returns true if anything changed. */
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

  updateMinimap(cx: number, cy: number, heading: number, dots: MinimapDot[]): void {
    this.drawMinimap(this.mctx, this.minimap.width, cx, cy, heading, dots);
  }

  /** Heading-up circular minimap centred on (cx, cy). */
  drawMinimap(ctx: CanvasRenderingContext2D, size: number, cx: number, cy: number, heading: number, dots: MinimapDot[], viewRadius = 130): void {
    const scale = size / (viewRadius * 2);
    const half = size / 2;
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#123';
    ctx.fillRect(0, 0, size, size);
    ctx.translate(half, half);
    ctx.rotate(-(heading + Math.PI / 2));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.overview, -cx * scale, -cy * scale, this.city.w * TILE * scale, this.city.h * TILE * scale);
    const max = half - 6;
    for (const d of dots) {
      let x = (d.x - cx) * scale;
      let y = (d.y - cy) * scale;
      const r = Math.hypot(x, y);
      if (r > max) {
        x = (x / r) * max;
        y = (y / r) * max;
      }
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(x, y, (d.size ?? 2.5) * (size / 180), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const k = size / 180;
    ctx.save();
    ctx.translate(half, half);
    ctx.scale(k, k);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5, 5);
    ctx.lineTo(0, 2);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}
