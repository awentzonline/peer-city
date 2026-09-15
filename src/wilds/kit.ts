import * as THREE from 'three';
import { Side } from '../crossplay/intent';
import { box, merge, paint } from '../crossplay/models';
import { Tool, Toolbox, type Drop, type PickedUp, type ToolOptions, type ToolUse } from '../crossplay/tool';
import { ARROW_MAX_SPEED, ARROW_MIN_SPEED } from './arrows';
import { bodyAt, sweepBodies } from './bodies';
import { clamp, type AnimalEntity, type SurvivorEntity, type Vec3 } from './context';
import { Animal, AnimalMode, Butcher, Chop, Crop, Damage, Item } from './defs';
import { CHOPS_TO_FELL, FIRE_LOGS, addLogs, buildFire, canBuildFire, fell, fireNear, plotNear, sow, till } from './homestead';
import { ObstacleKind } from './land';
import type { Survivor } from './survivor';

/**
 * Peer Wilds' tools. Every one works on both kinds of hands, and the difference is the point:
 *
 * - A headset's tracked hands do it for real: swing the axe into a trunk, chop the hoe down into the soil,
 *   nock an arrow on the string with one hand and draw it back from the bow in the other, hold food up to
 *   your mouth, hold raw meat over the flames, reach down to press seeds into a plot.
 * - A crosshair does the same things more simply: click to swing or till, hold to draw and let go to shoot,
 *   click to eat, sow or stoke a fire, hold to cook.
 *
 * Both run in the rules, from the same `ToolUse`: `side` says which kind of hand it is, and tracked hands
 * bring their `origin` and `velocity` into it.
 */

export type Use = ToolUse<Survivor>;

const UP = Math.PI / 2;
const DOWN = -Math.PI / 2;

/** A Peer Wilds tool. Picking some up says what you got; ones dropped (when you die) spill onto the ground. */
export class WildTool extends Tool<Survivor> {
  override onPickup(avatar: Survivor, got: PickedUp): void {
    const { hud } = avatar.ctx;
    if (got.charges) hud.message(`+${got.charges} ${this.charges?.unit ?? this.name}`);
    else if (got.kept) hud.message(`Picked up ${this.name.toLowerCase()}`);
  }

  override onDrop(avatar: Survivor, drop: Drop): void {
    if (drop.reason !== 'dropped' || drop.charges <= 0) return;
    avatar.ctx.world.spawn(Item, { x: drop.x, y: drop.y, tool: this.id, amount: Math.min(65535, drop.charges) });
  }
}

/** Per hand scratch for the tools below. */
interface HandState {
  /** Earliest time a tracked swing can land again. */
  next: number;
  draw: number;
  nocked: boolean;
  /** Seconds food has been at your mouth, or meat over a fire. */
  chew: number;
  cook: number;
}

const hands = new WeakMap<Use, HandState>();
function stateOf(use: Use): HandState {
  let s = hands.get(use);
  if (!s) hands.set(use, (s = { next: 0, draw: 0, nocked: false, chew: 0, cook: 0 }));
  return s;
}

function otherHand(use: Use): Use {
  return use.avatar.hand(use.side === Side.Left ? Side.Right : Side.Left) as Use;
}

const point: Vec3 = { x: 0, y: 0, z: 0 };

/** Where a crosshair tool's line of sight meets the ground or an obstacle, within `range`. Null if it meets nothing. */
function sighted(use: Use, range: number): { at: Vec3; obstacle: number } | null {
  const { land } = use.avatar.ctx;
  const { origin: o, aim: d } = use;
  const hit = land.raycast(o.x, o.y, o.z, d.x, d.y, d.z, range);
  if (hit.t >= range) return null;
  point.x = o.x + d.x * hit.t;
  point.y = o.y + d.y * hit.t;
  point.z = o.z + d.z * hit.t;
  return { at: point, obstacle: hit.obstacle };
}

/** How high a point is above the ground under it. */
function aboveGround(use: Use, p: Vec3): number {
  return p.z - use.avatar.ctx.land.heightAt(p.x, p.y);
}

// ---------------------------------------------------------------------------
// Striking bodies with a tool
// ---------------------------------------------------------------------------

type Body = AnimalEntity | SurvivorEntity;

/** How fast a tracked hand must swing a tool, m/s, for it to hit. */
const SWING_SPEED = 3;
/** An animal struck before it notices you (still grazing) takes this many times the damage. */
const SNEAK_ATTACK = 3;

/** The body a crosshair swing within `reach` meets before the ground or a trunk, and where. Carcasses count if `dead`. */
function swungAt(use: Use, reach: number, dead: boolean): { body: Body; at: Vec3 } | null {
  const { ctx } = use.avatar;
  const { origin: o, aim: d } = use;
  const hit = sweepBodies(ctx, o, d, reach, ctx.me!.id, dead);
  if (!hit || ctx.land.raycast(o.x, o.y, o.z, d.x, d.y, d.z, reach).t < hit.t) return null;
  return { body: hit.entity, at: { x: o.x + d.x * hit.t, y: o.y + d.y * hit.t, z: o.z + d.z * hit.t } };
}

/** The body a tracked hand swings its tool's head into, fast enough to hit. Carcasses count if `dead`. */
function swungInto(use: Use, dead: boolean): Body | null {
  const v = use.velocity;
  if (Math.hypot(v.x, v.y, v.z) < SWING_SPEED) return null;
  const { ctx } = use.avatar;
  return bodyAt(ctx, use.origin, 0.2, ctx.me!.id, dead);
}

/**
 * Hit a survivor or an animal with a tool at `at`, knocking them the way it swung. A carcass is carved for
 * meat instead, if the tool `butchers`.
 */
function strike(use: Use, body: Body, at: Vec3, amount: number, butchers = false): void {
  const { ctx } = use.avatar;
  if (body.is(Animal) && body.render.mode === AnimalMode.Dead) {
    if (!butchers) return;
    ctx.world.send(Butcher, { animal: body.id }, { to: 'owner', entity: body });
  } else {
    if (body.is(Animal) && body.render.mode === AnimalMode.Graze) {
      amount *= SNEAK_ATTACK;
      ctx.hud.message('Sneak attack!');
    }
    const v = use.side === null ? use.aim : use.velocity;
    const k = 4 / (Math.hypot(v.x, v.y) || 1);
    ctx.world.send(
      Damage,
      { target: body.id, amount: Math.min(255, Math.round(amount)), attacker: ctx.me!.id, kx: v.x * k, ky: v.y * k },
      { to: 'owner', entity: body },
    );
  }
  ctx.world.send(Chop, { x: at.x, y: at.y, z: at.z, wood: false }, { to: 'near', x: at.x, y: at.y, radius: 80 });
}

// ---------------------------------------------------------------------------
// Models, built in code. Tips point down -Z, tops up +Y.
// ---------------------------------------------------------------------------

function cylinderZ(r: number, length: number, z: number, color: number, sides = 8): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(r, r, length, sides).rotateX(UP).translate(0, 0, z), color);
}

const WOOD_HANDLE = 0x8a5a32;

// ---------------------------------------------------------------------------
// Axe: fell trees, hunt, fight, butcher
// ---------------------------------------------------------------------------

class Axe extends WildTool {
  override onUse(use: Use): void {
    if (use.side !== null) return; // tracked hands swing it for real (onHold)
    const { ctx } = use.avatar;
    const reach = 2.4;
    const swung = swungAt(use, reach, true);
    const sight = swung ? null : sighted(use, reach);
    if (swung) {
      strike(use, swung.body, swung.at, 24, true);
      use.effect({ kick: 0.8, hit: 'body' });
    } else if (sight && sight.obstacle >= 0) {
      this.chop(use, sight.obstacle, sight.at);
      use.effect({ kick: 0.8, hit: 'body' });
    } else {
      use.effect({ kick: 0.5 });
      ctx.sfx.play('swish');
    }
  }

  override onHold(use: Use): void {
    if (use.side === null) return;
    const { ctx } = use.avatar;
    const st = stateOf(use);
    const v = use.velocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    if (speed < SWING_SPEED || ctx.now < st.next) return;
    const o = use.origin;
    // a survivor or an animal, living or not, before a tree
    const body = swungInto(use, true);
    if (body) {
      strike(use, body, o, Math.min(40, 8 + speed * 4), true);
      st.next = ctx.now + 400;
      use.effect({ kick: 0.8, hit: 'body' });
      return;
    }
    const tree = ctx.land.treeAt(o.x, o.y, 0.15);
    if (tree < 0) return;
    const trunk = ctx.land.obstacles[tree];
    if (o.z < trunk.base + 0.2 || o.z > trunk.base + 2.6) return;
    this.chop(use, tree, o);
    st.next = ctx.now + 400;
    use.effect({ kick: 0.8, hit: 'body' });
  }

  private chop(use: Use, tree: number, at: Vec3): void {
    const { avatar } = use;
    const { ctx } = avatar;
    const o = ctx.land.obstacles[tree];
    const wood = o.kind !== ObstacleKind.Rock;
    ctx.world.send(Chop, { x: at.x, y: at.y, z: at.z, wood }, { to: 'near', x: at.x, y: at.y, radius: 80 });
    if (!wood) return;
    const chops = (avatar.chops.get(tree) ?? 0) + 1;
    avatar.chops.set(tree, chops);
    avatar.give(WOOD, 1);
    if (chops < CHOPS_TO_FELL) return;
    avatar.chops.delete(tree);
    if (fell(ctx, tree)) {
      ctx.hud.message('Timber!');
      avatar.give(WOOD, 2);
    }
  }
}

export const AXE = new Axe({
  name: 'Axe',
  model: {
    build: () =>
      merge([
        box(0.035, 0.04, 0.72, 0, 0, -0.26, WOOD_HANDLE),
        box(0.03, 0.09, 0.12, 0, -0.02, -0.64, 0x5c6168),
        box(0.012, 0.16, 0.1, 0, -0.08, -0.64, 0xb9c0c8),
      ]),
    length: 0.74,
  },
  grip: { tip: [0, -0.02, -0.64], pitch: 1.05 },
  stash: [{ at: [0.14, -0.3, 0.2], pitch: UP, roll: -0.35 }],
  color: 0xc9d1d9,
  issued: 1,
  cooldownMs: 520,
  automatic: true,
});

// ---------------------------------------------------------------------------
// Bow and arrows
// ---------------------------------------------------------------------------

/** Bow limb tips and the resting string in the bow's own model space, for drawing the string. */
export const BOW_LIMBS = { top: new THREE.Vector3(0, 0.7, 0.13), bottom: new THREE.Vector3(0, -0.7, 0.13) };
/** How far back a string can be pulled, meters, and the length of an arrow. */
const FULL_DRAW = 0.6;
export const ARROW_LENGTH = 0.74;
/** Seconds a crosshair bow takes to reach full draw. */
const DESKTOP_DRAW_SECONDS = 0.9;
/** How near the arrow's nock must come to the bow's rest to nock it. */
const NOCK_REACH = 0.2;

function shoot(use: Use, from: Vec3, aim: Vec3, draw: number): void {
  const { avatar } = use;
  const { ctx } = avatar;
  if (draw < 0.15 || !avatar.inventory.has(ARROWS)) return;
  ctx.arrows.loose(ctx.me!, from, aim, ARROW_MIN_SPEED + (ARROW_MAX_SPEED - ARROW_MIN_SPEED) * draw);
  avatar.spend(ARROWS);
}

class Bow extends WildTool {
  override onUse(use: Use): void {
    if (use.side !== null) return; // tracked: the other hand draws (see Arrows)
    const { avatar } = use;
    const st = stateOf(use);
    st.draw = 0;
    st.nocked = avatar.inventory.has(ARROWS);
    if (!st.nocked) {
      avatar.ctx.hud.message('No arrows');
      avatar.ctx.sfx.play('switch');
    }
  }

  override onHold(use: Use, dt: number): void {
    if (use.side !== null) return;
    const st = stateOf(use);
    if (use.pressedAt === null || !st.nocked) return;
    const before = st.draw;
    st.draw = Math.min(1, st.draw + dt / DESKTOP_DRAW_SECONDS);
    if (before === 0) use.avatar.ctx.sfx.play('draw');
    use.avatar.me!.state.draw = st.draw;
  }

  override onRelease(use: Use): void {
    if (use.side !== null) return;
    const st = stateOf(use);
    if (st.nocked) {
      shoot(use, use.tip, use.aim, st.draw);
      if (st.draw >= 0.15) use.effect({ kick: 0.4 });
    }
    st.draw = 0;
    st.nocked = false;
  }

  override onUnequip(use: Use): void {
    const st = stateOf(use);
    st.draw = 0;
    st.nocked = false;
  }
}

export const BOW = new Bow({
  name: 'Bow',
  model: {
    build: () => {
      const parts = [box(0.035, 0.18, 0.06, 0, 0, 0, 0x5a3a22)];
      for (const s of [1, -1]) {
        parts.push(box(0.03, 0.3, 0.035, 0, s * 0.24, 0.035, 0x7a5230));
        parts.push(box(0.026, 0.28, 0.03, 0, s * 0.52, 0.095, 0x7a5230));
      }
      return merge(parts);
    },
    length: 0.16,
  },
  grip: { tip: [0, 0, -0.03] },
  stash: [{ at: [-0.12, -0.3, 0.19], pitch: UP, roll: 0.35 }],
  color: 0xd9a066,
  issued: 1,
});

/**
 * Arrows. In a tracked hand, with the bow in the other: bring the arrow's nock to the bow and pull the
 * trigger to nock it, draw your hand back, and let go of the trigger to shoot where the arrow points from
 * your drawing hand through the bow. On a crosshair the bow uses them itself.
 */
class Arrows extends WildTool {
  override onUse(use: Use): void {
    const { avatar } = use;
    if (use.side === null) {
      avatar.ctx.hud.message('Take out the bow to shoot arrows');
      return;
    }
    const bow = otherHand(use);
    if (bow.tool !== BOW) return;
    const nock = this.nock(use);
    if (Math.hypot(nock.x - bow.origin.x, nock.y - bow.origin.y, nock.z - bow.origin.z) > NOCK_REACH) return;
    const st = stateOf(use);
    st.nocked = true;
    st.draw = 0;
    avatar.ctx.sfx.play('draw');
    use.effect({ kick: 0.1 });
  }

  override onHold(use: Use): void {
    const st = stateOf(use);
    if (!st.nocked) return;
    const bow = otherHand(use);
    if (bow.tool !== BOW || use.pressedAt === null) {
      st.nocked = false;
      st.draw = 0;
      return;
    }
    const nock = this.nock(use);
    const pull = Math.hypot(nock.x - bow.origin.x, nock.y - bow.origin.y, nock.z - bow.origin.z);
    st.draw = clamp((pull - 0.05) / FULL_DRAW, 0, 1);
    use.avatar.me!.state.draw = st.draw;
  }

  override onRelease(use: Use): void {
    const st = stateOf(use);
    if (!st.nocked) return;
    st.nocked = false;
    const bow = otherHand(use);
    const nock = this.nock(use);
    const dx = bow.origin.x - nock.x;
    const dy = bow.origin.y - nock.y;
    const dz = bow.origin.z - nock.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-3) {
      shoot(use, bow.origin, { x: dx / len, y: dy / len, z: dz / len }, st.draw);
      if (st.draw >= 0.15) {
        use.effect({ kick: 0.4 });
        bow.effect({ kick: 0.6 });
      }
    }
    st.draw = 0;
  }

  override onUnequip(use: Use): void {
    const st = stateOf(use);
    st.nocked = false;
    st.draw = 0;
  }

  /** The back of the arrow, where it meets the string. */
  private nock(use: Use): Vec3 {
    const { origin: o, aim: d } = use;
    return { x: o.x - d.x * ARROW_LENGTH, y: o.y - d.y * ARROW_LENGTH, z: o.z - d.z * ARROW_LENGTH };
  }
}

export const ARROWS = new Arrows({
  name: 'Arrows',
  model: {
    build: () =>
      merge([
        box(0.012, 0.012, 0.68, 0, 0, 0.34, 0xc8a878),
        box(0.02, 0.03, 0.06, 0, 0, 0.03, 0x4a4f55),
        box(0.004, 0.05, 0.1, 0, 0.02, 0.64, 0xe8e2d0),
        box(0.05, 0.004, 0.1, 0, 0, 0.64, 0xb03a2e),
      ]),
    length: ARROW_LENGTH,
  },
  grip: { tip: [0, 0, -ARROW_LENGTH + 0.03] },
  stash: [{ at: [0.16, -0.05, 0.2], pitch: UP, roll: -0.15 }],
  color: 0xe8e2d0,
  charges: { pickup: 1, max: 40, unit: 'arrows' },
  selectOnPickup: false,
});

// ---------------------------------------------------------------------------
// Farming
// ---------------------------------------------------------------------------

/** A hoe tills the soil, and hits survivors and animals too (not as hard as an axe, and it can't butcher). */
class Hoe extends WildTool {
  override onUse(use: Use): void {
    if (use.side !== null) return;
    const swung = swungAt(use, 2.6, false);
    if (swung) {
      strike(use, swung.body, swung.at, 14);
      use.effect({ kick: 0.6, hit: 'body' });
      return;
    }
    const sight = sighted(use, 3.2);
    if (sight && sight.obstacle < 0 && till(use.avatar.ctx, sight.at.x, sight.at.y)) use.effect({ kick: 0.6, hit: 'body' });
    else use.effect({ kick: 0.4 });
  }

  override onHold(use: Use): void {
    if (use.side === null) return;
    const st = stateOf(use);
    const { ctx } = use.avatar;
    if (ctx.now < st.next) return;
    const body = swungInto(use, false);
    if (body) {
      const v = use.velocity;
      strike(use, body, use.origin, Math.min(30, 5 + Math.hypot(v.x, v.y, v.z) * 3));
      st.next = ctx.now + 450;
      use.effect({ kick: 0.6, hit: 'body' });
      return;
    }
    // a chop down into the soil
    if (use.velocity.z > -2.2 || aboveGround(use, use.origin) > 0.08) return;
    st.next = ctx.now + 450;
    if (till(ctx, use.origin.x, use.origin.y)) use.effect({ kick: 0.6, hit: 'body' });
  }
}

export const HOE = new Hoe({
  name: 'Hoe',
  model: {
    build: () => merge([box(0.03, 0.035, 1.05, 0, 0, -0.4, WOOD_HANDLE), box(0.16, 0.13, 0.025, 0, -0.07, -0.93, 0x70757c)]),
    length: 1.07,
  },
  grip: { tip: [0, -0.13, -0.93], pitch: 0.75 },
  stash: [{ at: [0, -0.35, 0.22], pitch: UP }],
  color: 0xa7b0b8,
  issued: 1,
  cooldownMs: 450,
  automatic: true,
});

class Seeds extends WildTool {
  override onUse(use: Use): void {
    const { avatar } = use;
    const { ctx } = avatar;
    let at: Vec3;
    if (use.side === null) {
      const sight = sighted(use, 3.5);
      if (!sight) return;
      at = sight.at;
    } else {
      if (aboveGround(use, use.origin) > 0.6) return; // reach down to the soil
      at = use.origin;
    }
    const plot = plotNear(ctx, at.x, at.y, use.side === null ? 1.2 : 0.5, (p) => p.state.crop === Crop.None);
    if (!plot) {
      if (use.side === null) ctx.hud.message('Sow seeds in tilled soil (use the hoe)');
      return;
    }
    use.effect({ kick: 0.1 });
    void sow(ctx, plot, Crop.Carrot).then((ok) => ok && avatar.alive && avatar.spend(SEEDS));
  }
}

export const SEEDS = new Seeds({
  name: 'Seeds',
  model: {
    build: () => merge([box(0.1, 0.1, 0.1, 0, 0, 0.06, 0xb89a6a), box(0.05, 0.03, 0.05, 0, 0.06, 0.06, 0x7a6040)]),
    length: 0.12,
  },
  grip: { tip: [0, 0, -0.02] },
  stash: [{ at: [-0.22, -0.5, -0.08], pitch: DOWN }],
  color: 0xd8c08a,
  charges: { pickup: 3, max: 30, unit: 'seeds' },
  cooldownMs: 300,
  selectOnPickup: false,
});

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

/** Seconds food must be held at your mouth to take a bite, and meat over a fire (tracked, crosshair) to cook. */
const CHEW_SECONDS = 0.45;
const COOK_SECONDS = 4;
const DESKTOP_COOK_SECONDS = 2.5;

interface FoodOptions extends ToolOptions {
  /** How much it fills you up, and heals (negative hurts). */
  food: number;
  heal: number;
  /** What it cooks into over a fire. */
  cooks?: () => Food;
}

class Food extends WildTool {
  readonly food: number;
  readonly heal: number;
  private readonly cooks: (() => Food) | null;

  constructor(o: FoodOptions) {
    super({ selectOnPickup: false, cooldownMs: 700, ...o });
    this.food = o.food;
    this.heal = o.heal;
    this.cooks = o.cooks ?? null;
  }

  override onUse(use: Use): void {
    if (use.side !== null) return; // tracked: bring it to your mouth (onHold)
    const { avatar } = use;
    const s = avatar.me!.state;
    if (this.cooks && fireNear(avatar.ctx, s.x, s.y, 3)) return; // hold it to cook instead
    this.eat(use);
  }

  override onHold(use: Use, dt: number): void {
    const st = stateOf(use);
    const { avatar } = use;
    const { ctx } = avatar;
    if (use.side === null) {
      const s = avatar.me!.state;
      const cooking = this.cooks && use.pressedAt !== null && fireNear(ctx, s.x, s.y, 3);
      st.cook = cooking ? st.cook + dt : 0;
      if (cooking) avatar.me!.state.draw = Math.min(1, st.cook / DESKTOP_COOK_SECONDS);
      if (st.cook >= DESKTOP_COOK_SECONDS) this.cook(use);
      return;
    }

    // at the mouth: a little below and in front of the eyes
    const o = use.origin;
    const s = avatar.me!.state;
    const mouthZ = avatar.feetZ() + s.head - 0.1;
    const atMouth = Math.hypot(o.x - s.x, o.y - s.y) < 0.28 && Math.abs(o.z - mouthZ) < 0.16;
    st.chew = atMouth ? st.chew + dt : 0;
    if (st.chew >= CHEW_SECONDS) {
      st.chew = -0.6; // a pause between bites
      this.eat(use);
      return;
    }

    // over the flames
    const fire = this.cooks ? fireNear(ctx, o.x, o.y, 0.9) : undefined;
    const height = fire ? aboveGround(use, o) : 0;
    st.cook = fire && height > 0.1 && height < 1.2 ? st.cook + dt : 0;
    if (st.cook > 0 && Math.floor(st.cook * 4) !== Math.floor((st.cook - dt) * 4)) ctx.sfx.play('sizzle', o);
    if (st.cook >= COOK_SECONDS) this.cook(use);
  }

  private eat(use: Use): void {
    use.avatar.eat(this.food, this.heal);
    use.effect({ kick: 0.15 });
    use.spend();
  }

  private cook(use: Use): void {
    const st = stateOf(use);
    st.cook = 0;
    const cooked = this.cooks!();
    use.avatar.ctx.sfx.play('sizzle');
    use.spend();
    use.avatar.give(cooked, 1);
    use.effect({ kick: 0.2, hit: 'body' });
  }
}

export const CARROT = new Food({
  name: 'Carrot',
  model: {
    build: () =>
      merge([
        paint(new THREE.ConeGeometry(0.028, 0.18, 6).rotateX(-UP).translate(0, 0, 0.09), 0xf08a24),
        box(0.012, 0.08, 0.012, 0, 0.03, 0.2, 0x4f9a3a),
        box(0.012, 0.06, 0.012, 0.015, 0.02, 0.19, 0x5fae45),
      ]),
    length: 0.22,
  },
  grip: { tip: [0, 0, -0.12] },
  stash: [{ at: [0.18, -0.5, -0.14], pitch: DOWN }],
  color: 0xf08a24,
  charges: { pickup: 1, max: 20, unit: 'carrots' },
  food: 22,
  heal: 2,
});

export const COOKED_MEAT = new Food({
  name: 'Cooked meat',
  model: { build: () => merge([box(0.1, 0.07, 0.15, 0, 0, 0.075, 0x6b3a1e), box(0.02, 0.02, 0.08, 0, 0, 0.18, 0xeee6d2)]), length: 0.22 },
  grip: { tip: [0, 0, -0.1] },
  stash: [{ at: [0.24, -0.45, 0.05], pitch: DOWN }],
  color: 0xb5651d,
  charges: { pickup: 1, max: 10, unit: 'cooked meat' },
  food: 45,
  heal: 10,
});

export const RAW_MEAT = new Food({
  name: 'Raw meat',
  model: { build: () => merge([box(0.1, 0.07, 0.15, 0, 0, 0.075, 0xb8323a), box(0.02, 0.02, 0.08, 0, 0, 0.18, 0xeee6d2)]), length: 0.22 },
  grip: { tip: [0, 0, -0.1] },
  stash: [{ at: [-0.18, -0.5, -0.14], pitch: DOWN }],
  color: 0xd24a52,
  charges: { pickup: 1, max: 10, unit: 'raw meat' },
  food: 12,
  heal: -6,
  cooks: () => COOKED_MEAT,
});

// ---------------------------------------------------------------------------
// Wood: build and stoke fires
// ---------------------------------------------------------------------------

class Wood extends WildTool {
  override onUse(use: Use): void {
    const { avatar } = use;
    const { ctx } = avatar;
    let at: Vec3;
    if (use.side === null) {
      const sight = sighted(use, 3.2);
      if (!sight) return;
      at = sight.at;
    } else {
      if (aboveGround(use, use.origin) > 0.7) return; // set it down on the ground
      at = use.origin;
    }
    const fire = fireNear(ctx, at.x, at.y, 1.4, true);
    if (fire) {
      addLogs(ctx, fire, 1);
      use.spend();
      use.effect({ kick: 0.2 });
    } else if (avatar.inventory.charges(WOOD) < FIRE_LOGS) {
      ctx.hud.message(`A fire takes ${FIRE_LOGS} logs`);
    } else if (canBuildFire(ctx, at.x, at.y)) {
      buildFire(ctx, at.x, at.y);
      use.spend(FIRE_LOGS);
      use.effect({ kick: 0.3 });
    }
  }
}

export const WOOD = new Wood({
  name: 'Wood',
  model: { build: () => merge([cylinderZ(0.05, 0.45, 0.22, 0x6e4a2a), cylinderZ(0.042, 0.46, 0.22, 0xc9a26b, 6)]), length: 0.46 },
  grip: { tip: [0, 0, -0.22], roll: UP },
  stash: [{ at: [0, -0.6, 0.2], pitch: 0, roll: UP }],
  color: 0xa0703f,
  charges: { pickup: 1, max: 40, unit: 'logs' },
  cooldownMs: 400,
  selectOnPickup: false,
});

/** Every kind of tool in Peer Wilds, in slot order (number keys). */
export const TOOLS = new Toolbox<WildTool>([AXE, BOW, HOE, SEEDS, CARROT, RAW_MEAT, COOKED_MEAT, WOOD, ARROWS]);
