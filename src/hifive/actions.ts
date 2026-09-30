import type { PayloadOf } from '@engine/index';
import { Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import { buddyHeard } from './buddies';
import type { HiContext } from './context';
import { Five, Slap } from './defs';
import { Grade, clean } from './moves';
import type { PalRole } from './pal';
import { partnerById } from './partners';

export type FiveEvent = PayloadOf<typeof Five>;
export type SlapEvent = PayloadOf<typeof Slap>;

/** How a five or a slap is shown to everyone who sees it (effects, sounds). */
export interface Shows {
  five(e: FiveEvent): void;
  slap(e: SlapEvent): void;
}

/** Two reports of the same five (both hands saw it) closer than this are one, ms. */
const SAME_MS = 350;

/**
 * Fives and slaps as everyone hears them. Every peer keeps the pair's combo and shows it; the two involved each score
 * their own share on their own peer; a buddy's peer makes it react; and your own offer comes down once it's been hit.
 */
export function registerActions(ctx: HiContext, role: PalRole, shows: Shows): void {
  const { world, pairs, hud } = ctx;

  world.onAction(Five, (e) => {
    const now = ctx.now;
    if (pairs.recent(e.a, e.b, now, SAME_MS)) return;
    pairs.set(e.a, e.b, { streak: e.streak, at: now, move: e.move });
    shows.five(e);
    buddyHeard(ctx, e.b, clean(e.grade));
    const me = ctx.me;
    if (!me || (e.a !== me.id && e.b !== me.id)) return;
    const s = me.state;
    const swung = e.a === me.id;
    const other = partnerById(world, swung ? e.b : e.a)?.name ?? 'Someone';
    const gets = clean(e.grade) || e.grade === Grade.Awkward || (e.grade === Grade.TooSlow && !swung) ? e.points : 0;
    s.score += gets;
    if (clean(e.grade)) s.best = Math.max(s.best, e.streak);
    if (!swung && clean(e.grade)) {
      role.offerTaken();
      role.body.smacked(role.body.platform === Platform.Vr ? (s.offerLeft ? Side.Left : Side.Right) : null, e.grade === Grade.Perfect ? 1 : 0.6);
    }
    hud.fiveNews(e, swung, other, gets);
  });

  world.onAction(Slap, (e) => {
    shows.slap(e);
    buddyHeard(ctx, e.b, !e.denied);
    const me = ctx.me;
    if (!me || (e.a !== me.id && e.b !== me.id)) return;
    const slapper = e.a === me.id;
    const other = partnerById(world, slapper ? e.b : e.a);
    const gets = slapper !== e.denied ? e.points : 0;
    me.state.score += gets;
    if (!slapper && !e.denied) {
      if (other) role.stumble(other.x, other.y);
      role.body.smacked(null, 1);
    }
    hud.slapNews(e, slapper, other?.name ?? 'Someone', gets);
  });
}
