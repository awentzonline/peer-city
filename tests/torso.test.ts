import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Rig } from '../src/crossplay/rig';
import { Torso } from '../src/crossplay/torso';

const UP = new THREE.Vector3(0, 1, 0);

describe('Torso (VR holster zone)', () => {
  const setup = () => {
    const rig = new Rig(new THREE.Scene(), 1);
    rig.setMode('vr');
    rig.headLocal.set(0, 1.6, 0);
    const torso = new Torso(rig);
    torso.update();
    return { rig, torso };
  };

  it('covers the hips and back but not a hand held out in front', () => {
    const { torso } = setup();
    expect(torso.contains(new THREE.Vector3(0.22, 0.95, 0))).toBe(true); // right hip
    expect(torso.contains(new THREE.Vector3(-0.1, 1.3, 0.3))).toBe(true); // between the shoulder blades
    expect(torso.contains(new THREE.Vector3(0.2, 1.3, -0.55))).toBe(false); // aiming
    expect(torso.contains(new THREE.Vector3(0.7, 1.1, 0))).toBe(false); // arm out to the side
  });

  it('lets the head glance around before the body turns', () => {
    const { rig, torso } = setup();
    rig.headQuat.setFromAxisAngle(UP, 0.4);
    torso.update();
    expect(torso.object.rotation.y).toBeCloseTo(0, 5);
    rig.headQuat.setFromAxisAngle(UP, Math.PI / 2);
    torso.update();
    expect(torso.object.rotation.y).toBeCloseTo(Math.PI / 2 - 0.6, 5);
    // turning back a little leaves the body where it is
    rig.headQuat.setFromAxisAngle(UP, Math.PI / 2 - 0.5);
    torso.update();
    expect(torso.object.rotation.y).toBeCloseTo(Math.PI / 2 - 0.6, 5);
  });

  it('crouches with you and moves with the play space', () => {
    const { rig, torso } = setup();
    rig.headLocal.y = 1.0;
    rig.root.position.set(20, 0, -5);
    torso.update();
    expect(torso.contains(new THREE.Vector3(20.22, 0.35, -5))).toBe(true);
    expect(torso.contains(new THREE.Vector3(0.22, 0.35, 0))).toBe(false);
  });
});
