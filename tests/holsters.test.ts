import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Holsters } from '../src/crossplay/holsters';
import { Inventory } from '../src/crossplay/inventory';
import type { Vec3 } from '../src/crossplay/math';
import { toolMesh } from '../src/crossplay/models';
import { Rig, type XRHand } from '../src/crossplay/rig';
import { PISTOL, RIFLE, TOOLS } from '../src/fps/arsenal';
import { Tool, Toolbox } from '../src/fps/tool';

// Stand-in gun models (1m-long boxes), so no GLB loading is needed.
vi.mock('../src/crossplay/assets', async () => {
  const T = await import('three');
  return {
    assetGeometry: () => {
      const g = new T.BoxGeometry(0.05, 0.12, 1).toNonIndexed();
      g.computeBoundingBox();
      return g;
    },
  };
});

type Spot = [number, number, number];
const RIGHT_HIP: Spot = [0.22, -0.68, -0.05];
const LEFT_HIP: Spot = [-0.22, -0.68, -0.05];
const RIGHT_SHOULDER: Spot = [0.2, -0.12, 0.25];
const OUT_FRONT: Spot = [0.2, -0.3, -0.35];

interface ItemView {
  tool: Tool;
  group: THREE.Group;
}

function setup(inv: Inventory = new Inventory(TOOLS)) {
  const rig = new Rig(new THREE.Scene(), 1);
  rig.setMode('sim'); // both controllers connected
  rig.headLocal.set(0, 1.65, 0);
  const holsters = new Holsters(rig);
  if (inv.tools === TOOLS) inv.add(RIFLE, 30);
  holsters.update(inv);
  /** Put a hand somewhere relative to the head. */
  const reach = (hand: XRHand, [x, y, z]: Spot) => hand.object.position.copy(rig.headLocal).add(new THREE.Vector3(x, y, z));
  const squeeze = (hand: XRHand, v: number) => {
    hand.squeeze = v;
    holsters.update(inv);
  };
  const items = (tool: Tool) => (holsters as unknown as { items: ItemView[] }).items.filter((g) => g.tool === tool).map((g) => g.group);
  return { rig, holsters, inv, right: rig.right, left: rig.left, reach, squeeze, items };
}

describe('Holsters (VR)', () => {
  it('keeps everything carried on the body and starts with empty hands', () => {
    const { holsters, right, left, items } = setup();
    expect(holsters.held(right)).toBeNull();
    expect(holsters.held(left)).toBeNull();
    expect(items(PISTOL)).toHaveLength(2);
    expect(items(RIFLE)).toHaveLength(1);
    for (const g of [...items(PISTOL), ...items(RIFLE)]) expect(g.parent).toBe(holsters.torso.object);
  });

  it('grabs a pistol from the hip and the rifle from over the shoulder, and nothing out in front', () => {
    const { holsters, right, reach, squeeze } = setup();
    reach(right, OUT_FRONT);
    squeeze(right, 1);
    expect(holsters.held(right)).toBeNull();
    squeeze(right, 0);

    reach(right, RIGHT_HIP);
    squeeze(right, 1);
    expect(holsters.held(right)).toBe(PISTOL);
    reach(right, OUT_FRONT);
    squeeze(right, 0);

    reach(right, RIGHT_SHOULDER);
    squeeze(right, 1);
    expect(holsters.held(right)).toBe(RIFLE);
  });

  it('draws a pistol in each hand', () => {
    const { holsters, right, left, reach, squeeze } = setup();
    reach(right, RIGHT_HIP);
    reach(left, LEFT_HIP);
    squeeze(right, 1);
    squeeze(left, 1);
    expect(holsters.held(right)).toBe(PISTOL);
    expect(holsters.held(left)).toBe(PISTOL);
  });

  it('stashes a second gun of a kind when you pick one up', () => {
    const { holsters, inv, right, reach, squeeze, items } = setup();
    reach(right, RIGHT_SHOULDER);
    squeeze(right, 1);
    inv.add(RIFLE, 30);
    holsters.update(inv);
    const rifles = items(RIFLE);
    expect(rifles).toHaveLength(2);
    expect(rifles.filter((g) => g.parent === holsters.torso.object)).toHaveLength(1);
  });

  it('only grabs on a fresh squeeze', () => {
    const { holsters, right, reach, squeeze } = setup();
    reach(right, OUT_FRONT);
    squeeze(right, 1);
    reach(right, RIGHT_HIP);
    squeeze(right, 1);
    expect(holsters.held(right)).toBeNull();
    squeeze(right, 0);
    squeeze(right, 1);
    expect(holsters.held(right)).toBe(PISTOL);
  });

  it('returns a gun let go in the air, and freezes one let go against the body', () => {
    const { holsters, right, reach, squeeze } = setup();
    reach(right, RIGHT_HIP);
    squeeze(right, 1);
    reach(right, [0.3, -0.2, -0.6]);
    squeeze(right, 0);
    expect(holsters.held(right)).toBeNull();

    // the same pistol comes back out of the right hip
    reach(right, RIGHT_HIP);
    squeeze(right, 1);
    expect(holsters.held(right)).toBe(PISTOL);
    const chest: Spot = [0.05, -0.45, -0.1];
    reach(right, chest);
    squeeze(right, 0);
    expect(holsters.held(right)).toBeNull();

    // the right hip is empty now; the pistol is on the chest
    reach(right, RIGHT_HIP);
    squeeze(right, 1);
    expect(holsters.held(right)).toBeNull();
    squeeze(right, 0);
    reach(right, chest);
    squeeze(right, 1);
    expect(holsters.held(right)).toBe(PISTOL);
  });

  it('empties the hand when the gun in it runs dry', () => {
    const { holsters, inv, right, reach, squeeze } = setup();
    reach(right, RIGHT_SHOULDER);
    squeeze(right, 1);
    expect(holsters.held(right)).toBe(RIFLE);
    for (let i = 0; i < 30; i++) inv.spend(RIFLE);
    holsters.update(inv);
    expect(holsters.held(right)).toBeNull();
  });

  it('keeps what is in the pack off the body, and puts it back on when it comes out', () => {
    const logs = new Tool({
      name: 'Logs',
      model: { build: () => new THREE.BoxGeometry(0.1, 0.1, 0.4), length: 0.4 },
      grip: { tip: [0, 0, -0.2] },
      stash: [{ at: [0, -0.5, 0.2] }],
      color: 0xffffff,
      charges: { pickup: 1, max: 10 },
      selectOnPickup: false,
      stows: true,
    });
    const inv = new Inventory(new Toolbox([logs]));
    inv.add(logs, 3);
    const { holsters, items } = setup(inv);
    expect(inv.inPack(logs)).toBe(true);
    expect(items(logs)).toHaveLength(0);

    inv.takeOut(logs);
    holsters.update(inv);
    expect(items(logs)).toHaveLength(1);
    expect(items(logs)[0].parent).toBe(holsters.torso.object);
  });

  it('holds a tool at its grip angle, and aims it the way it is drawn', () => {
    // a torch turned a quarter left in the hand and tipped up, stashed right where the hand will be
    const pitch = 0.3;
    const torch = new Tool({
      name: 'Torch',
      model: { build: () => new THREE.BoxGeometry(0.04, 0.04, 1), length: 0.3 },
      grip: { tip: [0, 0, -0.25], yaw: Math.PI / 2, pitch },
      stash: [{ at: [0.3, -0.33, -0.25] }],
      color: 0xffffff,
    });
    const inv = new Inventory(new Toolbox([torch]));
    inv.add(torch, 0);
    const { rig, holsters, right, reach, squeeze, items } = setup(inv);
    reach(right, [0.3, -0.5, -0.2]);
    squeeze(right, 1);
    expect(holsters.held(right)).toBe(torch);

    const tip: Vec3 = { x: 0, y: 0, z: 0 };
    const aim: Vec3 = { x: 0, y: 0, z: 0 };
    rig.handPose(right, holsters.tip(right), tip, aim, holsters.forward(right));
    // three.js (x, y, z) is the game's (x, z, y): to the left of the hand and up
    const hand = right.object.position;
    expect(aim.x).toBeCloseTo(-Math.cos(pitch), 6);
    expect(aim.y).toBeCloseTo(0, 6);
    expect(aim.z).toBeCloseTo(Math.sin(pitch), 6);
    expect(tip.x).toBeCloseTo(hand.x - 0.25 * Math.cos(pitch), 6);
    expect(tip.y).toBeCloseTo(hand.z + 0.05, 6);
    expect(tip.z).toBeCloseTo(hand.y - 0.03 + 0.25 * Math.sin(pitch), 6);

    const mesh = toolMesh(items(torch)[0]);
    mesh.updateWorldMatrix(true, false);
    const drawn = new THREE.Vector3(0, 0, -1).transformDirection(mesh.matrixWorld);
    expect(drawn.x).toBeCloseTo(aim.x, 6);
    expect(drawn.y).toBeCloseTo(aim.z, 6);
    expect(drawn.z).toBeCloseTo(aim.y, 6);
  });
});
