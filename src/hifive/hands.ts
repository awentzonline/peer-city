import * as THREE from 'three';
import { SOLID } from '../crossplay/models';
import type { Rig } from '../crossplay/rig';
import { fistGeometry, palmGeometry } from './models';
import { Move } from './moves';
import { SLAP_MS, SWING_MS, type PalRole } from './pal';

/** Where a hand's held for each move, in camera space (right hand; the left mirrors it). */
const HELD: Partial<Record<Move, THREE.Vector3>> = {
  [Move.High]: new THREE.Vector3(0.2, 0.19, -0.5),
  [Move.Low]: new THREE.Vector3(0.19, -0.26, -0.5),
  [Move.Fist]: new THREE.Vector3(0.15, -0.13, -0.45),
  [Move.Double]: new THREE.Vector3(0.21, 0.19, -0.5),
};
/** Out of sight below the view. */
const DOWN = new THREE.Vector3(0.22, -0.6, -0.4);
const WIND = new THREE.Vector3(0.3, 0.06, -0.26);
const SLAP_WIND = new THREE.Vector3(0.36, -0.02, -0.18);

const target = new THREE.Vector3();
const world = new THREE.Vector3();

interface FpHand {
  palm: THREE.Mesh;
  fist: THREE.Mesh;
  at: THREE.Vector3;
}

/**
 * Your own hands on a flat screen, in front of the camera: held up while you're offering, winding back and slapping
 * into the other hand (drawn where it really is) as you swing, and out of sight otherwise.
 */
export class FirstPersonHands {
  private readonly hands: [FpHand, FpHand];

  constructor(
    private readonly rig: Rig,
    skin: number,
  ) {
    const make = (left: boolean): FpHand => {
      const palm = new THREE.Mesh(palmGeometry(skin), SOLID);
      const fist = new THREE.Mesh(fistGeometry(skin), SOLID);
      for (const m of [palm, fist]) {
        m.visible = false;
        if (left) m.scale.x = -1;
        rig.camera.add(m);
      }
      return { palm, fist, at: DOWN.clone() };
    };
    this.hands = [make(false), make(true)];
  }

  update(dt: number, role: PalRole, now: number): void {
    const s = role.me?.state;
    if (!s) return;
    const sw = role.swing;
    const sl = role.slap;
    for (const side of [0, 1] as const) {
      const h = this.hands[side];
      const mirror = side === 1 ? -1 : 1;
      let fist = false;
      let low = false;
      let exact = false;
      if (sw && (side === 0 || sw.move === Move.Double)) {
        const t = (now - sw.start) / SWING_MS;
        this.local(sw.points[side], target);
        target.z = Math.min(-0.3, Math.max(-0.95, target.z));
        const wind = WIND.clone().setX(WIND.x * mirror);
        if (t < 0.4) target.lerpVectors(h.at, wind, ease(t / 0.4));
        else target.lerpVectors(wind, target, ease(Math.min(1, (t - 0.4) / 0.6)));
        fist = sw.move === Move.Fist;
        low = sw.move === Move.Low;
        exact = true;
      } else if (sl && side === 0) {
        const t = (now - sl.start) / SLAP_MS;
        this.local(sl.point, target);
        target.z = Math.min(-0.3, Math.max(-0.95, target.z));
        if (t < 0.5) target.lerpVectors(h.at, SLAP_WIND, ease(t / 0.5));
        else target.lerpVectors(SLAP_WIND, target, ease(Math.min(1, (t - 0.5) / 0.5)));
        exact = true;
      } else if (s.offer !== Move.None && (side === 0 || s.offer === Move.Double)) {
        target.copy(HELD[s.offer]!).setX(HELD[s.offer]!.x * mirror);
        fist = s.offer === Move.Fist;
        low = s.offer === Move.Low;
      } else {
        target.copy(DOWN).setX(DOWN.x * mirror);
      }
      // keep a swing in sight even when the hand it's going for is below the view (down low, or a backside)
      if (exact) target.y = Math.max(target.y, target.z * 0.55);
      if (exact) h.at.copy(target);
      else h.at.lerp(target, Math.min(1, dt * 16));
      const shown = h.at.y > -0.45;
      h.palm.visible = shown && !fist;
      h.fist.visible = shown && fist;
      const m = fist ? h.fist : h.palm;
      m.position.copy(h.at);
      if (low && !fist) m.rotation.set(Math.PI / 2, Math.PI, 0);
      else m.rotation.set(0.15, 0, 0);
    }
  }

  dispose(): void {
    for (const h of this.hands) {
      h.palm.removeFromParent();
      h.fist.removeFromParent();
    }
  }

  /** A world point in the camera's space. */
  private local(p: { x: number; y: number; z: number }, out: THREE.Vector3): THREE.Vector3 {
    const cam = this.rig.camera;
    cam.updateWorldMatrix(true, false);
    return out.copy(cam.worldToLocal(world.set(p.x, p.z, p.y)));
  }
}

function ease(t: number): number {
  return t * t * (3 - 2 * t);
}
