import * as THREE from 'three';
import { angleDiff } from './context';
import type { Rig } from './rig';

const UP = new THREE.Vector3(0, 1, 0);
/** How far the head can turn (radians) before the body turns with it. */
const TWIST = 0.6;
/** The torso's origin is the base of the neck, this far below and behind the eyes. */
const NECK_DROP = 0.2;
const NECK_BACK = 0.1;
/** Where tools can be stashed, in torso space (+X right, -Z forward): thighs to just above the shoulders, chest to back. */
const ZONE = new THREE.Box3(new THREE.Vector3(-0.32, -0.8, -0.3), new THREE.Vector3(0.32, 0.15, 0.32));
const v = new THREE.Vector3();

/**
 * Where a headset player's body probably is. There's no body tracking, so it
 * hangs below the head and only turns once you look well to one side, so
 * glancing down at your hip doesn't swing your holsters around.
 */
export class Torso {
  /** Things parented here move with the body. Lives in play space. */
  readonly object = new THREE.Group();
  private yaw: number | null = null;

  constructor(private readonly rig: Rig) {
    rig.root.add(this.object);
  }

  update(): void {
    const { rig } = this;
    const head = rig.headLocalYaw();
    this.yaw ??= head;
    const d = angleDiff(this.yaw, head);
    if (Math.abs(d) > TWIST) this.yaw += d - Math.sign(d) * TWIST;
    this.object.rotation.set(0, this.yaw, 0);
    this.object.position.copy(rig.headLocal).add(v.set(0, -NECK_DROP, NECK_BACK).applyAxisAngle(UP, this.yaw));
    rig.root.updateMatrixWorld();
  }

  dispose(): void {
    this.object.removeFromParent();
  }

  /** Whether a point in three.js world space is on the body. */
  contains(point: THREE.Vector3): boolean {
    return ZONE.containsPoint(this.object.worldToLocal(v.copy(point)));
  }
}
