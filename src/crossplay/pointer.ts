import * as THREE from 'three';
import type { Rig, XRHand } from './rig';

/**
 * A flat canvas face a hand can point at: a mesh whose own +z faces the viewer (a `panel()`), its size in metres, and
 * the logical pixels it's drawn in.
 */
export interface Surface {
  mesh: THREE.Object3D;
  width: number;
  height: number;
  px: number;
  py: number;
}

/** Where a hand's pointing on a surface: which one (by index), in its logical pixels, and how far off, m. */
export interface Point {
  surface: number;
  x: number;
  y: number;
  distance: number;
}

/** How far a hand can point at a face from, m: across a console from where you stand, not across the room. */
const REACH = 2.5;
/** The ray starts this far behind the controller, so a controller pushed right up to (or a little through) a face
 * still points at it — poking a key is pointing at it from very close. */
const BACK = 0.08;
const CURSOR = 0.012;

const origin = new THREE.Vector3();
const local = new THREE.Vector3();
const ahead = new THREE.Vector3();
const dir = new THREE.Vector3();
const FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * The one way a headset works a flat interface, whatever it's on (a console, the settings menu): point at it with a
 * controller and pull the trigger. A beam runs from the controller to a dot on whatever it's pointing at — so where
 * the press lands is always where you can see it will — and only shows while it's on something. Touching a face is
 * the same thing from close up. The game reads the points it returns and decides what a press means.
 */
export class HandPointer {
  private readonly beams: THREE.Line[] = [];
  private readonly cursors: THREE.Mesh[] = [];
  private readonly beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  private readonly beamMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, fog: false });
  private readonly cursorGeo = new THREE.RingGeometry(CURSOR * 0.45, CURSOR, 20);
  private readonly cursorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, fog: false });

  constructor(private readonly rig: Rig) {
    this.beamGeo.setAttribute('color', new THREE.Float32BufferAttribute([0.35, 0.6, 0.8, 0.9, 0.97, 1], 3));
    for (const hand of [rig.left, rig.right]) {
      const beam = new THREE.Line(this.beamGeo, this.beamMat);
      beam.visible = false;
      beam.renderOrder = 11;
      hand.object.add(beam);
      this.beams.push(beam);
      const cursor = new THREE.Mesh(this.cursorGeo, this.cursorMat);
      cursor.visible = false;
      cursor.renderOrder = 12;
      this.cursors.push(cursor);
    }
  }

  /**
   * Aim each of `hands` at `surfaces` and show where it's pointing; returns, for each of `hands`, the nearest face it
   * points at, or null. Hands not listed show nothing.
   */
  update(surfaces: readonly Surface[], hands: readonly XRHand[]): (Point | null)[] {
    this.rig.root.updateMatrixWorld();
    const out = hands.map((hand) => this.aim(hand, surfaces));
    [this.rig.left, this.rig.right].forEach((hand, i) => {
      const at = hands.indexOf(hand);
      const p = at >= 0 ? out[at] : null;
      const beam = this.beams[i];
      const cursor = this.cursors[i];
      beam.visible = cursor.visible = !!p;
      if (!p) return;
      const s = surfaces[p.surface];
      beam.scale.z = Math.max(0.001, p.distance - BACK);
      if (cursor.parent !== s.mesh) s.mesh.add(cursor);
      cursor.position.set((p.x / s.px - 0.5) * s.width, (0.5 - p.y / s.py) * s.height, 0.004);
      // a squeeze of the trigger shrinks the dot, like a button going down
      cursor.scale.setScalar(1 - Math.min(1, hand.trigger) * 0.35);
    });
    return out;
  }

  /** Show nothing, e.g. while something else has the hands. */
  hide(): void {
    for (const o of [...this.beams, ...this.cursors]) o.visible = false;
  }

  dispose(): void {
    for (const o of [...this.beams, ...this.cursors]) o.removeFromParent();
    this.beamGeo.dispose();
    this.beamMat.dispose();
    this.cursorGeo.dispose();
    this.cursorMat.dispose();
  }

  private aim(hand: XRHand, surfaces: readonly Surface[]): Point | null {
    if (!hand.connected) return null;
    hand.object.updateMatrixWorld();
    const m = hand.object.matrixWorld;
    dir.copy(FORWARD).transformDirection(m);
    const from = origin.setFromMatrixPosition(m).addScaledVector(dir, -BACK);
    let best: Point | null = null;
    for (let i = 0; i < surfaces.length; i++) {
      const s = surfaces[i];
      if (!s.mesh.visible) continue;
      s.mesh.updateMatrixWorld();
      const o = s.mesh.worldToLocal(local.copy(from));
      const d = s.mesh.worldToLocal(ahead.copy(from).add(dir)).sub(o);
      // from the front, towards the face
      if (o.z <= 0 || d.z >= -1e-4) continue;
      const t = -o.z / d.z;
      if (t > REACH + BACK || (best && t >= best.distance)) continue;
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      if (Math.abs(x) > s.width / 2 || Math.abs(y) > s.height / 2) continue;
      best = { surface: i, x: (0.5 + x / s.width) * s.px, y: (0.5 - y / s.height) * s.py, distance: t };
    }
    return best;
  }
}
