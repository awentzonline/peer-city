import { seenByOthers, spawnShare } from '../crossplay/spawning';
import { TOOLS } from './arsenal';
import { TILE } from './city';
import type { GameContext } from './context';
import { Car, CarKind, CarMode, Ped, PedMode, Pickup, PickupKind, Player } from './defs';
import { spawnOfficer } from './police';
import { CAR_COLORS, PED_SKINS } from './specs';

const PED_TARGET = 26;
const CAR_TARGET = 13;
const PARKED_TARGET = 8;
const TOOL_TARGET = 6;
/** Tools that turn up in the streets: everything that isn't issued. */
const LOOT = TOOLS.all.filter((t) => t.issued === 0);

/**
 * Keeps the neighbourhood around the local player populated.
 *
 * There's no server to decide who spawns NPCs, so every peer spawns around its
 * own focus using only what it can see. Spawn chance is divided by the number
 * of players nearby so the total rate stays constant however many peers share
 * an area; the engine's cullDistance removes NPCs nobody can see, and
 * rebalancing moves ownership to the regional authority.
 */
export class Spawner {
  private next = 0;

  constructor(private readonly ctx: GameContext) {}

  update(): void {
    const { ctx } = this;
    if (ctx.now < this.next || !ctx.me) return;
    this.next = ctx.now + 600;
    const { world, city } = ctx;
    const focus = world.focus;
    if (!focus) return;

    const share = spawnShare(world, focus.x, focus.y, 85, Player);

    let peds = 0;
    for (const p of world.query(focus.x, focus.y, 110, Ped)) if (p.state.mode !== PedMode.Dead) peds++;
    for (let i = 0; i < 2 && peds < PED_TARGET; i++) {
      if (Math.random() > share) continue;
      const pt = city.randomWalkableNear(focus.x, focus.y, 60, 110);
      if (!pt || this.seen(pt.x, pt.y)) continue;
      world.spawn(Ped, {
        x: pt.x,
        y: pt.y,
        skin: Math.floor(Math.random() * PED_SKINS),
        tx: Math.floor(pt.x / TILE),
        ty: Math.floor(pt.y / TILE),
        mode: PedMode.Walk,
      });
      peds++;
    }

    let moving = 0;
    let parked = 0;
    for (const c of world.query(focus.x, focus.y, 120, Car)) {
      if (c.state.mode === CarMode.Traffic) moving++;
      else if (c.state.mode === CarMode.Parked) parked++;
    }
    if (moving < CAR_TARGET && Math.random() < share) {
      const spot = city.randomLaneNear(focus.x, focus.y, 70, 115);
      if (spot && !this.seen(spot.x, spot.y) && world.count(spot.x, spot.y, 8, Car) === 0) {
        const roll = Math.random();
        const kind = roll < 0.58 ? CarKind.Sedan : roll < 0.72 ? CarKind.Taxi : roll < 0.84 ? CarKind.Sport : roll < 0.95 ? CarKind.Van : CarKind.Police;
        world.spawn(Car, {
          x: spot.x,
          y: spot.y,
          angle: (spot.dir * Math.PI) / 2,
          speed: 9,
          kind,
          color: Math.floor(Math.random() * CAR_COLORS.length),
          mode: CarMode.Traffic,
          dir: spot.dir,
          ri: spot.ri,
          ni: spot.ni,
          nd: 255,
        });
      }
    }
    if (parked < PARKED_TARGET && Math.random() < share * 0.5 && city.parking.length) {
      const spot = city.parking[Math.floor(Math.random() * city.parking.length)];
      const d = Math.hypot(spot.x - focus.x, spot.y - focus.y);
      if (d > 60 && d < 115 && !this.seen(spot.x, spot.y) && world.count(spot.x, spot.y, 4, Car) === 0) {
        world.spawn(Car, {
          x: spot.x,
          y: spot.y,
          angle: spot.angle + (Math.random() < 0.5 ? Math.PI : 0),
          kind: Math.random() < 0.2 ? CarKind.Sport : CarKind.Sedan,
          color: Math.floor(Math.random() * CAR_COLORS.length),
          mode: CarMode.Parked,
        });
      }
    }

    let tools = 0;
    for (const p of world.query(focus.x, focus.y, 120, Pickup)) if (p.state.kind === PickupKind.Tool) tools++;
    if (tools < TOOL_TARGET && LOOT.length && Math.random() < share * 0.35) {
      const pt = city.randomWalkableNear(focus.x, focus.y, 45, 110);
      if (pt && !this.seen(pt.x, pt.y)) {
        const tool = LOOT[Math.floor(Math.random() * LOOT.length)];
        world.spawn(Pickup, { x: pt.x, y: pt.y, kind: PickupKind.Tool, tool: tool.id, amount: tool.charges?.pickup ?? 0 });
      }
    }

    this.spawnPolice();
  }

  /** Police respond to the local player's wanted level. */
  private spawnPolice(): void {
    const { ctx } = this;
    const me = ctx.me!;
    const wanted = me.state.wanted;
    if (wanted === 0 || me.state.hp === 0) return;
    // a unit is a patrol car, or the pair of officers it drops off
    let units = 0;
    for (const c of ctx.world.all(Car)) if (c.state.mode === CarMode.Chase && c.state.target === me.id) units++;
    let officers = 0;
    for (const p of ctx.world.query(me.state.x, me.state.y, 80, Ped)) {
      if (p.state.cop && p.state.mode === PedMode.Attack && p.state.target === me.id) officers++;
    }
    units += Math.ceil(officers / 2);
    if (units >= Math.min(4, wanted)) return;

    // Suspects on foot sometimes get a pair of officers coming round the corner instead of a car.
    const spot = me.state.car === 0 && Math.random() < 0.3 ? null : ctx.city.randomLaneNear(me.state.x, me.state.y, 60, 90);
    if (!spot) {
      if (me.state.car !== 0) return;
      const pt = ctx.city.randomWalkableNear(me.state.x, me.state.y, 50, 80);
      if (!pt) return;
      spawnOfficer(ctx, pt.x, pt.y, me.id);
      spawnOfficer(ctx, pt.x + (Math.random() - 0.5) * 3, pt.y + (Math.random() - 0.5) * 3, me.id);
      return;
    }
    ctx.world.spawn(Car, {
      x: spot.x,
      y: spot.y,
      angle: (spot.dir * Math.PI) / 2,
      kind: CarKind.Police,
      mode: CarMode.Chase,
      target: me.id,
      siren: true,
      speed: 14,
    });
  }

  private seen(x: number, y: number): boolean {
    return seenByOthers(this.ctx.world, x, y, 55);
  }
}
