import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Inventory, Weapon } from '../src/fps/arsenal';
import { Holsters } from '../src/fps/holsters';
import { Rig, type XRHand } from '../src/fps/rig';

// Stand-in gun models (1m-long boxes), so no GLB loading is needed.
vi.mock('../src/fps/assets', async () => {
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

interface GunView {
  weapon: Weapon;
  group: THREE.Group;
}

function setup() {
  const rig = new Rig(new THREE.Scene(), 1);
  rig.setMode('sim'); // both controllers connected
  rig.headLocal.set(0, 1.65, 0);
  const holsters = new Holsters(rig);
  const inv = new Inventory();
  inv.add(Weapon.Rifle, 30);
  holsters.update(inv);
  /** Put a hand somewhere relative to the head. */
  const reach = (hand: XRHand, [x, y, z]: Spot) => hand.object.position.copy(rig.headLocal).add(new THREE.Vector3(x, y, z));
  const squeeze = (hand: XRHand, v: number) => {
    hand.squeeze = v;
    holsters.update(inv);
  };
  const guns = (w: Weapon) => (holsters as unknown as { guns: GunView[] }).guns.filter((g) => g.weapon === w).map((g) => g.group);
  return { rig, holsters, inv, right: rig.right, left: rig.left, reach, squeeze, guns };
}

describe('Holsters (VR)', () => {
  it('keeps everything carried on the body and starts with empty hands', () => {
    const { holsters, right, left, guns } = setup();
    expect(holsters.held(right)).toBeNull();
    expect(holsters.held(left)).toBeNull();
    expect(guns(Weapon.Pistol)).toHaveLength(2);
    expect(guns(Weapon.Rifle)).toHaveLength(1);
    for (const g of [...guns(Weapon.Pistol), ...guns(Weapon.Rifle)]) expect(g.parent).toBe(holsters.torso.object);
  });

  it('grabs a pistol from the hip and the rifle from over the shoulder, and nothing out in front', () => {
    const { holsters, right, reach, squeeze } = setup();
    reach(right, OUT_FRONT);
    squeeze(right, 1);
    expect(holsters.held(right)).toBeNull();
    squeeze(right, 0);

    reach(right, RIGHT_HIP);
    squeeze(right, 1);
    expect(holsters.held(right)).toBe(Weapon.Pistol);
    reach(right, OUT_FRONT);
    squeeze(right, 0);

    reach(right, RIGHT_SHOULDER);
    squeeze(right, 1);
    expect(holsters.held(right)).toBe(Weapon.Rifle);
  });

  it('draws a pistol in each hand', () => {
    const { holsters, right, left, reach, squeeze } = setup();
    reach(right, RIGHT_HIP);
    reach(left, LEFT_HIP);
    squeeze(right, 1);
    squeeze(left, 1);
    expect(holsters.held(right)).toBe(Weapon.Pistol);
    expect(holsters.held(left)).toBe(Weapon.Pistol);
  });

  it('stashes a second gun of a kind when you pick one up', () => {
    const { holsters, inv, right, reach, squeeze, guns } = setup();
    reach(right, RIGHT_SHOULDER);
    squeeze(right, 1);
    inv.add(Weapon.Rifle, 30);
    holsters.update(inv);
    const rifles = guns(Weapon.Rifle);
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
    expect(holsters.held(right)).toBe(Weapon.Pistol);
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
    expect(holsters.held(right)).toBe(Weapon.Pistol);
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
    expect(holsters.held(right)).toBe(Weapon.Pistol);
  });

  it('empties the hand when the gun in it runs dry', () => {
    const { holsters, inv, right, reach, squeeze } = setup();
    reach(right, RIGHT_SHOULDER);
    squeeze(right, 1);
    expect(holsters.held(right)).toBe(Weapon.Rifle);
    for (let i = 0; i < 30; i++) inv.consume(Weapon.Rifle);
    holsters.update(inv);
    expect(holsters.held(right)).toBeNull();
  });
});
