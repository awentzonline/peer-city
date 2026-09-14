import type { GameContext } from './context';
import { Car, CarKind, CarMode, Ped, PedMode, Player } from './defs';
import { spawnOfficer } from './police';
import { CAR_COLORS, PED_SKINS } from './textures';

const PED_TARGET = 26;
const CAR_TARGET = 13;
const PARKED_TARGET = 8;

/**
 * Keeps the neighbourhood around the local player populated.
 *
 * There's no server to decide who spawns NPCs, so every peer spawns around its
 * own focus using only what it can see (everything within its interest radius
 * is replicated to it). Spawn chance is divided by the number of players nearby
 * so the total rate stays constant however many peers share an area; the
 * engine's cullDistance removes NPCs nobody can see, and rebalancing moves
 * ownership to the regional authority.
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

    const playersNear = world.query(focus.x, focus.y, 900, Player).length;
    const share = 1 / Math.max(1, playersNear);

    let peds = 0;
    for (const p of world.query(focus.x, focus.y, 1050, Ped)) if (p.state.mode !== PedMode.Dead) peds++;
    for (let i = 0; i < 2 && peds < PED_TARGET; i++) {
      if (Math.random() > share) continue;
      const pt = city.randomWalkableNear(focus.x, focus.y, 720, 1050);
      if (!pt || this.visibleToOthers(pt.x, pt.y)) continue;
      world.spawn(Ped, {
        x: pt.x,
        y: pt.y,
        skin: Math.floor(Math.random() * PED_SKINS),
        tx: Math.floor(pt.x / 32),
        ty: Math.floor(pt.y / 32),
        mode: PedMode.Walk,
      });
      peds++;
    }

    let moving = 0;
    let parked = 0;
    for (const c of world.query(focus.x, focus.y, 1150, Car)) {
      if (c.state.mode === CarMode.Traffic) moving++;
      else if (c.state.mode === CarMode.Parked) parked++;
    }
    if (moving < CAR_TARGET && Math.random() < share) {
      const spot = city.randomLaneNear(focus.x, focus.y, 780, 1100);
      if (spot && !this.visibleToOthers(spot.x, spot.y) && world.query(spot.x, spot.y, 90, Car).length === 0) {
        const roll = Math.random();
        const kind = roll < 0.58 ? CarKind.Sedan : roll < 0.72 ? CarKind.Taxi : roll < 0.84 ? CarKind.Sport : roll < 0.95 ? CarKind.Van : CarKind.Police;
        world.spawn(Car, {
          x: spot.x,
          y: spot.y,
          angle: (spot.dir * Math.PI) / 2,
          speed: 100,
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
      if (d > 700 && d < 1100 && !this.visibleToOthers(spot.x, spot.y) && world.query(spot.x, spot.y, 40, Car).length === 0) {
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
    for (const p of ctx.world.query(me.state.x, me.state.y, 800, Ped)) {
      if (p.state.cop && p.state.mode === PedMode.Attack && p.state.target === me.id) officers++;
    }
    units += Math.ceil(officers / 2);
    if (units >= Math.min(4, wanted)) return;

    // Suspects on foot sometimes get a pair of officers coming round the corner instead of a car.
    const spot = me.state.car === 0 && Math.random() < 0.3 ? null : ctx.city.randomLaneNear(me.state.x, me.state.y, 650, 950);
    if (!spot) {
      if (me.state.car !== 0) return;
      const pt = ctx.city.randomWalkableNear(me.state.x, me.state.y, 600, 850);
      if (!pt) return;
      spawnOfficer(ctx, pt.x, pt.y, me.id);
      spawnOfficer(ctx, pt.x + (Math.random() - 0.5) * 30, pt.y + (Math.random() - 0.5) * 30, me.id);
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
      speed: 150,
    });
  }

  private visibleToOthers(x: number, y: number): boolean {
    for (const f of this.ctx.world.peerFoci()) if (Math.hypot(f.x - x, f.y - y) < 680) return true;
    return false;
  }
}
