import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Holsters } from '../src/crossplay/holsters';
import { Inventory } from '../src/crossplay/inventory';
import { Rig, type XRHand } from '../src/crossplay/rig';
import { Tool, Toolbox } from '../src/crossplay/tool';
import type { Hud } from '../src/wilds/hud';
import type { WildTool } from '../src/wilds/kit';
import { VrPack } from '../src/wilds/pack';

const geom = (): THREE.BufferGeometry => new THREE.BoxGeometry(0.08, 0.08, 0.4);
const AXE = new Tool({ name: 'Axe', model: { build: geom, length: 0.5 }, grip: { tip: [0, 0, -0.5] }, stash: [{ at: [0.2, -0.3, 0.2] }], color: 0, issued: 1 });
/** Stashed across the middle of the back, with a shaft long enough to reach the pack: the axe and hoe are like this. */
const POLE = new Tool({
  name: 'Pole',
  model: { build: () => new THREE.BoxGeometry(0.06, 0.06, 1.4), length: 1.4 },
  grip: { tip: [0, 0, -1.4] },
  stash: [{ at: [0, -0.35, 0.22], pitch: Math.PI / 2 }],
  color: 0,
  issued: 1,
});
const LOGS = new Tool({
  name: 'Logs',
  model: { build: geom, length: 0.4 },
  grip: { tip: [0, 0, -0.2] },
  stash: [{ at: [0, -0.5, 0.2] }],
  color: 0,
  charges: { pickup: 1, max: 10, unit: 'logs' },
  selectOnPickup: false,
  stows: true,
});

/** The head, and so the torso hanging under it: its origin is 0.2 below and 0.1 behind the eyes (torso.ts). */
const HEAD = new THREE.Vector3(0, 1.65, 0);
const TORSO = new THREE.Vector3(HEAD.x, HEAD.y - 0.2, HEAD.z + 0.1);
/** Where a hand has to be for its grip (GRIP_IN_HAND) to land on a point in torso space. */
const handFor = (x: number, y: number, z: number) => new THREE.Vector3(TORSO.x + x, TORSO.y + y + 0.03, TORSO.z + z - 0.05);
/** The pack between the shoulder blades, and where its contents float in front of the chest when it's open (pack.ts). */
const ON_BACK = handFor(0, -0.15, 0.26);
const OPEN_SLOT = handFor(0, -0.34, -0.34);
const OUT_IN_FRONT = handFor(0.3, -0.2, -0.7);

function setup() {
  const rig = new Rig(new THREE.Scene(), 1);
  rig.setMode('sim'); // both controllers connected
  rig.headLocal.copy(HEAD);
  const inv = new Inventory<WildTool>(new Toolbox([AXE, POLE, LOGS]) as Toolbox<WildTool>);
  inv.add(LOGS as WildTool, 4);
  const holsters = new Holsters(rig);
  const hud = { message() {} } as unknown as Hud;
  const pack = new VrPack(rig, holsters, inv, hud);
  const step = () => {
    holsters.update(inv);
    pack.update();
  };
  /** Put a hand somewhere and squeeze (or let go), then run a frame. */
  const hand = (h: XRHand, at: THREE.Vector3, squeeze: number) => {
    h.object.position.copy(at);
    h.squeeze = squeeze;
    step();
  };
  step();
  return { rig, holsters, inv, pack, step, hand, right: rig.right };
}

describe('VrPack (VR)', () => {
  it('keeps what you gather off the body until you take it out of the pack', () => {
    const { inv, holsters, hand, right, step } = setup();
    const onBody = () => (holsters as unknown as { items: { tool: Tool }[] }).items.map((i) => i.tool);
    expect(inv.inPack(LOGS as WildTool)).toBe(true);
    expect(onBody()).toEqual([AXE, POLE]);

    // reach behind a shoulder and squeeze: the pack opens and the logs float out in front
    hand(right, ON_BACK, 1);
    expect(inv.inPack(LOGS as WildTool)).toBe(true);
    expect(onBody()).toEqual([AXE, POLE]); // opening it doesn't put anything on you

    // squeeze an empty hand on them to take them out, and they go onto your body
    hand(right, ON_BACK, 0);
    hand(right, OPEN_SLOT, 1);
    expect(inv.inPack(LOGS as WildTool)).toBe(false);
    step(); // the body catches up with the inventory on the next frame
    expect(onBody()).toContain(LOGS);
    expect(inv.charges(LOGS as WildTool)).toBe(4); // carried all along, either way
  });

  it('puts a tool back when you let it go in the open pack, but not out in the open', () => {
    const { inv, holsters, hand, right } = setup();
    hand(right, ON_BACK, 1); // open
    hand(right, ON_BACK, 0);
    hand(right, OPEN_SLOT, 1); // take the logs out
    hand(right, OPEN_SLOT, 0);

    // pick them up off the body and let go in mid-air: they stay on the body
    const stash = handFor(0, -0.5, 0.2);
    hand(right, stash, 1);
    expect(holsters.held(right)).toBe(LOGS);
    hand(right, OUT_IN_FRONT, 0);
    expect(inv.inPack(LOGS as WildTool)).toBe(false);

    // take them again and let go inside the open pack: away they go
    hand(right, stash, 1);
    expect(holsters.held(right)).toBe(LOGS);
    hand(right, OPEN_SLOT, 0);
    expect(inv.inPack(LOGS as WildTool)).toBe(true);
    expect(holsters.held(right)).toBeNull();
  });

  it('has the pack, not a tool stashed across the back, for a hand on it', () => {
    const { holsters, hand, right, pack } = setup();
    hand(right, ON_BACK, 1);
    expect(holsters.held(right)).toBeNull(); // the pole's shaft passes right by, and the pack still wins
    expect((pack as unknown as { open: boolean }).open).toBe(true);

    // and the pole is still there to take by its own spot
    hand(right, ON_BACK, 0);
    hand(right, handFor(0, -0.35, 0.22), 1);
    expect(holsters.held(right)).toBe(POLE);
  });

  it('closes again on a second squeeze, and then nothing comes out of it', () => {
    const { inv, hand, right } = setup();
    hand(right, ON_BACK, 1);
    hand(right, ON_BACK, 0);
    hand(right, ON_BACK, 1); // closed
    hand(right, ON_BACK, 0);
    hand(right, OPEN_SLOT, 1);
    expect(inv.inPack(LOGS as WildTool)).toBe(true);
  });
});
