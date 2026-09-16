import { beforeAll, describe, expect, it } from 'vitest';
import type { NetWorld } from '../src/engine/net/world';
import { Side, handIntent } from '../src/crossplay/intent';
import { Platform } from '../src/crossplay/platform';
import { registerActions } from '../src/derby/actions';
import { Builder, type BuilderBody } from '../src/derby/builder';
import type { DerbyContext, Vec3 } from '../src/derby/context';
import { Course, FINISH, GARAGE, TOP } from '../src/derby/course';
import { ACTIONS, ENTITIES, Phase, Racer, RacerMode } from '../src/derby/defs';
import { idleDerbyIntent, type DerbyIntent } from '../src/derby/intent';
import { PART_GUN, WRENCH, pickPart, rayBox } from '../src/derby/kit';
import {
  CELL,
  Dir,
  MAX_PARTS,
  PartKind,
  cleanDesign,
  connected,
  decodeDesign,
  designStats,
  encodeDesign,
  intact,
  placeProblem,
  starterDesign,
  withBroken,
  withPart,
  withoutPart,
} from '../src/derby/parts';
import { Physics, initPhysics, yawQuat } from '../src/derby/physics';
import { COUNTDOWN, RaceKeeper, standings } from '../src/derby/race';
import { RacerProxies, designOf } from '../src/derby/racer';
import { MemoryShelf, ShelfAction, SHELF_SLOTS, pickShelf, sameBytes, shelves } from '../src/derby/shelf';
import { Sim } from './harness';

const course = new Course(7);
const stub = () => new Proxy({}, { get: () => () => {} });

beforeAll(async () => {
  await initPhysics();
});

class TestBody implements BuilderBody {
  platform = Platform.Desktop;
  readonly counts: number[] = [];
  seatedNow = false;
  finishedIn = 0;
  moved(): void {}
  placed(): void {}
  hurt(): void {}
  used(): void {}
  died(): void {}
  seated(on: boolean): void {
    this.seatedNow = on;
  }
  countdown(n: number): void {
    this.counts.push(n);
  }
  crashed(): void {}
  finished(ms: number): void {
    this.finishedIn = ms;
  }
}

interface Player {
  ctx: DerbyContext;
  world: NetWorld;
  builder: Builder;
  body: TestBody;
  keeper: RaceKeeper;
  proxies: RacerProxies;
  intent: DerbyIntent;
  messages: string[];
}

function player(net: Sim, id: string, name: string, shelf = new MemoryShelf()): Player {
  const world = net.add(id, { worldId: 'derby-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 2048, cellSize: 512, interestRadius: 1400, spatialCellSize: 32 });
  const messages: string[] = [];
  const hud = { ...stub(), message: (text: string) => messages.push(text) };
  const physics = new Physics(course);
  const keeper = new RaceKeeper(world);
  const ctx = { world, course, physics, sfx: stub(), hud, fx: stub(), settings: stub(), shelf, me: null, racer: null, playerName: name, now: net.now, race: () => keeper.race } as unknown as DerbyContext;
  const builder = new Builder(ctx);
  const body = new TestBody();
  builder.attach(body);
  registerActions(ctx, builder);
  builder.spawn();
  return { ctx, world, builder, body, keeper, proxies: new RacerProxies(ctx), intent: idleDerbyIntent(), messages };
}

/** Run every player's frame, as Game does, for `seconds` of 1/60 s frames. */
function run(net: Sim, players: Player[], seconds: number, each?: () => void): void {
  const dt = 1 / 60;
  for (let f = 0; f < seconds * 60; f++) {
    net.now += 1000 / 60;
    net.net.pump(net.now);
    for (const p of players) {
      p.ctx.now = net.now;
      p.world.update(net.now);
      each?.();
      p.builder.update(dt, p.intent);
      p.keeper.update(dt, net.now);
      p.proxies.update();
      p.ctx.physics.step(dt);
      p.builder.afterPhysics(dt);
      p.intent.ready = false;
      p.intent.reset = false;
      p.intent.quit = false;
      p.intent.trigger = false;
      p.intent.part = null;
      p.intent.selectTool = null;
    }
  }
}

describe('Designs', () => {
  it('round-trip through their blob', () => {
    const design = starterDesign();
    const back = decodeDesign(encodeDesign(design));
    expect(back).toEqual(design);
    expect(decodeDesign(new Uint8Array([9, 9, 9]))[0].kind).toBe(PartKind.Seat);
  });

  it('only grow off faces of parts that can hold something, within limits', () => {
    const design = starterDesign();
    const block = design.findIndex((p) => p.kind === PartKind.Block && p.x === 1);
    const wheel = design.findIndex((p) => p.kind === PartKind.Wheel);
    expect(withPart(design, block, Dir.PZ, PartKind.Rocket)).toHaveLength(design.length + 1);
    expect(placeProblem(design, wheel, 1, 2, 0)).toBe('leaf');
    expect(placeProblem(design, 0, 1, 0, 0)).toBe('taken');
    expect(placeProblem(design, 0, 0, 0, 20)).toBe('too far');
    let big = design;
    for (let z = 1; big.length < MAX_PARTS; z++) {
      for (let y = -5; y <= 5 && big.length < MAX_PARTS; y++) big = [...big, { x: 3, y, z, kind: PartKind.Block, dir: Dir.PZ }];
    }
    expect(placeProblem(big, 0, 0, 0, -1)).toBe('full');
  });

  it('lose whatever was only held on by a part that comes off', () => {
    const design = starterDesign();
    const front = design.findIndex((p) => p.kind === PartKind.Block && p.x === 1);
    const removed: number[] = [];
    const after = withoutPart(design, front, removed)!;
    // the front block and both front wheels go
    expect(after).toHaveLength(design.length - 3);
    expect(removed).toHaveLength(3);
    expect(withoutPart(design, 0)).toBeNull();
    // nothing is held on through a wheel
    const wheel = design.findIndex((p) => p.kind === PartKind.Wheel);
    const through = [...design, { x: 1, y: 2, z: 0, kind: PartKind.Block, dir: Dir.PY }];
    expect(connected(through, new Set())[through.length - 1]).toBe(false);
    expect(intact(design, withBroken(new Uint8Array(0), [front])).filter(Boolean)).toHaveLength(design.length - 3);
    expect(wheel).toBeGreaterThan(0);
  });

  it('sit on their lowest part', () => {
    const stats = designStats(starterDesign());
    expect(stats.wheels).toBe(4);
    expect(stats.bottom).toBeCloseTo(-(0.15 + 0.3), 5);
  });
});

describe('Course', () => {
  it('is a flat garage on top of a track that runs downhill to the finish', () => {
    expect(course.heightAt((GARAGE.x0 + GARAGE.x1) / 2, 0)).toBe(TOP);
    const start = course.pointAt(40, 0);
    const end = course.pointAt(FINISH, 0);
    expect(end.z).toBeLessThan(start.z - 60);
    expect(new Course(7).pointAt(500, 3)).toEqual(course.pointAt(500, 3));
  });

  it('knows where along the track a point is', () => {
    for (const [u, lat] of [
      [100, 0],
      [333, 6],
      [700, -12],
    ]) {
      const p = course.pointAt(u, lat);
      const w = course.locate(p.x, p.y);
      expect(w.u).toBeCloseTo(u, 0);
      expect(w.lat).toBeCloseTo(lat, 0);
    }
    const p = course.pointAt(300, 0);
    expect(course.outOfBounds(p.x, p.y, p.z + 1)).toBe(false);
    expect(course.outOfBounds(p.x, p.y, p.z - 20)).toBe(true);
  });
});

describe('Building', () => {
  it('aims at the face of a part', () => {
    const hit = rayBox({ x: -2, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0, 0, 0, 0.25);
    expect(hit).toEqual({ t: 1.75, face: Dir.NX });
    expect(rayBox({ x: -2, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, 0, 0, 0, 0.25)).toBeNull();
  });

  it("lets a friend add parts to someone else's racer, which its owner makes", () => {
    const net = new Sim();
    const alice = player(net, 'alice', 'Alice');
    const bob = player(net, 'bob', 'Bob');
    run(net, [alice, bob], 2);
    const aliceRacer = alice.ctx.racer!;
    expect(aliceRacer.state.bay).not.toBe(bob.ctx.racer!.state.bay);
    const remote = bob.world.getAs(Racer, aliceRacer.id)!;
    expect(remote).toBeDefined();

    // Bob looks down at the top of Alice's seat from above it and fires a rocket onto it
    const s = remote.render;
    const origin: Vec3 = { x: s.x, y: s.y, z: s.z + 3 };
    const target = pickPart(bob.ctx, origin, { x: 0, y: 0, z: -1 });
    expect(target?.racer).toBe(remote);
    expect(target?.part).toBe(0);
    expect(target?.face).toBe(Dir.PZ);

    const b = bob.builder;
    b.part = PartKind.Rocket;
    const use = b.hand(Side.Right);
    Object.assign(use.origin, origin);
    Object.assign(use.aim, { x: 0, y: 0, z: -1 });
    PART_GUN.onUse(use as never);
    run(net, [alice, bob], 1);
    const design = designOf(aliceRacer, false).design;
    expect(design.some((p) => p.kind === PartKind.Rocket && p.x === 0 && p.y === 0 && p.z === 1)).toBe(true);
    expect(designOf(remote).design).toHaveLength(design.length);
    expect(alice.messages.some((m) => m.includes('Bob is working on your racer'))).toBe(true);

    // and takes it off again with the wrench
    Object.assign(use.origin, { x: s.x, y: s.y, z: s.z + 3 });
    Object.assign(use.aim, { x: 0, y: 0, z: -1 });
    WRENCH.onUse(use as never);
    run(net, [alice, bob], 1);
    expect(designOf(aliceRacer, false).design.some((p) => p.kind === PartKind.Rocket)).toBe(false);
  });

  it('builds with tracked hands, pointing the part gun', () => {
    const net = new Sim();
    const alice = player(net, 'alice', 'Alice');
    run(net, [alice], 1);
    const r = alice.ctx.racer!.state;
    const intent = alice.intent;
    const me = alice.ctx.me!.state;
    intent.head = { x: me.x, y: me.y, z: TOP + 1.7, heading: 0, pitch: 0 };
    intent.hands = [handIntent(), handIntent()];
    const right = intent.hands[Side.Right];
    Object.assign(right, { tracked: true, tool: PART_GUN, trigger: false });
    Object.assign(right.grip, { x: r.x - 2, y: r.y, z: r.z });
    Object.assign(right.tip, { x: r.x - 2, y: r.y, z: r.z });
    Object.assign(right.aim, { x: 1, y: 0, z: 0 });
    alice.builder.part = PartKind.Bumper;
    run(net, [alice], 0.1);
    // pointing at the back of the back block
    expect(alice.builder.aims[Side.Right].cell).toEqual({ x: -2, y: 0, z: 0 });
    right.trigger = true;
    run(net, [alice], 0.05);
    right.trigger = false;
    run(net, [alice], 0.2);
    expect(designOf(alice.ctx.racer!, false).design.some((p) => p.kind === PartKind.Bumper && p.x === -2)).toBe(true);
  });
});

describe('Building by touch', () => {
  it('uses the part gun along an aim the device gives, not only through the middle of the view', () => {
    const net = new Sim();
    const alice = player(net, 'alice', 'Alice');
    run(net, [alice], 1);
    const r = alice.ctx.racer!.state;
    const me = alice.ctx.me!.state;
    alice.builder.part = PartKind.Wing;
    // walk up to the racer, then look away from it, and tap on the seat's top
    alice.intent.forward = 1;
    run(net, [alice], 0.6);
    alice.intent.forward = 0;
    alice.intent.turn = Math.PI / 2;
    run(net, [alice], 1 / 60);
    alice.intent.turn = 0;
    expect(Math.hypot(r.x - me.x, r.y - me.y)).toBeLessThan(5);
    const eye = alice.builder.eyePosition({ x: 0, y: 0, z: 0 });
    const to = { x: r.x - eye.x, y: r.y - eye.y, z: r.z + CELL * 0.4 - eye.z };
    const len = Math.hypot(to.x, to.y, to.z);
    alice.intent.aim = { x: to.x / len, y: to.y / len, z: to.z / len };
    alice.intent.trigger = true;
    run(net, [alice], 1 / 60);
    alice.intent.aim = null;
    run(net, [alice], 0.2);
    expect(designOf(alice.ctx.racer!, false).design.some((p) => p.kind === PartKind.Wing && p.x === 0 && p.y === 0 && p.z === 1)).toBe(true);
  });
});

describe('Design shelves', () => {
  it('clean up designs from outside: seat first, one part a cell, in reach, and attached', () => {
    const design = cleanDesign([
      { x: 1, y: 0, z: 0, kind: PartKind.Block, dir: Dir.PX },
      { x: 1, y: 0, z: 0, kind: PartKind.Wheel, dir: Dir.PX },
      { x: 5, y: 5, z: 0, kind: PartKind.Block, dir: Dir.PX },
      { x: 40, y: 0, z: 0, kind: PartKind.Block, dir: Dir.PX },
      { x: 3, y: 0, z: 0, kind: PartKind.Seat, dir: Dir.PZ },
    ]);
    expect(design).toEqual([
      { x: 0, y: 0, z: 0, kind: PartKind.Seat, dir: Dir.PZ },
      { x: 1, y: 0, z: 0, kind: PartKind.Block, dir: Dir.PX },
    ]);
  });

  it('are found by a tool pointed at a SAVE plaque or a cubby', () => {
    const shelf = shelves(course)[0];
    const slot = shelf.slots[2];
    const eye = { x: shelf.front + 3, y: slot.y, z: TOP + 1.65 };
    const at = (z: number) => {
      const d = { x: shelf.front - eye.x, y: 0, z: z - eye.z };
      const n = Math.hypot(d.x, d.z);
      return pickShelf(course, eye, { x: d.x / n, y: 0, z: d.z / n }, 7);
    };
    expect(at(TOP + 2.2)).toMatchObject({ bay: 0, slot: 2, action: ShelfAction.Save });
    expect(at(TOP + 1.3)).toMatchObject({ bay: 0, slot: 2, action: ShelfAction.Load });
    expect(at(TOP + 0.4)).toBeNull();
    expect(shelf.slots).toHaveLength(SHELF_SLOTS);
  });

  it('save your racer, show it to everyone, and build it again', () => {
    const net = new Sim();
    const stored = new MemoryShelf();
    const alice = player(net, 'alice', 'Alice', stored);
    const bob = player(net, 'bob', 'Bob');
    run(net, [alice, bob], 2);
    const bay = alice.ctx.racer!.state.bay;
    const b = alice.builder;
    const starter = alice.ctx.racer!.state.design;

    b.pressShelf({ bay, slot: 1, action: ShelfAction.Save, distance: 2 });
    expect(sameBytes(stored.slots()[1], starter)).toBe(true);
    run(net, [alice, bob], 1);
    // Bob sees it on Alice's shelf, but can't save on it
    expect(sameBytes(bob.builder.savedAt(bay, 1), starter)).toBe(true);
    bob.builder.pressShelf({ bay, slot: 0, action: ShelfAction.Save, distance: 2 });
    expect(bob.messages.at(-1)).toContain("Alice's shelf");

    // Alice changes her racer, then asks for design 2 back: it isn't saved, so it takes a second go
    b.edit(0, 0, 0, 1, Dir.PZ, PartKind.Balloon);
    expect(designOf(alice.ctx.racer!, false).design).toHaveLength(8);
    b.pressShelf({ bay, slot: 1, action: ShelfAction.Load, distance: 2 });
    expect(designOf(alice.ctx.racer!, false).design).toHaveLength(8);
    b.pressShelf({ bay, slot: 1, action: ShelfAction.Load, distance: 2 });
    expect(sameBytes(alice.ctx.racer!.state.design, starter)).toBe(true);

    // Bob copies Alice's balloon cart, after she saves it over design 1 (which takes a second press)
    b.edit(0, 0, 0, 1, Dir.PZ, PartKind.Balloon);
    b.pressShelf({ bay, slot: 1, action: ShelfAction.Save, distance: 2 });
    expect(sameBytes(stored.slots()[1], starter)).toBe(true);
    b.pressShelf({ bay, slot: 1, action: ShelfAction.Save, distance: 2 });
    expect(sameBytes(stored.slots()[1], alice.ctx.racer!.state.design)).toBe(true);
    run(net, [alice, bob], 1);
    // Bob hasn't saved his own racer anywhere, so copying over it asks first too
    bob.builder.pressShelf({ bay, slot: 1, action: ShelfAction.Load, distance: 2 });
    bob.builder.pressShelf({ bay, slot: 1, action: ShelfAction.Load, distance: 2 });
    expect(designOf(bob.ctx.racer!, false).design.some((p) => p.kind === PartKind.Balloon)).toBe(true);
    expect(bob.messages.at(-1)).toContain("Copied Alice's design 2");
  });

  it('bring back your shelf and the racer you left, next time', () => {
    const net = new Sim();
    const stored = new MemoryShelf();
    const alice = player(net, 'alice', 'Alice', stored);
    run(net, [alice], 1);
    alice.builder.edit(0, 0, 0, 1, Dir.PZ, PartKind.Rocket);
    alice.builder.pressShelf({ bay: alice.ctx.racer!.state.bay, slot: 3, action: ShelfAction.Save, distance: 2 });
    alice.builder.edit(0, -1, 0, 1, Dir.PZ, PartKind.Wing);
    run(net, [alice], 0.5);

    const later = new Sim();
    const again = player(later, 'alice2', 'Alice', stored);
    run(later, [again], 1);
    const design = designOf(again.ctx.racer!, false).design;
    expect(design.some((p) => p.kind === PartKind.Rocket) && design.some((p) => p.kind === PartKind.Wing)).toBe(true);
    // design 4 was saved before the wing went on
    const saved = decodeDesign(again.ctx.me!.state.save3);
    expect(saved.some((p) => p.kind === PartKind.Rocket) && !saved.some((p) => p.kind === PartKind.Wing)).toBe(true);
  });
});

describe('Racing', () => {
  it('goes from ready to the grid to the go, and home again when it is over', () => {
    const net = new Sim();
    const alice = player(net, 'alice', 'Alice');
    run(net, [alice], 4);
    const race = alice.keeper.race!;
    expect(race).toBeTruthy();
    expect(race.state.phase).toBe(Phase.Building);

    alice.intent.ready = true;
    run(net, [alice], 0.5);
    expect(race.state.phase).toBe(Phase.Countdown);
    expect(alice.ctx.racer!.state.mode).toBe(RacerMode.Gridded);
    expect(alice.body.seatedNow).toBe(true);
    const grid = alice.ctx.racer!.state;
    expect(grid.x).toBeGreaterThan(GARAGE.x1);

    run(net, [alice], COUNTDOWN + 0.5);
    expect(race.state.phase).toBe(Phase.Racing);
    expect(alice.ctx.racer!.state.mode).toBe(RacerMode.Racing);
    expect(alice.body.counts).toEqual([3, 2, 1, 0]);

    // the builder rides along in the seat
    const me = alice.ctx.me!.state;
    expect(Math.hypot(me.x - grid.x, me.y - grid.y)).toBeLessThan(0.1);
    expect(me.seated).toBe(true);
    expect(standings(alice.world, race.state.round)).toEqual([alice.ctx.racer]);
  });

  it('steers left as you see it: toward -y, since the scene draws +y on your right', () => {
    const net = new Sim();
    const alice = player(net, 'alice', 'Alice');
    run(net, [alice], 4);
    alice.intent.ready = true;
    run(net, [alice], COUNTDOWN + 1);
    const r = alice.ctx.racer!.state;
    const heading = () => Math.atan2(2 * (r.qw * r.qz + r.qx * r.qy), 1 - 2 * (r.qy * r.qy + r.qz * r.qz));
    alice.intent.push = true;
    run(net, [alice], 1.5);
    const before = heading();
    alice.intent.steer = 1;
    run(net, [alice], 0.5);
    expect(heading() - before).toBeLessThan(-0.1);
  });

  it('lets a driver give up and go back to the garage, and still shows them in the standings', () => {
    const net = new Sim();
    const alice = player(net, 'alice', 'Alice');
    const bob = player(net, 'bob', 'Bob');
    run(net, [alice, bob], 4);
    alice.intent.ready = true;
    bob.intent.ready = true;
    run(net, [alice, bob], COUNTDOWN + 1);
    const race = alice.keeper.race!;
    expect(race.state.phase).toBe(Phase.Racing);

    alice.intent.quit = true;
    run(net, [alice, bob], 0.2);
    alice.intent.quit = false;
    const r = alice.ctx.racer!.state;
    expect(r.mode).toBe(RacerMode.Parked);
    expect(r.quit).toBe(true);
    expect(alice.ctx.me!.state.seated).toBe(false);
    expect(r.x).toBeLessThan(GARAGE.x1);
    // bob's still racing, so the race goes on, with alice last
    run(net, [alice, bob], 1);
    expect(race.state.phase).toBe(Phase.Racing);
    expect(standings(bob.world, race.state.round).map((e) => e.id)).toEqual([bob.ctx.racer!.id, alice.ctx.racer!.id]);
    expect(bob.messages.some((m) => m.includes('Alice gave up'))).toBe(true);
  });

  it('rolls a starter racer all the way down the hill, steered by a simple bot', () => {
    const net = new Sim();
    const alice = player(net, 'alice', 'Alice');
    run(net, [alice], 4);
    alice.intent.ready = true;
    run(net, [alice], COUNTDOWN + 1);
    const r = alice.ctx.racer!;
    expect(r.state.mode).toBe(RacerMode.Racing);

    const drive = () => {
      const s = r.state;
      const w = course.locate(s.x, s.y);
      const ahead = course.pointAt(Math.min(w.u + 14, 960), 0);
      const heading = Math.atan2(2 * (s.qw * s.qz + s.qx * s.qy), 1 - 2 * (s.qy * s.qy + s.qz * s.qz));
      let want = Math.atan2(ahead.y - s.y, ahead.x - s.x) - heading;
      want = Math.atan2(Math.sin(want), Math.cos(want));
      alice.intent.steer = Math.max(-1, Math.min(1, -want * 2.5)); // + steers left as you see it: toward -y
      alice.intent.push = s.speed < 5;
      alice.intent.brake = s.speed > 24;
    };
    let lost = 0;
    for (let t = 0; t < 240 && r.state.mode === RacerMode.Racing; t += 1) {
      run(net, [alice], 1, drive);
      if (r.state.broken.some((bits) => bits)) lost++;
    }
    expect(r.state.progress).toBeGreaterThan(FINISH - 1);
    expect(r.state.mode === RacerMode.Finished || alice.keeper.race!.state.phase !== Phase.Racing).toBe(true);
    expect(alice.body.finishedIn).toBeGreaterThan(20_000);
    // the jumps have landings: an ordinary cart can take them without falling to bits
    expect(lost).toBe(0);
  }, 60_000);

  it('tears parts off a racer that hits a wall hard, and others see them go', () => {
    const net = new Sim();
    const alice = player(net, 'alice', 'Alice');
    const bob = player(net, 'bob', 'Bob');
    run(net, [alice, bob], 4);
    alice.intent.ready = true;
    bob.intent.ready = true;
    run(net, [alice, bob], COUNTDOWN + 1);
    const r = alice.ctx.racer!;
    // fling it sideways into the wall of the track
    const p = course.pointAt(300, 0);
    const body = alice.builder.racer.body;
    body.place(p.x, p.y, p.z + 1, yawQuat(p.heading));
    const left = { x: -Math.sin(p.heading), y: Math.cos(p.heading) };
    body.body.setLinvel({ x: left.x * 45, y: left.y * 45, z: 0 }, true);
    run(net, [alice, bob], 1.5);
    const lost = designOf(r, false).keep.filter((k) => !k).length;
    expect(lost).toBeGreaterThan(0);
    expect(bob.ctx.physics.debris.length).toBeGreaterThan(0);
    expect(designOf(bob.world.getAs(Racer, r.id)!).keep.filter((k) => !k).length).toBe(lost);
    expect(CELL).toBe(0.5);
  });
});
