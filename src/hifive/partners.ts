import { defineLocal, type NetWorld } from '@engine/index';
import { EYE } from '../crossplay/avatar';
import { Platform } from '../crossplay/platform';
import type { BuddyEntity, PalEntity, Vec3 } from './context';
import { Buddy, BuddyKind, BuddyMode, Pal } from './defs';
import { Move, REST, buttPoint, offerPose, posePoint } from './moves';

/**
 * Someone you can give five to or slap, pal or buddy, as this peer sees them: where they're drawn, which way they
 * face, and what they're holding out. Built fresh from their rendered state whenever it's needed.
 */
export interface Partner {
  e: PalEntity | BuddyEntity;
  id: number;
  buddy: boolean;
  name: string;
  x: number;
  y: number;
  feet: number;
  heading: number;
  /** Eyes above the feet. */
  eye: number;
  offer: Move;
  offerLeft: boolean;
  /** The move they just pulled away. */
  yank: Move;
  /** Hands they're really moving (a headset player's), rather than posed by the rules. */
  tracked: boolean;
  /** Bits of the hands reaching out (bit 0 right, bit 1 left), and of those made into fists. */
  reach: number;
  fists: number;
  sneak: boolean;
  noSlaps: boolean;
}

export const BUDDY_NAMES: Record<BuddyKind, string> = {
  [BuddyKind.Coach]: 'Coach Palmer',
  [BuddyKind.Lineman]: 'Big Tony',
  [BuddyKind.Mascot]: 'Buzz',
};

/** How tall each buddy stands: eyes above the feet. */
export const BUDDY_EYE: Record<BuddyKind, number> = {
  [BuddyKind.Coach]: 1.62,
  [BuddyKind.Lineman]: 1.82,
  [BuddyKind.Mascot]: 1.7,
};

export function palPartner(e: PalEntity): Partner {
  const r = e.render;
  return {
    e,
    id: e.id,
    buddy: false,
    name: r.name || 'Someone',
    x: e.x,
    y: e.y,
    feet: r.z,
    heading: r.yaw,
    eye: r.head,
    offer: r.offer,
    offerLeft: r.offerLeft,
    yank: r.yank,
    tracked: r.platform === Platform.Vr,
    reach: r.platform === Platform.Vr ? 3 : r.reach,
    fists: r.fists,
    sneak: r.sneak,
    noSlaps: r.noSlaps,
  };
}

export function buddyPartner(e: BuddyEntity): Partner {
  const r = e.render;
  const offering = r.mode === BuddyMode.Offer;
  const offer = offering ? r.offer : Move.None;
  return {
    e,
    id: e.id,
    buddy: true,
    name: BUDDY_NAMES[r.slot] ?? 'Buddy',
    x: e.x,
    y: e.y,
    feet: 0,
    heading: r.angle,
    eye: BUDDY_EYE[r.slot] ?? EYE,
    offer,
    offerLeft: false,
    yank: Move.None,
    tracked: false,
    reach: offer === Move.Double ? 3 : offer ? 1 : 0,
    fists: offer === Move.Fist ? 1 : 0,
    sneak: false,
    noSlaps: false,
  };
}

/** Whoever an id is, as a partner, or null if they've gone. */
export function partnerById(world: NetWorld, id: number): Partner | null {
  const e = world.get(id);
  if (!e) return null;
  if (e.def === Pal) return palPartner(e as PalEntity);
  if (e.def === Buddy) return buddyPartner(e as BuddyEntity);
  return null;
}

/** Everyone within `range` of (x, y) but `except`, nearest first. */
export function partnersNear(world: NetWorld, x: number, y: number, range: number, except: number): Partner[] {
  const out: Partner[] = [];
  for (const e of world.all(Pal) as ReadonlySet<PalEntity>) if (e.id !== except && Math.hypot(e.x - x, e.y - y) <= range) out.push(palPartner(e));
  for (const e of world.all(Buddy) as ReadonlySet<BuddyEntity>) if (e.id !== except && Math.hypot(e.x - x, e.y - y) <= range) out.push(buddyPartner(e));
  return out.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
}

/** Where one of a partner's hands is: a pal's as replicated, a buddy's from its pose. Side 0 right, 1 left. */
export function handOf(p: Partner, side: 0 | 1, out: Vec3): Vec3 {
  if (!p.buddy) {
    const r = (p.e as PalEntity).render;
    out.x = p.x + (side ? r.lhx : r.hx);
    out.y = p.y + (side ? r.lhy : r.hy);
    out.z = p.feet + (side ? r.lhz : r.hz);
    return out;
  }
  const holding = side === 0 ? p.offer !== Move.None : p.offer === Move.Double;
  return posePoint(p.x, p.y, p.feet, p.heading, holding ? offerPose(p.offer, p.eye) : REST, side === 1, out);
}

/** The hands a partner's holding out for a five, by side (both for a double), or none. */
export function offerSides(p: Partner): (0 | 1)[] {
  if (p.offer === Move.None) return [];
  if (p.offer === Move.Double) return [0, 1];
  return [p.offerLeft ? 1 : 0];
}

/** Where to aim a timed swing at a partner's offer: the hand, or between both of a double's. */
export function offerPoint(p: Partner, out: Vec3): Vec3 {
  const sides = offerSides(p);
  if (!sides.length) return handOf(p, p.offerLeft ? 1 : 0, out);
  if (sides.length === 1) return handOf(p, sides[0], out);
  const a = handOf(p, 0, { x: 0, y: 0, z: 0 });
  const b = handOf(p, 1, out);
  out.x = (a.x + b.x) / 2;
  out.y = (a.y + b.y) / 2;
  out.z = (a.z + b.z) / 2;
  return out;
}

export function partnerButt(p: Partner, out: Vec3): Vec3 {
  return buttPoint(p.x, p.y, p.feet, p.heading, out);
}

/**
 * What this peer remembers about someone else's hands between frames: where they were and how fast they were going,
 * to lead a headset hand's aim past the interpolation delay, and where the offer they just pulled away was.
 */
export interface HandTrail {
  at: number;
  pos: [Vec3, Vec3];
  vel: [Vec3, Vec3];
  /** Where their offer's hands were while they held it, for a swing at one just pulled away. */
  offered: Vec3[];
}

export const Trail = defineLocal<HandTrail>(() => ({
  at: 0,
  pos: [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
  ],
  vel: [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
  ],
  offered: [],
}));

/** How far ahead to lead a remote hand, s: about the interpolation delay and half a round trip. */
const LEAD = 0.12;
const MAX_LEAD = 0.3;
const hand = { x: 0, y: 0, z: 0 };

/** Bring a partner's trail up to date: call once a frame for everyone near enough to touch. */
export function followHands(p: Partner, now: number): HandTrail {
  const trail = Trail.of(p.e);
  const dt = (now - trail.at) / 1000;
  for (const side of [0, 1] as const) {
    handOf(p, side, hand);
    const pos = trail.pos[side];
    const vel = trail.vel[side];
    if (trail.at && dt > 0 && dt < 0.25) {
      const k = Math.min(1, dt * 12);
      vel.x += ((hand.x - pos.x) / dt - vel.x) * k;
      vel.y += ((hand.y - pos.y) / dt - vel.y) * k;
      vel.z += ((hand.z - pos.z) / dt - vel.z) * k;
    } else {
      vel.x = vel.y = vel.z = 0;
    }
    pos.x = hand.x;
    pos.y = hand.y;
    pos.z = hand.z;
  }
  trail.at = now;
  const sides = offerSides(p);
  if (sides.length) trail.offered = sides.map((s) => ({ ...trail.pos[s] }));
  else if (p.yank === Move.None) trail.offered = [];
  return trail;
}

/** Where a partner's hand probably is by now, led ahead of where it's drawn by how it's been moving. */
export function leadHand(trail: HandTrail, side: 0 | 1, out: Vec3): Vec3 {
  const pos = trail.pos[side];
  const vel = trail.vel[side];
  let dx = vel.x * LEAD;
  let dy = vel.y * LEAD;
  let dz = vel.z * LEAD;
  const d = Math.hypot(dx, dy, dz);
  if (d > MAX_LEAD) {
    const k = MAX_LEAD / d;
    dx *= k;
    dy *= k;
    dz *= k;
  }
  out.x = pos.x + dx;
  out.y = pos.y + dy;
  out.z = pos.z + dz;
  return out;
}
