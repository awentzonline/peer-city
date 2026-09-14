import type { NetEntity } from '@engine/index';
import type { GameContext } from './context';
import { Car, CarMode, Damage, DamageCause, Ped, PedMode, Player, Shot } from './defs';

export interface BulletOptions {
  range: number;
  /** Damage for a candidate victim; 0 lets the bullet pass through (e.g. no friendly fire). */
  damage: (e: NetEntity) => number;
}

function hitRadius(e: NetEntity): number {
  if (e.def === Ped) return (e.state as { mode: number }).mode !== PedMode.Dead ? 11 : 0;
  if (e.def === Player) {
    const s = e.state as { hp: number; car: number };
    return s.hp > 0 && s.car === 0 ? 11 : 0;
  }
  if (e.def === Car) return (e.state as { mode: number }).mode !== CarMode.Wrecked ? 20 : 0;
  return 0;
}

/**
 * Hit-scan a bullet against walls and whatever this peer can see. Everyone
 * nearby gets a cosmetic Shot; the victim's owner gets the Damage.
 */
export function fireBullet(ctx: GameContext, shooter: NetEntity, ox: number, oy: number, angle: number, opts: BulletOptions): NetEntity | null {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const wall = ctx.city.raycast(ox, oy, angle, opts.range);

  let hit: NetEntity | null = null;
  let hitT = Infinity;
  let hitDamage = 0;
  for (const e of ctx.world.query(ox + (dx * wall) / 2, oy + (dy * wall) / 2, wall / 2 + 40)) {
    if (e === shooter) continue;
    const radius = hitRadius(e);
    if (!radius) continue;
    const t = (e.x - ox) * dx + (e.y - oy) * dy;
    if (t < 0 || t > wall || t >= hitT) continue;
    if (Math.abs(-(e.x - ox) * dy + (e.y - oy) * dx) >= radius) continue;
    const damage = opts.damage(e);
    if (!damage) continue;
    hit = e;
    hitT = t;
    hitDamage = damage;
  }

  ctx.world.send(Shot, { x: ox, y: oy, angle, dist: hit ? hitT : wall, shooter: shooter.id }, { to: 'near', x: ox, y: oy, radius: 1600 });
  if (hit) {
    ctx.world.send(
      Damage,
      { target: hit.id, amount: hitDamage, attacker: shooter.id, cause: DamageCause.Bullet, kx: dx * 60, ky: dy * 60 },
      { to: 'owner', entity: hit },
    );
  }
  return hit;
}
