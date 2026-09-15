import { describe, expect, it } from 'vitest';
import type { AvatarBody } from '../src/crossplay/avatar';
import { Side, handIntent, idleIntent, type AvatarIntent, type HandIntent, type TrackedHead } from '../src/crossplay/intent';
import { Platform } from '../src/crossplay/platform';
import type { Tool, UseEffect } from '../src/crossplay/tool';
import { updateOwnedAnimals } from '../src/wilds/animals';
import { Arrows } from '../src/wilds/arrows';
import { registerCombat } from '../src/wilds/combat';
import type { Vec3, WildsContext } from '../src/wilds/context';
import { ACTIONS, Animal, AnimalKind, AnimalMode, Crop, Damage, ENTITIES, Item, Plot, Stump, Survivor as SurvivorDef } from '../src/wilds/defs';
import { CHOPS_TO_FELL, GROW_SECONDS, buildFire, trackStumps } from '../src/wilds/homestead';
import { ARROWS, ARROW_LENGTH, AXE, BOW, CARROT, COOKED_MEAT, HOE, RAW_MEAT, SEEDS, WOOD } from '../src/wilds/kit';
import { Ground, Land, MEADOW, ObstacleKind, SIZE } from '../src/wilds/land';
import { Survivor } from '../src/wilds/survivor';
import { Sim } from './harness';

const land = new Land(20260915);
const stub = () => new Proxy({}, { get: () => () => {} });
const messages: string[] = [];

/** Records what the rules asked of the device, and carries a headset's head along like a real play space. */
class TestBody implements AvatarBody {
  platform = Platform.Vr;
  readonly head: TrackedHead = { x: 0, y: 0, z: 0, heading: 0, pitch: 0 };
  readonly uses: [Side | null, Tool<any>, UseEffect][] = [];

  moved(dx: number, dy: number): void {
    this.head.x += dx;
    this.head.y += dy;
  }

  placed(x: number, y: number): void {
    this.head.x = x;
    this.head.y = y;
  }

  hurt(): void {}

  used(side: Side | null, tool: Tool<any>, effect: UseEffect): void {
    this.uses.push([side, tool, effect]);
  }

  died(): void {}
}

function setup({ animals = false } = {}) {
  const net = new Sim();
  const world = net.add('me', { worldId: 'wilds-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 256, cellSize: 64, interestRadius: 170, spatialCellSize: 24 });
  const hud = { ...stub(), message: (text: string) => messages.push(text), showBanner() {} };
  land.felled.clear();
  const ctx = { world, land, sfx: stub(), hud, fx: stub(), me: null, playerName: 'Tester', now: net.now, wall: 2_000_000, day: 0.5 } as unknown as WildsContext;
  ctx.arrows = new Arrows(ctx);
  const survivor = new Survivor(ctx);
  const body = new TestBody();
  survivor.body = body;
  registerCombat(ctx, survivor);
  trackStumps(ctx);
  survivor.spawn();
  const s = ctx.me!.state;
  /** Run the rules for `n` frames of 16ms. */
  const frames = (n: number, intent: AvatarIntent) => {
    for (let i = 0; i < n; i++) {
      net.now += 16;
      ctx.now = net.now;
      ctx.wall += 0.016;
      survivor.update(0.016, intent);
      ctx.arrows.update(0.016);
      if (animals) updateOwnedAnimals(ctx, 0.016);
      world.update(net.now);
    }
  };
  /** Stand at (x, y), with a headset's eyes 1.7m above the ground. */
  const standAt = (x: number, y: number) => {
    Object.assign(s, { x, y, z: 0 });
    Object.assign(body.head, { x, y, z: land.heightAt(x, y) + 1.7 });
  };
  const tracked = (): AvatarIntent => {
    const intent = idleIntent();
    intent.head = body.head;
    intent.hands = [handIntent(), handIntent()];
    return intent;
  };
  return { ctx, world, survivor, body, s, frames, standAt, tracked };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0)); // ownership is granted asynchronously

function hold(hand: HandIntent, tool: Tool<any> | null, at: Vec3, aim: Vec3 = { x: 1, y: 0, z: 0 }): HandIntent {
  Object.assign(hand, { tracked: true, tool });
  Object.assign(hand.grip, at);
  Object.assign(hand.tip, at);
  Object.assign(hand.aim, aim);
  Object.assign(hand.pointing, aim);
  return hand;
}

/** A standing tree with open ground a meter to its west. */
function openTree(): number {
  return land.obstacles.findIndex((o, i) => o.kind !== ObstacleKind.Rock && !land.blocked(o.x - o.r - 0.9, o.y, 0.35) && land.standing(i) && land.heightAt(o.x, o.y) > 1.5);
}

/** An open, flat stretch of meadow: a point and a heading with `len` meters of clear ground ahead. */
function openGround(len: number): { x: number; y: number; heading: number } {
  const c = SIZE / 2;
  for (let r = 0; r < MEADOW; r += 2) {
    for (let a = 0; a < Math.PI * 2; a += 0.5) {
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      for (let h = 0; h < Math.PI * 2; h += Math.PI / 4) {
        let clear = true;
        for (let d = 0; d <= len && clear; d += 1) clear = !land.blocked(x + Math.cos(h) * d, y + Math.sin(h) * d, 0.6);
        if (clear) return { x, y, heading: h };
      }
    }
  }
  throw new Error('no open ground');
}

describe('Land', () => {
  it('is the same island on every peer, with a meadow in the middle and trees around it', () => {
    const again = new Land(20260915);
    expect(again.heightAt(123.4, 321.9)).toBe(land.heightAt(123.4, 321.9));
    expect(again.obstacles.length).toBe(land.obstacles.length);
    expect(land.groundAt(SIZE / 2, SIZE / 2)).not.toBe(Ground.Water);
    expect(land.groundAt(3, 3)).toBe(Ground.Water);
    expect(land.obstacles.filter((o) => o.kind !== ObstacleKind.Rock).length).toBeGreaterThan(500);
  });

  it('casts rays onto the ground and into trunks, but not through felled trees', () => {
    const c = SIZE / 2;
    const down = land.raycast(c, c, 20, 0, 0, -1, 50);
    expect(down.t).toBeCloseTo(20 - land.heightAt(c, c), 1);
    const tree = openTree();
    const o = land.obstacles[tree];
    const from = { x: o.x - o.r - 0.9, y: o.y, z: o.base + 1 };
    expect(land.raycast(from.x, from.y, from.z, 1, 0, 0, 5).obstacle).toBe(tree);
    expect(land.blocked(o.x, o.y, 0.3)).toBe(true);
    land.felled.add(tree);
    expect(land.raycast(from.x, from.y, from.z, 1, 0, 0, 5).obstacle).not.toBe(tree);
    expect(land.blocked(o.x, o.y, 0.3)).toBe(false);
    land.felled.delete(tree);
  });
});

describe('Survivor', () => {
  it('walks on the ground, with head and hands measured from the feet', () => {
    const { survivor, body, s, frames, standAt, tracked } = setup();
    body.platform = Platform.Desktop;
    const open = openGround(8);
    standAt(open.x, open.y);
    survivor.heading = open.heading;
    const walk = idleIntent();
    walk.forward = 1;
    frames(60, walk);
    const ground = land.heightAt(s.x, s.y);
    expect(Math.hypot(s.x - open.x, s.y - open.y)).toBeGreaterThan(3);
    const eye = survivor.eyePosition({ x: 0, y: 0, z: 0 });
    expect(eye.z).toBeCloseTo(ground + 1.65, 5);
    expect(s.hz).toBeCloseTo(1.35, 1);

    body.platform = Platform.Vr;
    standAt(s.x, s.y);
    body.head.z = land.heightAt(s.x, s.y) + 1.2; // crouching
    frames(2, tracked());
    expect(s.head).toBeCloseTo(1.2, 1);
  });

  it('fells a tree with tracked axe swings, gathering wood', () => {
    const { world, survivor, s, frames, standAt, tracked } = setup();
    const tree = openTree();
    const o = land.obstacles[tree];
    standAt(o.x - o.r - 0.9, o.y);
    const intent = tracked();
    const z = o.base + 1.2;
    const right = intent.hands![Side.Right];
    for (let swing = 0; swing < CHOPS_TO_FELL; swing++) {
      hold(right, AXE, { x: s.x - 0.3, y: s.y, z }); // wound up
      frames(30, intent);
      hold(right, AXE, { x: o.x - o.r * 0.5, y: o.y, z }); // into the bark
      frames(1, intent);
    }
    const stumps = [...world.all(Stump)];
    expect(stumps.map((st) => st.state.tree)).toEqual([tree]);
    expect(land.standing(tree)).toBe(false);
    expect(survivor.inventory.charges(WOOD)).toBe(CHOPS_TO_FELL + 2);
  });

  it('tills, sows and harvests with a crosshair', async () => {
    const { ctx, world, survivor, body, s, frames, standAt } = setup();
    body.platform = Platform.Desktop;
    const open = openGround(4);
    standAt(open.x, open.y);
    survivor.heading = open.heading;
    survivor.pitch = -0.6; // looking at the ground a couple of meters ahead
    const intent = idleIntent();
    intent.selectTool = HOE;
    intent.trigger = true;
    frames(1, intent);
    const plots = [...world.all(Plot)];
    expect(plots).toHaveLength(1);

    intent.trigger = false;
    survivor.inventory.takeOut(SEEDS); // seeds are gathered, so they start in the pack
    intent.selectTool = SEEDS;
    frames(1, intent);
    intent.trigger = true;
    frames(1, intent);
    await settle();
    expect(plots[0].state.crop).toBe(Crop.Carrot);
    expect(survivor.inventory.charges(SEEDS)).toBe(5);

    intent.trigger = false;
    ctx.wall += GROW_SECONDS;
    frames(1, intent);
    expect(survivor.nearRipe).toBe(plots[0]);
    const carrots = survivor.inventory.charges(CARROT);
    intent.interact = true;
    frames(1, intent);
    await settle();
    expect(plots[0].state.crop).toBe(Crop.None);
    expect(survivor.inventory.charges(CARROT)).toBe(carrots + 2);
    expect(s.food).toBeGreaterThan(0);
  });

  it('draws a bow with two tracked hands and brings down a deer', () => {
    const { ctx, world, survivor, s, frames, standAt, tracked } = setup();
    const open = openGround(14);
    standAt(open.x, open.y);
    const deerX = open.x + Math.cos(open.heading) * 12;
    const deerY = open.y + Math.sin(open.heading) * 12;
    const deer = world.spawn(Animal, { x: deerX, y: deerY, kind: AnimalKind.Deer, hp: 70, mode: AnimalMode.Graze, tx: deerX, ty: deerY });

    const feet = land.heightAt(s.x, s.y);
    const bow = { x: s.x + Math.cos(open.heading) * 0.5, y: s.y + Math.sin(open.heading) * 0.5, z: feet + 1.4 };
    const target = { x: deerX, y: deerY, z: land.heightAt(deerX, deerY) + 1 };
    const len = Math.hypot(target.x - bow.x, target.y - bow.y, target.z - bow.z);
    const aim = { x: (target.x - bow.x) / len, y: (target.y - bow.y) / len, z: (target.z - bow.z) / len + 0.012 };
    const intent = tracked();
    const [right, left] = intent.hands!;
    hold(left, BOW, bow, aim);
    // the arrow's nock on the bow: its tip is an arrow's length in front
    const at = (back: number) => ({ x: bow.x + aim.x * (ARROW_LENGTH - back), y: bow.y + aim.y * (ARROW_LENGTH - back), z: bow.z + aim.z * (ARROW_LENGTH - back) });
    hold(right, ARROWS, at(0), aim);
    right.trigger = true;
    frames(1, intent);
    for (let step = 0; step <= 15; step++) {
      hold(right, ARROWS, at(step * 0.05), aim);
      frames(1, intent);
    }
    expect(s.draw).toBe(1);
    const arrows = survivor.inventory.charges(ARROWS);
    right.trigger = false;
    frames(1, intent);
    expect(survivor.inventory.charges(ARROWS)).toBe(arrows - 1);
    expect(ctx.arrows.flights).toHaveLength(1);
    messages.length = 0;
    frames(40, intent);
    expect(deer.state.mode).toBe(AnimalMode.Dead);
    expect(messages.some((m) => m.includes('deer'))).toBe(true);
  });

  it('strikes other survivors and animals with the axe and the hoe', () => {
    const { world, survivor, body, s, frames, standAt, tracked } = setup();
    const open = openGround(4);
    standAt(open.x, open.y);
    const ahead = (d: number) => ({ x: open.x + Math.cos(open.heading) * d, y: open.y + Math.sin(open.heading) * d });
    const hits: { target: number; amount: number }[] = [];
    const send = world.send.bind(world);
    world.send = ((def, payload, opts) => {
      if ((def as unknown) === Damage) hits.push(payload as { target: number; amount: number });
      return send(def, payload, opts);
    }) as typeof world.send;

    // on a crosshair: another survivor (their own peer applies the damage)
    body.platform = Platform.Desktop;
    const other = world.spawn(SurvivorDef, { ...ahead(1.5), name: 'Other', hp: 100, food: 80 });
    survivor.heading = open.heading;
    const intent = idleIntent();
    for (const [tool, amount] of [[AXE, 24], [HOE, 14]] as const) {
      intent.selectTool = tool;
      intent.trigger = false;
      frames(1, intent);
      intent.trigger = true;
      frames(1, intent);
      expect(hits.pop()).toMatchObject({ target: other.id, amount });
    }
    world.despawn(other);

    // in a tracked hand: a deer that's already seen you, so no sneak attack
    body.platform = Platform.Vr;
    const d = ahead(1);
    const deer = world.spawn(Animal, { ...d, kind: AnimalKind.Deer, hp: 70, mode: AnimalMode.Flee, tx: d.x, ty: d.y });
    const hands = tracked();
    const right = hands.hands![Side.Right];
    const z = land.heightAt(d.x, d.y) + 0.8;
    hold(right, HOE, { ...ahead(0.3), z }); // wound up
    frames(30, hands);
    hold(right, HOE, { ...d, z }); // into its flank
    frames(1, hands);
    expect(deer.state.hp).toBe(40);
    expect(s.hp).toBe(100);
  });

  it('sneaks up behind a grazing deer and drops it with one blow of the axe', () => {
    for (const sneaking of [false, true]) {
      const { world, survivor, body, s, frames, standAt } = setup({ animals: true });
      body.platform = Platform.Desktop;
      const open = openGround(14);
      standAt(open.x, open.y);
      survivor.heading = open.heading;
      const dx = open.x + Math.cos(open.heading) * 12;
      const dy = open.y + Math.sin(open.heading) * 12;
      // grazing where it stands, facing away
      const deer = world.spawn(Animal, { x: dx, y: dy, angle: open.heading, kind: AnimalKind.Deer, hp: 70, mode: AnimalMode.Graze, tx: dx, ty: dy });
      Object.assign(deer.local, { pauseUntil: Infinity });

      const intent = idleIntent();
      intent.selectTool = AXE;
      intent.forward = 1;
      intent.crouch = sneaking;
      const gap = () => Math.hypot(deer.state.x - s.x, deer.state.y - s.y);
      for (let i = 0; i < 600 && gap() > 2 && deer.state.mode === AnimalMode.Graze; i++) frames(1, intent);
      if (!sneaking) {
        expect(deer.state.mode).toBe(AnimalMode.Flee);
        expect(gap()).toBeGreaterThan(9);
        continue;
      }
      expect(deer.state.mode).toBe(AnimalMode.Graze);
      expect(s.head).toBeLessThan(1.1);
      intent.forward = 0;
      intent.trigger = true;
      messages.length = 0;
      frames(1, intent);
      expect(deer.state.mode).toBe(AnimalMode.Dead);
      expect(messages).toContain('Sneak attack!');
    }
  });

  it('eats food held to the mouth, and cooks raw meat held over a fire', () => {
    const { ctx, survivor, s, frames, standAt, tracked } = setup();
    const open = openGround(4);
    standAt(open.x, open.y);
    s.food = 40;
    const intent = tracked();
    const right = intent.hands![Side.Right];
    const feet = land.heightAt(s.x, s.y);
    hold(right, CARROT, { x: s.x + 0.1, y: s.y, z: feet + 1.6 });
    frames(40, intent);
    expect(s.food).toBeGreaterThanOrEqual(61);
    expect(survivor.inventory.charges(CARROT)).toBe(2);

    const fx = s.x + Math.cos(open.heading) * 1.5;
    const fy = s.y + Math.sin(open.heading) * 1.5;
    buildFire(ctx, fx, fy);
    survivor.inventory.add(RAW_MEAT, 1);
    hold(right, RAW_MEAT, { x: fx, y: fy, z: land.heightAt(fx, fy) + 0.5 });
    frames(270, intent);
    expect(survivor.inventory.has(RAW_MEAT)).toBe(false);
    expect(survivor.inventory.charges(COOKED_MEAT)).toBe(1);
  });

  it('is hunted by wolves at night, unless it keeps by a fire', () => {
    for (const byFire of [false, true]) {
      const { ctx, world, s, frames, standAt } = setup({ animals: true });
      ctx.day = 0; // midnight
      const open = openGround(12);
      standAt(open.x, open.y);
      if (byFire) buildFire(ctx, open.x + Math.cos(open.heading) * 1.5, open.y + Math.sin(open.heading) * 1.5);
      const wx = open.x + Math.cos(open.heading) * 10;
      const wy = open.y + Math.sin(open.heading) * 10;
      world.spawn(Animal, { x: wx, y: wy, kind: AnimalKind.Wolf, hp: 50, mode: AnimalMode.Graze, tx: wx, ty: wy });
      s.food = 100;
      frames(250, idleIntent());
      if (byFire) expect(s.hp).toBe(100);
      else expect(s.hp).toBeLessThan(100);
    }
  });

  it('gathers into the pack, keeping the tools you use to hand', () => {
    const { survivor, frames } = setup();
    const inv = survivor.inventory;
    expect(inv.toHand()).toEqual([AXE, BOW, HOE, ARROWS]);
    expect(inv.packed()).toEqual([SEEDS, CARROT]);

    survivor.give(WOOD, 3);
    expect(inv.inPack(WOOD)).toBe(true);
    expect(messages.at(-1)).toContain('pack');

    // the number keys only reach what's to hand, so taking the wood out is what puts it on them
    const intent = idleIntent();
    intent.selectTool = WOOD;
    frames(1, intent);
    expect(inv.current).toBe(AXE);
    expect(inv.takeOut(WOOD)).toBe(true);
    frames(1, intent);
    expect(inv.current).toBe(WOOD);
    expect(inv.toHand()).toContain(WOOD);
  });

  it('spills what it gathered where it dies', () => {
    const { world, survivor, s } = setup();
    survivor.inventory.add(WOOD, 5);
    survivor.die('a wolf');
    expect(s.hp).toBe(0);
    const spilled = [...world.all(Item)].map((i) => [i.state.tool, i.state.amount]);
    expect(spilled).toContainEqual([WOOD.id, 5]);
    expect(spilled).toContainEqual([ARROWS.id, 12]);
    expect(survivor.inventory.has(AXE)).toBe(true);
  });
});
