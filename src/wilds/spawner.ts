import { animalSpec } from './bodies';
import { isNight } from './clock';
import type { WildsContext } from './context';
import { Animal, AnimalKind, AnimalMode, Item, Survivor } from './defs';
import { SEEDS } from './kit';
import { Ground } from './land';

/** How many of each to keep around a survivor. */
const TARGETS: Record<AnimalKind, number> = { [AnimalKind.Deer]: 5, [AnimalKind.Rabbit]: 6, [AnimalKind.Wolf]: 3 };
const WILD_SEEDS = 3;
const RANGE = 115;

const HABITAT: Record<AnimalKind, (g: Ground) => boolean> = {
  [AnimalKind.Deer]: (g) => g === Ground.Grass || g === Ground.Forest,
  [AnimalKind.Rabbit]: (g) => g === Ground.Grass || g === Ground.Sand,
  [AnimalKind.Wolf]: (g) => g === Ground.Forest || g === Ground.Rock,
};

/**
 * Keeps the wild around the local survivor alive: game to hunt, wolves after dark, and wild seeds in the
 * grass. The same serverless trick as Peer City: every peer spawns around its own focus, out of everyone's
 * sight, with its chances divided by the survivors nearby so the population doesn't multiply.
 */
export class Spawner {
  private next = 0;

  constructor(private readonly ctx: WildsContext) {}

  update(): void {
    const { ctx } = this;
    if (ctx.now < this.next || !ctx.me) return;
    this.next = ctx.now + 700;
    const { world, land } = ctx;
    const focus = world.focus;
    if (!focus) return;
    const share = 1 / Math.max(1, world.query(focus.x, focus.y, 90, Survivor).length);

    const counts = [0, 0, 0];
    for (const a of world.query(focus.x, focus.y, RANGE, Animal)) if (a.state.mode !== AnimalMode.Dead) counts[a.state.kind]++;
    const night = isNight(ctx.day);
    for (const kind of [AnimalKind.Deer, AnimalKind.Rabbit, AnimalKind.Wolf]) {
      const want = kind === AnimalKind.Wolf ? (night ? TARGETS[kind] : 0) : TARGETS[kind];
      if (counts[kind] >= want || Math.random() > share * 0.5) continue;
      const spot = land.randomOpen(focus.x, focus.y, kind === AnimalKind.Wolf ? 60 : 45, RANGE, HABITAT[kind]);
      if (!spot || this.visibleToOthers(spot.x, spot.y)) continue;
      const spec = animalSpec(kind);
      world.spawn(Animal, { x: spot.x, y: spot.y, kind, hp: spec.hp, mode: AnimalMode.Graze, tx: spot.x, ty: spot.y, angle: Math.random() * Math.PI * 2 });
    }

    let seeds = 0;
    for (const item of world.query(focus.x, focus.y, RANGE, Item)) if (item.state.tool === SEEDS.id) seeds++;
    if (seeds < WILD_SEEDS && Math.random() < share * 0.15) {
      const spot = land.randomOpen(focus.x, focus.y, 20, RANGE, (g) => g === Ground.Grass);
      if (spot && !this.visibleToOthers(spot.x, spot.y)) world.spawn(Item, { x: spot.x, y: spot.y, tool: SEEDS.id, amount: SEEDS.charges!.pickup });
    }
  }

  private visibleToOthers(x: number, y: number): boolean {
    for (const f of this.ctx.world.peerFoci()) if (Math.hypot(f.x - x, f.y - y) < 40) return true;
    return false;
  }
}
