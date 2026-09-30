import type { HiContext, Vec3 } from './context';
import { Five, Slap } from './defs';
import { DENY_POINTS, SLAP_POINTS, nextStreak, scoreFor, type Grade, type Move } from './moves';

/**
 * Tell everyone how a five went, decided here by `a`, who swung at `b`: the pair's combo after it and what it's worth
 * come from this peer's memory of their last one (`HiContext.pairs`).
 */
export function tellFive(ctx: HiContext, a: number, b: number, move: Move, grade: Grade, at: Vec3, air: boolean): void {
  const streak = nextStreak(ctx.pairs.get(a, b), ctx.now, move, grade);
  const points = scoreFor(grade, move, streak, air);
  ctx.world.send(Five, { a, b, move, grade, points, streak, air, x: at.x, y: at.y, z: at.z }, { to: 'all' });
}

/** Tell everyone `a` slapped `b`'s backside, or that `b` turned round in time. */
export function tellSlap(ctx: HiContext, a: number, b: number, denied: boolean, at: Vec3): void {
  ctx.world.send(Slap, { a, b, denied, points: denied ? DENY_POINTS : SLAP_POINTS, x: at.x, y: at.y, z: at.z }, { to: 'all' });
}
