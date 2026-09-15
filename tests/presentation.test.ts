import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Inventory, Weapon } from '../src/fps/arsenal';
import { DesktopGun } from '../src/fps/desktopGun';
import { Holsters } from '../src/fps/holsters';
import { Rig } from '../src/fps/rig';

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

/** Everything hanging off the rig: camera, controllers and whatever frontends added. */
function contents(rig: Rig): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  rig.root.traverse((o) => out.push(o));
  return out;
}

/**
 * Frontends only exist while their platform is playing, so the models they put on the rig must all come
 * back off when they're disposed, or they'd float around in the next platform's view.
 */
describe('first-person models leave the rig as they found it', () => {
  it('desktop gun', () => {
    const rig = new Rig(new THREE.Scene(), 1);
    const before = contents(rig);
    const gun = new DesktopGun(rig);
    expect(contents(rig).length).toBeGreaterThan(before.length);
    gun.dispose();
    expect(contents(rig)).toEqual(before);
  });

  it('holsters, with a gun in hand', () => {
    const rig = new Rig(new THREE.Scene(), 1);
    rig.setMode('sim'); // both controllers connected
    const before = contents(rig);
    const holsters = new Holsters(rig);
    const inv = new Inventory();
    inv.add(Weapon.Rifle, 30);
    holsters.update(inv);
    rig.right.object.position.copy(rig.headLocal).add(new THREE.Vector3(0.22, -0.68, -0.05)); // right hip
    rig.right.squeeze = 1;
    holsters.update(inv);
    expect(holsters.held(rig.right)).toBe(Weapon.Pistol);

    holsters.dispose();
    expect(contents(rig)).toEqual(before);
  });
});
