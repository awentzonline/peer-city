import { Platform } from '../crossplay/platform';
import { NO_TOOL } from '../crossplay/tool';
import type { HauntContext, KeyEntity } from './context';
import { Key, Phase, Survivor, SurvivorMode } from './defs';
import type { Manor, Spot } from './manor';

/** How high a key lies off the floor, and is carried. */
export const KEY_FLOOR = 0.3;

/**
 * Keys this peer owns. A carried key's owner is the carrier's peer (they asked for it when they walked over it), and it
 * goes where their hand is. If its carrier lets go of it (downed, out, gone) it drops where it is and goes back to
 * being anyone's to look after. Keys from a night that's over are cleared away.
 */
export function updateOwnedKeys(ctx: HauntContext): void {
  const { world } = ctx;
  const round = ctx.round()?.state;
  for (const key of world.owned(Key) as ReadonlySet<KeyEntity>) {
    const k = key.state;
    if (round && (k.round !== round.round || round.phase === Phase.Waiting)) {
      world.despawn(key);
      continue;
    }
    if (!k.holder) continue;
    const holder = world.getAs(Survivor, k.holder);
    if (holder && holder === ctx.me && holder.state.key === key.id && holder.state.mode === SurvivorMode.Alive) {
      const s = holder.state;
      // in a headset's empty left hand, or held at the side on a crosshair
      const tracked = s.ltool === NO_TOOL && s.platform === Platform.Vr;
      if (tracked) {
        k.x = s.x + s.lhx;
        k.y = s.y + s.lhy;
        k.z = s.lhz;
      } else {
        const side = s.yaw + Math.PI / 2;
        k.x = s.x + Math.cos(s.yaw) * 0.2 + Math.cos(side) * -0.32;
        k.y = s.y + Math.sin(s.yaw) * 0.2 + Math.sin(side) * -0.32;
        k.z = 0.95;
      }
      continue;
    }
    // let go: it falls where it was
    const at = ctx.manor.nearestOpen(k.x, k.y);
    Object.assign(k, { holder: 0, x: at.x, y: at.y, z: KEY_FLOOR });
    world.release(key);
  }
}

/**
 * `count` places to leave keys for a night, spread through the house: from a random first one, each next is the spot
 * furthest from those already picked.
 */
export function pickKeySpots(manor: Manor, count: number, rnd: () => number = Math.random): Spot[] {
  const all = manor.keySpots;
  if (!all.length) return [];
  const picked: Spot[] = [all[Math.floor(rnd() * all.length)]];
  while (picked.length < Math.min(count, all.length)) {
    let best: Spot | null = null;
    let bestD = -1;
    for (const s of all) {
      if (picked.includes(s)) continue;
      // a little jitter so the same house doesn't always hide them in the same rooms
      const d = Math.min(...picked.map((p) => Math.hypot(p.x - s.x, p.y - s.y))) * (0.75 + rnd() * 0.5);
      if (d > bestD) {
        bestD = d;
        best = s;
      }
    }
    picked.push(best!);
  }
  return picked;
}
