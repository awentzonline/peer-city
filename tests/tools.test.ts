import { BoxGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { AvatarSim, type AvatarBody } from '../src/fps/avatar';
import { City } from '../src/fps/city';
import type { GameContext, Vec3 } from '../src/fps/context';
import { ACTIONS, ENTITIES, Pickup, PickupKind } from '../src/fps/defs';
import { Side } from '../src/crossplay/intent';
import { Platform } from '../src/crossplay/platform';
import { handIntent, idleIntent, type AvatarIntent } from '../src/fps/intent';
import { NO_TOOL, Tool, Toolbox, type Drop, type PickedUp, type ToolOptions, type ToolUse, type UseEffect } from '../src/fps/tool';
import { Sim } from './harness';

const city = new City(20260914);
const stub = () => new Proxy({}, { get: () => () => {} });

const options = (o: Partial<ToolOptions> = {}): ToolOptions => ({
  name: 'Probe',
  model: { build: () => new BoxGeometry(0.05, 0.05, 0.3), length: 0.3 },
  grip: { tip: [0, 0, -0.3] },
  color: 0xffffff,
  ...o,
});

/** A tool that writes down the hooks it gets. Each use spends a charge and feels like a light hit. */
class Probe extends Tool {
  readonly log: string[] = [];

  constructor(o: Partial<ToolOptions> = {}) {
    super(options(o));
  }

  override onPickup(_avatar: AvatarSim, got: PickedUp): void {
    this.log.push(`pickup kept=${got.kept} count=${got.count} charges=${got.charges}`);
  }

  override onDrop(avatar: AvatarSim, drop: Drop): void {
    this.log.push(`drop ${drop.reason} ${drop.charges}`);
    super.onDrop(avatar, drop);
  }

  override onEquip(hand: ToolUse): void {
    this.log.push(`equip ${hand.side}`);
  }

  override onUnequip(hand: ToolUse): void {
    this.log.push(`unequip ${hand.side}`);
  }

  override onUse(hand: ToolUse): void {
    this.log.push('use');
    hand.spend();
    hand.effect({ kick: 0.5, hit: 'body' });
  }

  override onRelease(hand: ToolUse): void {
    this.log.push(`release after ${hand.avatar.ctx.now - hand.pressedAt!}ms`);
  }
}

function setup(...tools: Tool[]) {
  const net = new Sim();
  const world = net.add('me', { worldId: 'tools-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 256, cellSize: 64, interestRadius: 170, spatialCellSize: 24 });
  const ctx = { world, city, sfx: stub(), hud: stub(), fx: stub(), scene: stub(), me: null, playerName: 'Tester', now: net.now } as unknown as GameContext;
  const avatar = new AvatarSim(ctx, new Toolbox(tools));
  const uses: [Side | null, Tool, UseEffect][] = [];
  const body: AvatarBody = { platform: Platform.Desktop, moved() {}, placed() {}, seated() {}, hurt() {}, died() {}, used: (side, tool, effect) => uses.push([side, tool, effect]) };
  avatar.body = body;
  avatar.spawn();
  const s = ctx.me!.state;
  /** Run the rules for `n` frames of 16ms. */
  const frames = (n: number, intent: AvatarIntent) => {
    for (let i = 0; i < n; i++) {
      net.now += 16;
      ctx.now = net.now;
      avatar.update(0.016, intent);
      world.update(net.now);
    }
  };
  return { world, avatar, uses, s, frames };
}

describe('Tool hooks', () => {
  it('picks a tool up, then equips, uses and releases it in the crosshair hand', async () => {
    const probe = new Probe({ charges: { pickup: 5, max: 10 }, cooldownMs: 100 });
    const { world, avatar, uses, s, frames } = setup(probe);
    world.spawn(Pickup, { x: s.x, y: s.y, kind: PickupKind.Tool, tool: probe.id, amount: 5 });
    const intent = idleIntent();
    frames(1, intent);
    await new Promise((resolve) => setTimeout(resolve, 0)); // ownership is granted asynchronously
    expect(avatar.inventory.current).toBe(probe);
    expect(world.all(Pickup).size).toBe(0);

    frames(1, intent);
    intent.trigger = true;
    frames(10, intent); // held for 160ms, but it isn't automatic
    intent.trigger = false;
    frames(1, intent);
    expect(probe.log).toEqual(['pickup kept=true count=1 charges=5', 'equip null', 'use', 'release after 160ms']);
    expect(avatar.inventory.charges(probe)).toBe(4);
    expect(uses).toEqual([[null, probe, { kick: 0.5, hit: 'body' }]]);
    expect(s.tool).toBe(probe.id);
  });

  it('keeps using an automatic tool while the trigger is held, as often as its cooldown allows', () => {
    const probe = new Probe({ issued: 1, automatic: true, cooldownMs: 100 });
    const { frames } = setup(probe);
    const intent = idleIntent();
    intent.trigger = true;
    frames(20, intent); // 320ms: uses at 0, 112 and 224ms
    expect(probe.log.filter((l) => l === 'use')).toHaveLength(3);
  });

  it('drops a kind when it runs out, and the tool in hand where you die', () => {
    const probe = new Probe();
    const spare = new Probe({ name: 'Spare', charges: { pickup: 3, max: 10 } });
    const spent = new Probe({ name: 'Spent', charges: { pickup: 1, max: 10 } });
    const { world, avatar, s, frames } = setup(probe, spare, spent);
    avatar.inventory.add(spent, 1);
    const intent = idleIntent();
    intent.trigger = true;
    frames(1, intent);
    intent.trigger = false;
    frames(1, intent);
    expect(spent.log).toEqual(['equip null', 'use', 'drop spent 0', 'unequip null']);
    expect(s.tool).toBe(NO_TOOL);

    avatar.inventory.add(probe, 0);
    avatar.inventory.add(spare, 3);
    avatar.inventory.select(spare);
    avatar.die(null);
    expect(probe.log).toEqual(['drop lost 0']);
    expect(spare.log).toEqual(['drop dropped 3']);
    const dropped = [...world.all(Pickup)].filter((p) => p.state.kind === PickupKind.Tool);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].state.tool).toBe(spare.id);
    expect(dropped[0].state.amount).toBe(3);
    expect(dropped[0].state.x).toBeCloseTo(s.x - 1, 1);
  });

  it('uses a tool in a tracked hand from its tip, the way it points', () => {
    const seen: { side: Side | null; origin: Vec3; aim: Vec3 }[] = [];
    const pointer = new (class extends Tool {
      override onUse(hand: ToolUse): void {
        seen.push({ side: hand.side, origin: { ...hand.origin }, aim: { ...hand.aim } });
      }
    })(options({ issued: 2 }));
    const { s, frames } = setup(pointer);
    const left = handIntent();
    Object.assign(left, { tracked: true, tool: pointer, trigger: true, aim: { x: 0, y: 1, z: 0 } });
    Object.assign(left.tip, { x: s.x + 0.3, y: s.y, z: 1.2 });
    const intent = idleIntent();
    intent.hands = [handIntent(), left];
    frames(1, intent);
    expect(seen).toEqual([{ side: Side.Left, origin: { x: s.x + 0.3, y: s.y, z: 1.2 }, aim: { x: 0, y: 1, z: 0 } }]);
    expect([s.tool, s.ltool]).toEqual([NO_TOOL, pointer.id]);
  });
});
