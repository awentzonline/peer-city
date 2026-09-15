import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { DesktopTool } from '../src/crossplay/desktopTool';
import { Holsters } from '../src/crossplay/holsters';
import { Inventory } from '../src/crossplay/inventory';
import { Rig } from '../src/crossplay/rig';
import { PISTOL, RIFLE, TOOLS } from '../src/fps/arsenal';

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
  it('desktop tool', () => {
    const rig = new Rig(new THREE.Scene(), 1);
    const before = contents(rig);
    const held = new DesktopTool(rig);
    held.setTool(PISTOL);
    expect(contents(rig).length).toBeGreaterThan(before.length);
    held.dispose();
    expect(contents(rig)).toEqual(before);
  });

  it('holsters, with a gun in hand', () => {
    const rig = new Rig(new THREE.Scene(), 1);
    rig.setMode('sim'); // both controllers connected
    const before = contents(rig);
    const holsters = new Holsters(rig);
    const inv = new Inventory(TOOLS);
    inv.add(RIFLE, 30);
    holsters.update(inv);
    rig.right.object.position.copy(rig.headLocal).add(new THREE.Vector3(0.22, -0.68, -0.05)); // right hip
    rig.right.squeeze = 1;
    holsters.update(inv);
    expect(holsters.held(rig.right)).toBe(PISTOL);

    holsters.dispose();
    expect(contents(rig)).toEqual(before);
  });
});
