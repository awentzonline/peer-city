import { describe, expect, it } from 'vitest';
import { PISTOL, RIFLE, SMG } from '../src/fps/arsenal';
import { AvatarSim, type AvatarBody } from '../src/fps/avatar';
import { City, TILE } from '../src/fps/city';
import type { GameContext } from '../src/fps/context';
import { ACTIONS, Car, CarKind, CarMode, ENTITIES } from '../src/fps/defs';
import { Side, handIntent, idleIntent, type AvatarIntent, type HandIntent, type TrackedHead } from '../src/fps/intent';
import { Platform } from '../src/fps/platform';
import { NO_TOOL, type HitResult, type Tool, type UseEffect } from '../src/fps/tool';
import { Sim } from './harness';

const city = new City(20260914);
// a building with open ground directly to its west
const building = city.buildings.find((b) => b.height > 8 && city.heightAt(b.tx - 1, b.ty) === 0 && !city.isSolidTile(b.tx - 1, b.ty))!;
const wallX = building.tx * TILE;
const alongY = (building.ty + 0.5) * TILE;

/** Anything a headless test doesn't care about: every property is a do-nothing function. */
const stub = () => new Proxy({}, { get: () => () => {} });

/** Records what the rules asked of the device, and carries a headset's head along like a real play space. */
class TestBody implements AvatarBody {
  platform = Platform.Vr;
  readonly head: TrackedHead = { x: 0, y: 0, z: 1.7, heading: 0, pitch: 0 };
  readonly shots: [Side | null, Tool, HitResult | undefined][] = [];
  seats = 0;
  placedAt: { x: number; y: number } | null = null;

  moved(dx: number, dy: number): void {
    this.head.x += dx;
    this.head.y += dy;
  }

  placed(x: number, y: number): void {
    this.head.x = x;
    this.head.y = y;
    this.placedAt = { x, y };
  }

  seated(): void {
    this.seats++;
  }

  hurt(): void {}

  used(side: Side | null, tool: Tool, effect: UseEffect): void {
    this.shots.push([side, tool, effect.hit]);
  }

  died(): void {}
}

function setup() {
  const net = new Sim();
  const world = net.add('me', { worldId: 'avatar-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 256, cellSize: 64, interestRadius: 170, spatialCellSize: 24 });
  const ctx = { world, city, sfx: stub(), hud: stub(), fx: stub(), scene: stub(), me: null, playerName: 'Tester', now: net.now } as unknown as GameContext;
  const avatar = new AvatarSim(ctx);
  const body = new TestBody();
  avatar.body = body;
  avatar.spawn();
  const me = ctx.me!;
  const s = me.state;
  /** Run the rules for `n` frames of 16ms. */
  const frames = (n: number, intent: AvatarIntent) => {
    for (let i = 0; i < n; i++) {
      net.now += 16;
      ctx.now = net.now;
      avatar.update(0.016, intent);
      world.update(net.now);
    }
  };
  /** Stand at (x, y) with the headset right above. */
  const standAt = (x: number, y: number) => {
    Object.assign(s, { x, y });
    Object.assign(body.head, { x, y });
  };
  return { world, avatar, body, me, s, frames, standAt };
}

function hand(tool: Tool | null, x: number, y: number): HandIntent {
  const h = handIntent();
  Object.assign(h, { tracked: true, tool, trigger: true, pointing: { x: 0, y: 0, z: 1 }, aim: { x: 0, y: 0, z: 1 } });
  Object.assign(h.grip, { x, y, z: 1.3 });
  Object.assign(h.tip, { x, y, z: 1.5 });
  return h;
}

describe('AvatarSim', () => {
  it('walks a virtual head up to a wall and stops there', () => {
    const { avatar, body, s, frames } = setup();
    body.platform = Platform.Desktop;
    Object.assign(s, { x: wallX - 1.5, y: alongY });
    avatar.heading = 0; // east, towards the wall
    const intent = idleIntent();
    intent.forward = 1;
    frames(60, intent);
    expect(s.x).toBeLessThan(wallX);
    expect(s.x).toBeCloseTo(wallX - 0.35, 1);
    expect(s.y).toBeCloseTo(alongY, 5);
    expect(s.yaw).toBe(0);
  });

  it('keeps a tracked head out of walls by pushing the play space back', () => {
    const { body, s, frames } = setup();
    Object.assign(s, { x: wallX - 1.5, y: alongY });
    const intent = idleIntent();
    intent.head = body.head;

    // first frame: the play space jumps so the head is over the avatar
    Object.assign(body.head, { x: s.x + 50, y: s.y - 20 });
    frames(1, intent);
    expect(body.head.x).toBeCloseTo(wallX - 1.5, 6);
    expect(body.head.y).toBeCloseTo(alongY, 6);

    // walking 2m into the wall for real: the avatar stops, and the room slides back so the head stops too
    for (let i = 0; i < 40; i++) {
      body.head.x += 0.05;
      frames(1, intent);
    }
    expect(s.x).toBeLessThan(wallX);
    expect(s.x).toBeCloseTo(wallX - 0.35, 1);
    expect(body.head.x).toBeCloseTo(s.x, 6);
  });

  it('eases tracked stick locomotion up to a top speed and brakes quicker', () => {
    const { body, s, frames, standAt } = setup();
    const heading = Array.from({ length: 16 }, (_, i) => (i * Math.PI) / 8).find((h) => city.raycast(s.x, s.y, h, 20) >= 20)!;
    expect(heading).toBeDefined();
    standAt(s.x, s.y);
    body.head.heading = heading;
    const intent = idleIntent();
    intent.head = body.head;
    let last = { x: s.x, y: s.y };
    const speed = () => {
      const v = Math.hypot(s.x - last.x, s.y - last.y) / 0.016;
      last = { x: s.x, y: s.y };
      return v;
    };

    intent.forward = 1;
    frames(5, intent);
    speed();
    frames(1, intent);
    expect(speed()).toBeLessThan(3.5);
    frames(56, intent);
    speed();
    frames(1, intent);
    expect(speed()).toBeGreaterThan(6.8);
    expect(body.head.x).toBeCloseTo(s.x, 6);

    intent.forward = 0;
    frames(30, intent);
    speed();
    frames(1, intent);
    expect(speed()).toBeLessThan(0.2);
  });

  it('fires the gun in each tracked hand, spending their shared ammo', () => {
    const { avatar, body, s, frames, standAt } = setup();
    standAt(s.x, s.y);
    avatar.inventory.add(SMG, 30);
    avatar.inventory.add(SMG, 30);
    const before = avatar.inventory.charges(SMG);
    const intent = idleIntent();
    intent.head = body.head;
    intent.hands = [hand(SMG, s.x + 0.2, s.y), hand(SMG, s.x - 0.2, s.y)];

    frames(1, intent);
    expect(avatar.inventory.charges(SMG)).toBe(before - 2);
    expect(body.shots).toEqual([
      [Side.Left, SMG, 'miss'],
      [Side.Right, SMG, 'miss'],
    ]);
    expect([s.tool, s.ltool]).toEqual([SMG.id, SMG.id]);
    expect(s.platform).toBe(Platform.Vr);

    // put the left gun away: the right one is what's replicated and what you'd drop
    intent.hands[Side.Left].tool = null;
    frames(1, intent);
    expect([s.tool, s.ltool]).toEqual([SMG.id, NO_TOOL]);
    expect(avatar.inventory.current).toBe(SMG);
  });

  it('switches the crosshair gun and fires it from the eyes', () => {
    const { avatar, body, s, frames } = setup();
    body.platform = Platform.Desktop;
    avatar.inventory.add(RIFLE, 30);
    expect(avatar.inventory.current).toBe(RIFLE);
    avatar.pitch = 1.4; // at the sky
    const intent = idleIntent();
    intent.selectTool = PISTOL;
    intent.trigger = true;
    frames(1, intent);
    expect(body.shots).toEqual([[null, PISTOL, 'miss']]);
    expect([s.tool, s.ltool]).toEqual([PISTOL.id, NO_TOOL]);
    expect(s.platform).toBe(Platform.Desktop);
  });

  it('gets into a nearby car, drives it and gets back out', async () => {
    const { world, body, me, s, frames } = setup();
    body.platform = Platform.Desktop;
    const car = world.spawn(Car, { x: s.x, y: s.y + 2.5, kind: CarKind.Sedan, mode: CarMode.Parked });
    const intent = idleIntent();
    intent.interact = true;
    frames(1, intent);
    await new Promise((resolve) => setTimeout(resolve, 0)); // ownership is granted asynchronously
    expect(s.car).toBe(car.id);
    expect(car.state.driver).toBe(me.id);
    expect(body.seats).toBe(1);

    intent.interact = false;
    intent.forward = 1;
    const start = { x: car.state.x, y: car.state.y };
    frames(40, intent);
    expect(Math.hypot(car.state.x - start.x, car.state.y - start.y)).toBeGreaterThan(0.5);
    expect([s.x, s.y]).toEqual([car.state.x, car.state.y]);

    intent.forward = 0;
    intent.interact = true;
    frames(1, intent);
    expect(s.car).toBe(0);
    expect(car.state.mode).toBe(CarMode.Abandoned);
    expect(body.placedAt).toEqual({ x: s.x, y: s.y });
  });
});
