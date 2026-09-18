import type { LootEntity, SewerContext } from './context';
import { Feed, Goblin, GoblinMode, Lord, LordMode, Loot, LootKind, LootWhere, Noise, Phase, Sound } from './defs';
import { alive } from './goblins';
import type { Spot } from './sewer';

export interface LootSpec {
  name: string;
  /** What it banks for. */
  worth: number;
}

export const LOOT: Record<LootKind, LootSpec> = {
  [LootKind.Coins]: { name: 'a fistful of coins', worth: 10 },
  [LootKind.Ring]: { name: 'a gold ring', worth: 25 },
  [LootKind.Watch]: { name: 'a pocket watch', worth: 40 },
  [LootKind.Teeth]: { name: 'somebody’s gold teeth', worth: 15 },
  [LootKind.Gem]: { name: 'a fat gemstone', worth: 60 },
  [LootKind.Crown]: { name: 'a crown', worth: 150 },
  [LootKind.Toilet]: { name: 'THE GOLDEN TOILET', worth: 250 },
};

/** How many things a sack holds. */
export const SACK_MAX = 4;
/** How loot's carried: on a Lord's back, or held up over a goblin's head. */
const BACK = 1.15;
const OVERHEAD = 1.4;

/** What's buried in the silt, by how likely each is. */
const BURIED: [LootKind, number][] = [
  [LootKind.Coins, 0.34],
  [LootKind.Teeth, 0.16],
  [LootKind.Ring, 0.2],
  [LootKind.Watch, 0.18],
  [LootKind.Gem, 0.12],
];

export function buriedKind(r: number): LootKind {
  for (const [kind, p] of BURIED) {
    if (r < p) return kind;
    r -= p;
  }
  return LootKind.Coins;
}

/** Channel spots to bury `count` things in for a dive, spread out: each next one furthest from those already picked. */
export function pickBurials(spots: readonly Spot[], count: number, rnd: () => number = Math.random): Spot[] {
  if (!spots.length) return [];
  const picked: Spot[] = [spots[Math.floor(rnd() * spots.length)]];
  while (picked.length < Math.min(count, spots.length)) {
    let best: Spot | null = null;
    let bestD = -1;
    for (let n = 0; n < 40; n++) {
      const s = spots[Math.floor(rnd() * spots.length)];
      if (picked.includes(s)) continue;
      const d = Math.min(...picked.map((p) => Math.hypot(p.x - s.x, p.y - s.y)));
      if (d > bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) break;
    picked.push(best);
  }
  return picked;
}

/**
 * Loot this peer owns. Carried loot is owned by its carrier's peer, and goes where they go: on a Lord's back, or over
 * a goblin's head. Should its carrier fall (a Lord bleeding out, a goblin splattered) it drops where it is, and if a
 * goblin gets down a drain with it, it's gone. Loot stuck in the fatberg falls out once the fat round it is blasted
 * away. Loot from a dive that's over is cleared away.
 */
export function updateOwnedLoot(ctx: SewerContext): void {
  const { world, map, plug } = ctx;
  const sewer = ctx.sewer()?.state;
  for (const loot of world.owned(Loot) as ReadonlySet<LootEntity>) {
    const l = loot.state;
    if (!sewer || l.dive !== sewer.dive || sewer.phase === Phase.Gather) {
      world.despawn(loot);
      continue;
    }
    switch (l.where) {
      case LootWhere.Carried: {
        const lord = world.getAs(Lord, l.carrier);
        if (lord) {
          const r = lord.state;
          if (lord !== ctx.me || r.mode === LordMode.Dead || r.mode === LordMode.Surfaced) {
            drop(ctx, loot, l.x, l.y);
            continue;
          }
          // on their back
          l.x = r.x - Math.cos(r.yaw) * 0.3;
          l.y = r.y - Math.sin(r.yaw) * 0.3;
          l.z = map.groundAt(r.x, r.y) + r.z + BACK * (r.head / 1.65);
          continue;
        }
        const goblin = world.getAs(Goblin, l.carrier);
        if (goblin?.render.mode === GoblinMode.Gone) {
          world.despawn(loot);
          continue;
        }
        if (!goblin || goblin.render.mode === GoblinMode.Dead) {
          drop(ctx, loot, goblin?.x ?? l.x, goblin?.y ?? l.y);
          continue;
        }
        l.x = goblin.x;
        l.y = goblin.y;
        l.z = goblin.render.z + OVERHEAD;
        continue;
      }
      case LootWhere.Stuck: {
        const v = plug.frame.toVoxel(l);
        if (plug.chunks.some((c) => c) && plug.around(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) <= 4) {
          drop(ctx, loot, l.x, l.y);
          world.send(Feed, { text: `Something shiny fell out of the fatberg!` }, { to: 'all' });
          world.send(Noise, { kind: Sound.Dig, x: l.x, y: l.y, z: l.z, a: 0 }, { to: 'all' });
        }
        continue;
      }
      case LootWhere.Lying:
        l.z = map.groundAt(l.x, l.y);
        continue;
    }
  }
}

/** Put loot down loose on the bottom where it is. */
export function drop(ctx: SewerContext, loot: LootEntity, x: number, y: number): void {
  const l = loot.state;
  const at = ctx.map.solid(Math.floor(x), Math.floor(y)) ? ctx.map.nearestOpen(x, y) : { x, y };
  Object.assign(l, { where: LootWhere.Lying, carrier: 0, x: at.x, y: at.y, z: ctx.map.groundAt(at.x, at.y) });
  if (loot.held) ctx.world.release(loot);
}

/** A goblin grabbed loot out of a sack: its owner (the Lord's peer) hands it over, if it's still in there. */
export function snatched(ctx: SewerContext, loot: LootEntity, goblin: number): void {
  const l = loot.state;
  const lord = ctx.world.getAs(Lord, l.carrier);
  const g = ctx.world.getAs(Goblin, goblin);
  if (l.where !== LootWhere.Carried || !lord || !g || !alive(g.render.mode) || g.render.mode === GoblinMode.Held) return;
  l.carrier = goblin;
  ctx.world.send(Feed, { text: `A goblin snatched ${LOOT[l.kind].name} from ${lord.render.name}!` }, { to: 'all' });
}
