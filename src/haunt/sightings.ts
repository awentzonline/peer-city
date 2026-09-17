import type { HauntContext, SurvivorEntity } from './context';
import { Monster, MonsterMode, Survivor, SurvivorMode } from './defs';
import { conspicuous, monsterSees } from './monsters';

/** How often who's in sight is worked out again, ms. */
const EVERY_MS = 200;

/**
 * Which survivors the Haunt knows the whereabouts of. It looks down on the whole house, but survivors creeping about in
 * the dark don't show: only those who give themselves away do. A light on, a key glowing in hand or crying out on the
 * floor, being seen by one of the monsters, or flinching at a whisper for a few seconds.
 *
 * Every peer works this out from what it receives, so it's no secret from a determined cheat with developer tools; it's
 * what the Haunt's screen shows, not what the network withholds.
 */
export class Sightings {
  private readonly until = new Map<number, number>();
  private readonly shown = new Set<number>();
  private next = 0;

  /** Give away where a survivor is for `ms`. */
  reveal(id: number, ms: number, now: number): void {
    this.until.set(id, Math.max(this.until.get(id) ?? 0, now + ms));
  }

  /** Whether the Haunt can see where a survivor is. */
  shows(sv: SurvivorEntity): boolean {
    return this.shown.has(sv.id);
  }

  /** How many are showing. */
  get count(): number {
    return this.shown.size;
  }

  update(ctx: HauntContext): void {
    if (ctx.now < this.next) return;
    this.next = ctx.now + EVERY_MS;
    const { world, manor, now } = ctx;
    this.shown.clear();
    for (const sv of world.all(Survivor) as ReadonlySet<SurvivorEntity>) {
      const s = sv.render;
      let show = s.mode !== SurvivorMode.Alive || conspicuous(s) || (this.until.get(sv.id) ?? 0) > now;
      if (!show) {
        for (const m of world.query(sv.x, sv.y, 20, Monster)) {
          if (m.render.mode !== MonsterMode.Dead && monsterSees(manor, m, sv)) {
            show = true;
            break;
          }
        }
      }
      if (show) this.shown.add(sv.id);
    }
    for (const [id, t] of this.until) if (t <= now) this.until.delete(id);
  }
}
