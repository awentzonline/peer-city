import { Avatar, RADIUS, type AvatarBody, type AvatarFrontend } from '../crossplay/avatar';
import { Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Role } from '../crossplay/role';
import type { WallsContext, PainterEntity } from './context';
import { Painter as PainterDef } from './defs';
import type { WallsIntent } from './intent';
import { SIZES, SPRAY_CAN, TOOLS, noAim, type PaintAim, type PaintTool } from './kit';
import { PALETTE, collide, spawnPoint } from './yard';

export type PainterFrontend = AvatarFrontend<WallsIntent>;

const NO_BODY: AvatarBody = {
  platform: Platform.Desktop,
  moved() {},
  placed() {},
  hurt() {},
  used() {},
  died() {},
};

/**
 * The player in Peer Walls: an avatar walking the yard with a spray can, a marker and a roller, and a colour
 * loaded in all three. Only sees an intent, and reaches the device through `body`.
 */
export class Painter extends Avatar<WallsIntent, AvatarBody, PaintTool> implements Role<WallsIntent, PainterFrontend> {
  body: AvatarBody = NO_BODY;
  /** Place on the rack of the colour loaded. */
  colorIndex = 0;
  /** 0..SIZES-1: the cap, nib or roller width. */
  size = 1;
  /** What each hand's tool is pointing at: the crosshair's, or a tracked hand's by `Side`. */
  readonly aims: [PaintAim, PaintAim] = [noAim(), noAim()];
  /** Whether each hand's spray can is spraying this frame. */
  readonly spraying: [boolean, boolean] = [false, false];

  constructor(readonly ctx: WallsContext) {
    super(TOOLS);
  }

  get me(): PainterEntity | null {
    return this.ctx.me;
  }

  get now(): number {
    return this.ctx.now;
  }

  /** 0xRRGGBB loaded in the tools. */
  get color(): number {
    return PALETTE[this.colorIndex].rgb;
  }

  /** The tool out on a crosshair. */
  get tool(): PaintTool | null {
    return this.inventory.current;
  }

  aimFor(side: Side | null): PaintAim {
    return this.aims[side ?? 0];
  }

  protected override move(p: { x: number; y: number }, dx: number, dy: number): void {
    p.x += dx;
    p.y += dy;
    collide(p, RADIUS);
  }

  protected override switchedTool(): void {
    this.ctx.sfx.play('switch');
  }

  /** Into the yard, by the gate. */
  spawn(): void {
    const { ctx } = this;
    const at = spawnPoint();
    this.colorIndex = Math.floor(Math.random() * (PALETTE.length - 1));
    ctx.me = ctx.world.spawn(PainterDef, { x: at.x, y: at.y, yaw: at.heading, name: ctx.playerName, skin: Math.floor(Math.random() * 30), color: this.color, cap: this.size });
    this.inventory.select(SPRAY_CAN);
    this.heading = at.heading;
    ctx.world.setFocus(at.x, at.y);
  }

  update(dt: number, intent: WallsIntent): void {
    const { ctx } = this;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    this.begin(intent);
    if (intent.head) this.walkTracked(dt, intent.head, intent, true);
    else this.walk(dt, intent);

    this.choose(intent);
    for (const aim of this.aims) Object.assign(aim, noAim());
    this.spraying[0] = this.spraying[1] = false;
    if (intent.hands) this.useHands(intent.hands, dt);
    else this.useCrosshair(intent, dt);

    s.color = this.color;
    s.cap = this.size;
    s.spraying = this.spraying[Side.Right];
    s.lspraying = this.spraying[Side.Left];
    ctx.world.setFocus(s.x, s.y);
  }

  private choose(intent: WallsIntent): void {
    const n = PALETTE.length;
    if (intent.color !== null) this.pickColor(intent.color);
    if (intent.cycleColor) this.pickColor((this.colorIndex + intent.cycleColor + n) % n);
    if (intent.cycleSize) {
      this.size = (this.size + intent.cycleSize + SIZES) % SIZES;
      this.ctx.sfx.play('click');
    }
  }

  /** Load a colour into every tool. */
  pickColor(index: number): void {
    if (index < 0 || index >= PALETTE.length || index === this.colorIndex) return;
    this.colorIndex = index;
    this.ctx.sfx.play('rattle');
  }

  /** What the tool in a hand (or on the crosshair) is called at its current size. */
  sizeName(tool: PaintTool | null = this.tool): string {
    return tool ? tool.spec.sizes[this.size] : '';
  }
}
