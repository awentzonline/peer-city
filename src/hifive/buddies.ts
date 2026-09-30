import { Keeper, defineLocal, turnToward, walkMemory, walkToward, type NetEntity, type StateOf, type WalkMemory } from '@engine/index';
import type { BuddyEntity, HiContext, PalEntity, Vec3 } from './context';
import { Buddy, BuddyKind, BuddyMode, Pal, Team } from './defs';
import { tellFive, tellSlap } from './events';
import { strollSpot } from './field';
import { BEHIND, FACING, Grade, MOVES, Move, bearingFrom, buttPoint } from './moves';
import { offerPoint, palPartner } from './partners';

/**
 * The team's buddies: Coach Palmer, Big Tony and Buzz the mascot. They stroll about the locker room and the field,
 * walk up to hold out a five for someone, come over to take anyone's that's held out, and can be slapped from
 * behind (if they don't hear you coming). Buzz also creeps up on people to slap them, loudly enough that anyone
 * paying attention can turn round and deny him. Each is run by whichever peer owns it; the `Team` makes any that
 * are missing.
 */

const STROLL = 1.3;
const HURRY = 2.3;
const CREEP = 1.7;
export const BUDDY_RADIUS = 0.35;
/** How far in front of someone a buddy stands to give or take five. */
const STAND_OFF = 0.95;
const OFFER_MS = 6000;
const SWING_MS = 380;
const SLAP_MS = 700;
const REACT_MS = 900;
const GIVE_UP_MS = 9000;
/** Notices someone offering this far off, and walks up to give five to anyone this near. */
const NOTICE = 8;

export const BUDDY_SLOTS: readonly BuddyKind[] = [BuddyKind.Coach, BuddyKind.Lineman, BuddyKind.Mascot];

const HOMES: Record<BuddyKind, { x: number; y: number }> = {
  [BuddyKind.Coach]: { x: 30, y: 7 },
  [BuddyKind.Lineman]: { x: 24, y: 40 },
  [BuddyKind.Mascot]: { x: 36, y: 44 },
};

type Plan = 'give' | 'take';

interface BuddyLocal extends WalkMemory {
  /** When to look round for something to do next, ms. */
  next: number;
  /** When the current mode's done, ms. */
  until: number;
  /** When it came to this peer, or its mode last changed here, ms. */
  since: number;
  plan: Plan;
  /** Buzz's next prank, ms. */
  prank: number;
  /** Next listen for someone creeping up behind, ms. */
  listen: number;
}

export const BuddyMind = defineLocal<BuddyLocal>(() => ({ ...walkMemory(), next: 0, until: 0, since: 0, plan: 'give', prank: 0, listen: 0 }));

/** Keeps the team whole: whoever runs it makes any buddy that's missing. */
export class TeamKeeper extends Keeper<typeof Team> {
  constructor(private readonly ctx: HiContext) {
    super(ctx.world, Team, { init: () => ({ x: 30, y: 30 }) });
  }

  protected run(_e: NetEntity<StateOf<typeof Team>>): void {
    const { world } = this.ctx;
    const have = new Set<BuddyKind>();
    for (const b of world.all(Buddy) as ReadonlySet<BuddyEntity>) have.add(b.render.slot);
    for (const slot of BUDDY_SLOTS) {
      if (have.has(slot)) continue;
      const home = HOMES[slot];
      world.spawn(Buddy, { x: home.x, y: home.y, slot, mode: BuddyMode.Wander, tx: home.x, ty: home.y, angle: Math.PI / 2 });
    }
  }
}

/** Run the buddies this peer owns. */
export function updateOwnedBuddies(ctx: HiContext, dt: number): void {
  const { world, now } = ctx;
  for (const g of world.owned(Buddy) as ReadonlySet<BuddyEntity>) {
    if (duplicate(ctx, g)) {
      world.despawn(g);
      continue;
    }
    const s = g.state;
    const m = BuddyMind.of(g);
    if (!m.since) {
      m.since = now;
      m.next = now + 1000;
      m.prank = now + 25_000 + Math.random() * 20_000;
      if (s.mode !== BuddyMode.Wander) m.until = now + 1500;
    }
    const target = s.target ? (world.getAs(Pal, s.target) as PalEntity | null) : null;
    switch (s.mode) {
      case BuddyMode.Wander:
        stroll(ctx, g, m, dt);
        if (now >= m.next) think(ctx, g, m);
        break;
      case BuddyMode.Approach:
        approach(ctx, g, m, target, dt);
        break;
      case BuddyMode.Offer:
        if (!target || now >= m.until) setMode(ctx, g, BuddyMode.Wander);
        else if (target.render.offer !== Move.None) {
          // they've held one out for us instead: take theirs
          s.offer = Move.None;
          go(ctx, g, m, target, 'take');
        } else face(g, target.x, target.y, dt, 6);
        break;
      case BuddyMode.Swing:
        if (!target) setMode(ctx, g, BuddyMode.Wander);
        else {
          face(g, target.x, target.y, dt, 10);
          if (now >= m.until) swingAt(ctx, g, target);
        }
        break;
      case BuddyMode.Sneak:
        creep(ctx, g, m, target, dt);
        break;
      case BuddyMode.Slap:
        if (!target) setMode(ctx, g, BuddyMode.Wander);
        else if (now >= m.until) slapAt(ctx, g, target);
        break;
      case BuddyMode.React:
        if (now >= m.until) setMode(ctx, g, BuddyMode.Wander);
        break;
    }
    if (s.mode === BuddyMode.Wander || s.mode === BuddyMode.Offer) hearCreeping(ctx, g, m);
  }
}

/** Two peers made the same buddy at once: the higher id gives way. */
function duplicate(ctx: HiContext, g: BuddyEntity): boolean {
  for (const o of ctx.world.all(Buddy) as ReadonlySet<BuddyEntity>) if (o !== g && o.render.slot === g.state.slot && o.id < g.id) return true;
  return false;
}

export function setMode(ctx: HiContext, g: BuddyEntity, mode: BuddyMode, ms = 0): void {
  const s = g.state;
  const m = BuddyMind.of(g);
  s.mode = mode;
  m.since = ctx.now;
  m.until = ctx.now + ms;
  if (mode === BuddyMode.Wander) {
    s.target = 0;
    s.offer = Move.None;
    m.next = ctx.now + 2500 + Math.random() * 3000;
  }
}

function stroll(ctx: HiContext, g: BuddyEntity, m: BuddyLocal, dt: number): void {
  const s = g.state;
  if (ctx.now < m.restUntil) return;
  if (Math.hypot(s.tx - s.x, s.ty - s.y) < 0.6) {
    m.restUntil = ctx.now + 2000 + Math.random() * 5000;
    const spot = strollSpot();
    s.tx = spot.x;
    s.ty = spot.y;
    return;
  }
  walkToward(ctx.grounds, s, m, s.tx, s.ty, BUDDY_RADIUS, STROLL, dt, ctx.now, true);
}

/** What to do next: take someone's five, go and give someone one, or (Buzz) go creeping. */
function think(ctx: HiContext, g: BuddyEntity, m: BuddyLocal): void {
  const { world, now } = ctx;
  const s = g.state;
  m.next = now + 1200 + Math.random() * 800;
  const pals = [...(world.all(Pal) as ReadonlySet<PalEntity>)].filter((p) => Math.hypot(p.x - s.x, p.y - s.y) < NOTICE);
  const busy = (p: PalEntity) => [...(world.all(Buddy) as ReadonlySet<BuddyEntity>)].some((b) => b !== g && b.render.target === p.id && b.render.mode !== BuddyMode.Wander);
  const offering = pals.find((p) => p.render.offer !== Move.None && !busy(p));
  if (offering && Math.random() < 0.75) {
    go(ctx, g, m, offering, 'take');
    return;
  }
  if (s.slot === BuddyKind.Mascot && now >= m.prank) {
    const mark = [...(world.all(Pal) as ReadonlySet<PalEntity>)].find((p) => !p.render.noSlaps && Math.hypot(p.x - s.x, p.y - s.y) < 16 && !busy(p));
    if (mark) {
      m.prank = now + 40_000 + Math.random() * 30_000;
      s.target = mark.id;
      setMode(ctx, g, BuddyMode.Sneak, 15_000);
      return;
    }
  }
  const idle = pals.filter((p) => p.render.offer === Move.None && !busy(p));
  if (idle.length && Math.random() < 0.3) go(ctx, g, m, idle[Math.floor(Math.random() * idle.length)], 'give');
}

function go(ctx: HiContext, g: BuddyEntity, m: BuddyLocal, p: PalEntity, plan: Plan): void {
  g.state.target = p.id;
  m.plan = plan;
  setMode(ctx, g, BuddyMode.Approach, GIVE_UP_MS);
}

/** Walk up to stand in front of them (to take their five), or between us (to give one: they'll have to turn). */
function approach(ctx: HiContext, g: BuddyEntity, m: BuddyLocal, p: PalEntity | null, dt: number): void {
  const s = g.state;
  if (!p || ctx.now >= m.until || (m.plan === 'take' && p.render.offer === Move.None)) {
    setMode(ctx, g, BuddyMode.Wander);
    return;
  }
  if (m.plan === 'give' && p.render.offer !== Move.None) m.plan = 'take';
  let tx: number;
  let ty: number;
  if (m.plan === 'take') {
    tx = p.x + Math.cos(p.render.yaw) * STAND_OFF;
    ty = p.y + Math.sin(p.render.yaw) * STAND_OFF;
  } else {
    const d = Math.hypot(s.x - p.x, s.y - p.y) || 1;
    tx = p.x + ((s.x - p.x) / d) * (STAND_OFF + 0.15);
    ty = p.y + ((s.y - p.y) / d) * (STAND_OFF + 0.15);
  }
  if (Math.hypot(tx - s.x, ty - s.y) > 0.3) {
    walkToward(ctx.grounds, s, m, tx, ty, BUDDY_RADIUS, HURRY, dt, ctx.now, Math.hypot(tx - s.x, ty - s.y) > 3);
    return;
  }
  face(g, p.x, p.y, dt, 20);
  if (m.plan === 'take') {
    setMode(ctx, g, BuddyMode.Swing, SWING_MS);
  } else {
    s.offer = MOVES[Math.floor(Math.random() * MOVES.length)];
    setMode(ctx, g, BuddyMode.Offer, OFFER_MS);
  }
}

/** Swing at their offer: buddies are good at this, though not perfect, and fall for a pulled-away hand like anyone. */
function swingAt(ctx: HiContext, g: BuddyEntity, p: PalEntity): void {
  const partner = palPartner(p);
  const at: Vec3 = offerPoint(partner, { x: 0, y: 0, z: 0 });
  let grade: Grade;
  let move = partner.offer;
  if (partner.offer === Move.None) {
    move = partner.yank;
    grade = partner.yank !== Move.None ? Grade.TooSlow : Grade.Whiff;
  } else {
    const r = Math.random();
    grade = r < 0.45 ? Grade.Perfect : r < 0.8 ? Grade.Great : Grade.Good;
  }
  if (move !== Move.None) tellFive(ctx, g.id, p.id, move, grade, at, false);
  setMode(ctx, g, BuddyMode.React, REACT_MS);
}

/** Buzz on the prowl: round behind them, then wind up. Caught face to face, he gives up. */
function creep(ctx: HiContext, g: BuddyEntity, m: BuddyLocal, p: PalEntity | null, dt: number): void {
  const s = g.state;
  if (!p || p.render.noSlaps || ctx.now >= m.until) {
    setMode(ctx, g, BuddyMode.Wander);
    return;
  }
  const heading = p.render.yaw;
  const near = Math.hypot(p.x - s.x, p.y - s.y);
  if (near < 3 && bearingFrom(p.x, p.y, heading, s.x, s.y) < FACING) {
    // spotted: act natural
    setMode(ctx, g, BuddyMode.React, REACT_MS * 2);
    return;
  }
  const tx = p.x - Math.cos(heading) * 0.8;
  const ty = p.y - Math.sin(heading) * 0.8;
  if (Math.hypot(tx - s.x, ty - s.y) > 0.3) {
    walkToward(ctx.grounds, s, m, tx, ty, BUDDY_RADIUS, near < 4 ? CREEP : HURRY, dt, ctx.now, near > 3);
    return;
  }
  face(g, p.x, p.y, dt, 20);
  setMode(ctx, g, BuddyMode.Slap, SLAP_MS);
}

function slapAt(ctx: HiContext, g: BuddyEntity, p: PalEntity): void {
  const s = g.state;
  const r = p.render;
  if (!r.noSlaps && Math.hypot(p.x - s.x, p.y - s.y) < 1.8) {
    const denied = bearingFrom(p.x, p.y, r.yaw, s.x, s.y) < FACING;
    tellSlap(ctx, g.id, p.id, denied, buttPoint(p.x, p.y, r.z, r.yaw, { x: 0, y: 0, z: 0 }));
  }
  setMode(ctx, g, BuddyMode.React, REACT_MS);
}

/** Someone standing up behind a buddy gets heard, and it turns round: creep up crouched. */
function hearCreeping(ctx: HiContext, g: BuddyEntity, m: BuddyLocal): void {
  if (ctx.now < m.listen) return;
  m.listen = ctx.now + 250;
  const s = g.state;
  for (const p of ctx.world.all(Pal) as ReadonlySet<PalEntity>) {
    const r = p.render;
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    if (d > 3 || bearingFrom(s.x, s.y, s.angle, p.x, p.y) < BEHIND) continue;
    const chance = r.sneak ? 0.02 : r.windup === g.id ? 0.55 : 0.12;
    if (Math.random() < chance) {
      s.angle = Math.atan2(p.y - s.y, p.x - s.x);
      return;
    }
  }
}

function face(g: BuddyEntity, x: number, y: number, dt: number, rate: number): void {
  const s = g.state;
  turnToward(s, Math.atan2(y - s.y, x - s.x), dt, rate);
}

/** A five or slap involving a buddy this peer runs: it takes the hit, puts its hand down, and reacts. */
export function buddyHeard(ctx: HiContext, b: number, landed: boolean): void {
  const g = ctx.world.getAs(Buddy, b) as BuddyEntity | null;
  if (!g?.mine) return;
  if (landed) setMode(ctx, g, BuddyMode.React, REACT_MS);
}
