import { HudBase } from '../crossplay/hud';
import type { Inventory } from '../crossplay/inventory';
import { drawMinimap, type MinimapBase, type MinimapDot } from '../crossplay/minimap';
import { NO_TOOL } from '../crossplay/tool';
import { timeName } from './clock';
import type { WildsContext } from './context';
import { Animal, AnimalKind, AnimalMode, Campfire, Plot, Survivor } from './defs';
import { ripe } from './homestead';
import { ARROWS, AXE, BOW, CARROT, COOKED_MEAT, HOE, RAW_MEAT, SEEDS, WOOD, type WildTool } from './kit';
import { GRID, Land } from './land';
import type { Survivor as SurvivorRole } from './survivor';

/** How to use each tool on a crosshair, and with tracked hands. */
const HOW: Map<WildTool, [desktop: string, vr: string]> = new Map([
  [AXE, ['Click to chop trees and strike. C to crouch and sneak up on animals', 'Swing it into a trunk, an animal or a survivor. Crouch to sneak up on animals']],
  [BOW, ['Hold click to draw, let go to shoot', 'Grab an arrow over your right shoulder and draw it back from the bow']],
  [ARROWS, ['Take out the bow to shoot these', 'Touch the bow with the arrow, hold the trigger, pull back, let go']],
  [HOE, ['Click the ground to till a plot, or click to strike', 'Chop it down into the ground to till a plot, or swing it to strike']],
  [SEEDS, ['Click tilled soil to sow', 'Reach down to a tilled plot and pull the trigger']],
  [CARROT, ['Click to eat', 'Hold it to your mouth']],
  [RAW_MEAT, ['Hold click by a fire to cook, click to eat raw', 'Hold it over a fire to cook, or to your mouth to eat raw']],
  [COOKED_MEAT, ['Click to eat', 'Hold it to your mouth']],
  [WOOD, ['Click the ground to build a fire (3 logs), or a fire to stoke it', 'Set it on the ground to build a fire, or on a fire to stoke it']],
]);

/**
 * Status and announcements (see crossplay/hud.ts). A headset paints the same state onto panels in the scene
 * (wrist.ts).
 */
export class Hud extends HudBase {
  hp = 100;
  food = 100;
  toolText = '';
  toolHow = '';
  clock = '';
  /** Whether the pack is open (desktop). */
  packOpen = false;

  private readonly healthFill = document.getElementById('health-fill')!;
  private readonly foodFill = document.getElementById('food-fill')!;
  private readonly toolEl = document.getElementById('tool')!;
  private readonly howEl = document.getElementById('how')!;
  private readonly clockEl = document.getElementById('clock')!;
  private readonly drawEl = document.getElementById('draw')!;
  private readonly packEl = document.getElementById('pack')!;
  private readonly packHandEl = document.getElementById('pack-hand')!;
  private readonly packStowedEl = document.getElementById('pack-stowed')!;
  private readonly minimap = document.getElementById('minimap') as HTMLCanvasElement;
  private readonly mctx = this.minimap.getContext('2d')!;
  private readonly map: MinimapBase;

  constructor(land: Land) {
    super();
    const n = Land.samples;
    const overview = document.createElement('canvas');
    overview.width = overview.height = n;
    overview.getContext('2d')!.putImageData(new ImageData(land.overviewPixels(), n, n), 0, 0);
    // each overview pixel is a land sample, centred on its grid point
    this.map = { image: overview, x: -GRID / 2, y: -GRID / 2, w: n * GRID, h: n * GRID, background: '#16324a', smooth: true };
  }

  /** Not while the pack is open: the mouse is free for it. */
  protected override showCursor(): void {
    super.showCursor();
    if (!this.packOpen) return;
    if (this.lockEl) this.lockEl.hidden = true;
    if (this.crosshairEl) this.crosshairEl.hidden = true;
  }

  /**
   * Open or close the pack: two grids of what you carry, one to hand and one stowed, where clicking a kind
   * moves it between them. Everything in there is carried either way; the pack is just what's out of the way.
   */
  setPack(inventory: Inventory<WildTool> | null): void {
    this.packOpen = !!inventory;
    this.packEl.hidden = !inventory;
    if (inventory) this.drawPack(inventory);
    this.showCursor();
  }

  private drawPack(inventory: Inventory<WildTool>): void {
    const fill = (el: HTMLElement, tools: WildTool[], empty: string, move: (tool: WildTool) => void): void => {
      el.textContent = '';
      if (!tools.length) {
        const none = document.createElement('div');
        none.className = 'pack-empty';
        none.textContent = empty;
        el.appendChild(none);
        return;
      }
      for (const tool of tools) {
        const charges = inventory.charges(tool);
        const slot = document.createElement('button');
        slot.className = 'pack-slot';
        slot.style.color = `#${tool.color.toString(16).padStart(6, '0')}`;
        const name = document.createElement('b');
        name.textContent = tool.name;
        const count = document.createElement('span');
        count.textContent = Number.isFinite(charges) ? `${charges} ${tool.charges?.unit ?? ''}`.trim() : 'always to hand';
        slot.append(name, count);
        slot.addEventListener('click', () => {
          move(tool);
          this.drawPack(inventory);
        });
        el.appendChild(slot);
      }
    };
    fill(this.packHandEl, inventory.toHand(), 'Nothing to hand', (tool) => {
      if (!inventory.stow(tool)) this.message(`The ${tool.name.toLowerCase()} stays to hand`);
    });
    fill(this.packStowedEl, inventory.packed(), 'The pack is empty', (tool) => {
      inventory.takeOut(tool);
      inventory.select(tool);
    });
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
    this.setHint(hint);

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

  updateMinimap(cx: number, cy: number, heading: number, dots: MinimapDot[]): void {
    this.drawMinimap(this.mctx, this.minimap.width, cx, cy, heading, dots);
  }

  /** Heading-up circular map centred on (cx, cy). */
  drawMinimap(ctx: CanvasRenderingContext2D, size: number, cx: number, cy: number, heading: number, dots: MinimapDot[], viewRadius = 90): void {
    drawMinimap(ctx, size, this.map, cx, cy, heading, dots, viewRadius);
  }
}

/** What the map shows: other survivors, game and wolves, fires and ripe crops. */
export function mapDots(ctx: WildsContext): MinimapDot[] {
  const { world, me, wall } = ctx;
  const dots: MinimapDot[] = [];
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
