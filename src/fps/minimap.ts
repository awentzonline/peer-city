import type { GameContext } from './context';
import { Car, CarKind, CarMode, Ped, PedMode, Pickup, PickupKind, Player } from './defs';
import type { MinimapDot } from './hud';

/** What the minimap shows, gathered ten times a second for whichever HUD draws it. */
export class MinimapFeed {
  dots: MinimapDot[] = [];
  /** The dots were gathered this frame. */
  fresh = false;
  private next = 0;

  constructor(private readonly ctx: GameContext) {}

  update(): void {
    const { now } = this.ctx;
    this.fresh = now >= this.next;
    if (!this.fresh) return;
    this.next = now + 100;
    this.dots = this.gather();
  }

  private gather(): MinimapDot[] {
    const { world, me, now } = this.ctx;
    const dots: MinimapDot[] = [];
    const flash = Math.floor(now / 250) % 2 ? '#ff3b3b' : '#3b7bff';
    for (const c of world.all(Car)) {
      if (c.state.kind === CarKind.Police && c.state.mode === CarMode.Chase) dots.push({ x: c.x, y: c.y, color: flash, size: 3 });
    }
    for (const p of world.all(Ped)) if (p.state.cop && p.state.mode === PedMode.Attack) dots.push({ x: p.x, y: p.y, color: flash, size: 2 });
    for (const p of world.all(Pickup)) dots.push({ x: p.x, y: p.y, color: p.state.kind === PickupKind.Tool ? '#ffb74a' : '#6eff7a', size: 2 });
    for (const p of world.all(Player)) if (p !== me && p.state.hp > 0) dots.push({ x: p.x, y: p.y, color: '#4fc3ff', size: 4 });
    // peers we're connected to but whose avatars are out of range still show at the rim
    for (const f of world.peerFoci()) dots.push({ x: f.x, y: f.y, color: 'rgba(79,195,255,0.6)', size: 3 });
    return dots;
  }
}
