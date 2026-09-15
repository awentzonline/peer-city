import { NO_TOOL } from '../crossplay/tool';
import { timeName } from './clock';
import type { WildsContext } from './context';
import { Animal, AnimalKind, AnimalMode, Campfire, Plot, Survivor } from './defs';
import { ripe } from './homestead';
import { ARROWS, AXE, BOW, CARROT, COOKED_MEAT, HOE, RAW_MEAT, SEEDS, WOOD, type WildTool } from './kit';
import { GRID, Land } from './land';
import type { Survivor as SurvivorRole } from './survivor';

export interface MapDot {
  x: number;
  y: number;
  color: string;
  size?: number;
}

/** How to use each tool on a crosshair, and with tracked hands. */
const HOW: Map<WildTool, [desktop: string, vr: string]> = new Map([
  [AXE, ['Click to chop trees and strike animals', 'Swing it into a trunk or an animal']],
  [BOW, ['Hold click to draw, let go to shoot', 'Grab an arrow over your right shoulder and draw it back from the bow']],
  [ARROWS, ['Take out the bow to shoot these', 'Touch the bow with the arrow, hold the trigger, pull back, let go']],
  [HOE, ['Click the ground to till a plot', 'Chop it down into the ground to till a plot']],
  [SEEDS, ['Click tilled soil to sow', 'Reach down to a tilled plot and pull the trigger']],
  [CARROT, ['Click to eat', 'Hold it to your mouth']],
  [RAW_MEAT, ['Hold click by a fire to cook, click to eat raw', 'Hold it over a fire to cook, or to your mouth to eat raw']],
  [COOKED_MEAT, ['Click to eat', 'Hold it to your mouth']],
  [WOOD, ['Click the ground to build a fire (3 logs), or a fire to stoke it', 'Set it on the ground to build a fire, or on a fire to stoke it']],
]);

/**
 * Status and announcements. On desktop it drives DOM elements; a headset paints the same state onto panels
 * in the scene (see wrist.ts), because the DOM isn't visible inside one.
 */
export class Hud {
  hp = 100;
  food = 100;
  hint = '';
  toolText = '';
  toolHow = '';
  clock = '';
  readonly banner = { text: '', color: '#fff', until: 0 };
  readonly feed: { text: string; until: number }[] = [];
  /** Bumped whenever something the VR panels show changes. */
  version = 0;

  private readonly root = document.getElementById('hud')!;
  private readonly healthFill = document.getElementById('health-fill')!;
  private readonly foodFill = document.getElementById('food-fill')!;
  private readonly toolEl = document.getElementById('tool')!;
  private readonly howEl = document.getElementById('how')!;
  private readonly clockEl = document.getElementById('clock')!;
  private readonly feedEl = document.getElementById('feed')!;
  private readonly bannerEl = document.getElementById('banner')!;
  private readonly hintEl = document.getElementById('hint')!;
  private readonly crosshair = document.getElementById('crosshair')!;
  private readonly drawEl = document.getElementById('draw')!;
  private readonly hurtEl = document.getElementById('hurt')!;
  private readonly lockEl = document.getElementById('lock')!;
  private readonly minimap = document.getElementById('minimap') as HTMLCanvasElement;
  private readonly mctx = this.minimap.getContext('2d')!;
  private readonly overview = document.createElement('canvas');
  private bannerTimer = 0;
  private hitTimer = 0;

  constructor(land: Land) {
    const n = Land.samples;
    this.overview.width = this.overview.height = n;
    this.overview.getContext('2d')!.putImageData(new ImageData(land.overviewPixels(), n, n), 0, 0);
  }

  show(): void {
    this.root.hidden = false;
  }

  /** Desktop: whether the "click to play" prompt shows (pointer not captured). */
  setLocked(locked: boolean, vr: boolean): void {
    this.lockEl.hidden = locked || vr;
    this.crosshair.hidden = vr;
  }

  /** A survivor's status, the hint for what's around them and how to use what's in hand, worded for the platform. */
  showSurvivor(sim: SurvivorRole, day: number, vr: boolean): void {
    const s = sim.me?.state;
    if (!s) return;
    this.set('hp', Math.round(s.hp), () => (this.healthFill.style.width = `${Math.max(0, this.hp)}%`));
    this.set('food', Math.round(s.food), () => (this.foodFill.style.width = `${Math.max(0, this.food)}%`));
    this.set('clock', timeName(day), () => (this.clockEl.textContent = this.clock));
    this.drawEl.style.transform = `scaleX(${s.draw})`;
    this.drawEl.hidden = s.draw <= 0;

    let hint = '';
    if (s.hp <= 0) hint = '';
    else if (sim.nearRipe) hint = vr ? 'A carrot is ripe: reach down and grab it' : 'A carrot is ripe: press E to pull it';
    else if (s.food < 20) hint = 'You are starving. Eat something!';
    else if (sim.cold) hint = 'It is freezing out here. Build a fire.';
    this.set('hint', hint, () => (this.hintEl.textContent = this.hint));

    // tracked hands may hold nothing, where a crosshair always has something out
    const holding = !vr || s.tool !== NO_TOOL || s.ltool !== NO_TOOL;
    const tool = s.hp > 0 && holding ? sim.inventory.current : null;
    const charges = tool ? sim.inventory.charges(tool) : 0;
    const text = !tool ? '' : Number.isFinite(charges) ? `${tool.name}  ${charges}` : tool.name;
    const how = tool && !vr ? (HOW.get(tool)?.[0] ?? '') : '';
    if (text !== this.toolText) this.toolEl.textContent = this.toolText = text;
    if (how !== this.toolHow) this.howEl.textContent = this.toolHow = how;
  }

  /** How to use a tool in tracked hands, for a headset's hint. */
  static vrHow(tool: WildTool): string {
    return HOW.get(tool)?.[1] ?? '';
  }

  private set<K extends 'hp' | 'food' | 'clock' | 'hint'>(key: K, value: this[K], apply: () => void): void {
    if (this[key] === value) return;
    this[key] = value;
    apply();
    this.version++;
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

  hitMarker(): void {
    this.crosshair.classList.remove('hit');
    void this.crosshair.offsetWidth; // restart the animation
    this.crosshair.classList.add('hit');
    clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => this.crosshair.classList.remove('hit'), 180);
  }

  hurt(): void {
    this.hurtEl.classList.remove('show');
    void this.hurtEl.offsetWidth;
    this.hurtEl.classList.add('show');
  }

  /** Expire feed lines and banners. */
  tick(now: number): void {
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
  }

  updateMinimap(cx: number, cy: number, heading: number, dots: MapDot[]): void {
    this.drawMinimap(this.mctx, this.minimap.width, cx, cy, heading, dots);
  }

  /** Heading-up circular map centred on (cx, cy). */
  drawMinimap(ctx: CanvasRenderingContext2D, size: number, cx: number, cy: number, heading: number, dots: MapDot[], viewRadius = 90): void {
    const scale = size / (viewRadius * 2);
    const half = size / 2;
    ctx.save();
    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#16324a';
    ctx.fillRect(0, 0, size, size);
    ctx.translate(half, half);
    ctx.rotate(-(heading + Math.PI / 2));
    ctx.imageSmoothingEnabled = true;
    const n = Land.samples;
    ctx.drawImage(this.overview, -cx * scale - (GRID * scale) / 2, -cy * scale - (GRID * scale) / 2, n * GRID * scale, n * GRID * scale);
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

/** What the map shows: other survivors, game and wolves, fires and ripe crops. */
export function mapDots(ctx: WildsContext): MapDot[] {
  const { world, me, wall } = ctx;
  const dots: MapDot[] = [];
  for (const p of world.all(Plot)) if (ripe(p, wall)) dots.push({ x: p.x, y: p.y, color: '#8dff6a', size: 2 });
  for (const f of world.all(Campfire)) if (f.render.until > wall) dots.push({ x: f.x, y: f.y, color: '#ffa640', size: 3 });
  for (const a of world.all(Animal)) {
    if (a.render.mode === AnimalMode.Dead) continue;
    dots.push({ x: a.x, y: a.y, color: a.render.kind === AnimalKind.Wolf ? '#ff4a4a' : '#e8d3a8', size: a.render.kind === AnimalKind.Rabbit ? 1.6 : 2.4 });
  }
  for (const s of world.all(Survivor)) if (s !== me && s.render.hp > 0) dots.push({ x: s.x, y: s.y, color: '#4fc3ff', size: 4 });
  for (const f of world.peerFoci()) dots.push({ x: f.x, y: f.y, color: 'rgba(79,195,255,0.6)', size: 3 });
  return dots;
}
