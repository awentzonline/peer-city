import * as THREE from 'three';
import { SOLID, blobShadow, box, cached, merge, paint, toolMesh } from '../crossplay/models';
import { AnimalKind } from './defs';
import { ARROW_LENGTH, BOW_LIMBS } from './kit';
import { ObstacleKind } from './land';

/** Peer Wilds' procedural models. Like Peer City's they face +X with +Z on their right, and share one material. */

export interface AnimalRig {
  root: THREE.Group;
  /** Yaw and lying down happen here. */
  body: THREE.Group;
  /** Legs, front then back, left then right, pivoting at the hip. */
  legs: THREE.Group[];
  head: THREE.Group;
  shadow: THREE.Mesh;
}

interface Shape {
  length: number;
  height: number;
  width: number;
  leg: number;
  neck: number;
  color: number;
  belly: number;
}

const SHAPES: Record<AnimalKind, Shape> = {
  [AnimalKind.Deer]: { length: 1.2, height: 0.5, width: 0.36, leg: 0.8, neck: 0.5, color: 0x9a6a3e, belly: 0xd8c3a0 },
  [AnimalKind.Rabbit]: { length: 0.32, height: 0.2, width: 0.2, leg: 0.1, neck: 0.08, color: 0x9c8c78, belly: 0xe8e0d4 },
  [AnimalKind.Wolf]: { length: 1.05, height: 0.38, width: 0.3, leg: 0.52, neck: 0.25, color: 0x5d5d62, belly: 0x9a9aa0 },
};

export function buildAnimal(kind: number): AnimalRig {
  const k = (SHAPES[kind as AnimalKind] ? kind : AnimalKind.Deer) as AnimalKind;
  const sh = SHAPES[k];
  const top = sh.leg + sh.height;
  const torso = cached(`animal:${k}`, () =>
    merge([
      box(sh.length, sh.height, sh.width, 0, sh.leg + sh.height / 2, 0, sh.color),
      box(sh.length * 0.8, sh.height * 0.3, sh.width * 0.9, 0, sh.leg + sh.height * 0.15, 0, sh.belly),
      box(0.12, 0.1, 0.1, -sh.length / 2 - 0.03, top - 0.05, 0, k === AnimalKind.Wolf ? sh.color : sh.belly), // tail
    ]),
  );
  const headGeo = cached(`animal-head:${k}`, () => {
    const s = sh.width;
    const parts = [box(s * 1.1, s * 0.9, s * 0.8, s * 0.35, 0, 0, sh.color), box(s * 0.6, s * 0.45, s * 0.5, s * 1.1, -s * 0.15, 0, sh.belly)];
    if (k === AnimalKind.Rabbit) parts.push(box(0.04, 0.16, 0.035, 0, 0.14, 0.04, sh.color), box(0.04, 0.16, 0.035, 0, 0.14, -0.04, sh.color));
    else if (k === AnimalKind.Wolf) parts.push(box(0.06, 0.1, 0.06, 0.05, s * 0.5, 0.08, sh.color), box(0.06, 0.1, 0.06, 0.05, s * 0.5, -0.08, sh.color));
    else parts.push(box(0.03, 0.34, 0.03, 0.05, 0.28, 0.1, 0x6b4c2e), box(0.03, 0.34, 0.03, 0.05, 0.28, -0.1, 0x6b4c2e), box(0.12, 0.03, 0.03, 0.1, 0.4, 0.1, 0x6b4c2e), box(0.12, 0.03, 0.03, 0.1, 0.4, -0.1, 0x6b4c2e));
    return merge(parts);
  });
  const legGeo = cached(`animal-leg:${k}`, () => merge([box(sh.width * 0.25, sh.leg, sh.width * 0.25, 0, -sh.leg / 2, 0, sh.color), box(sh.width * 0.28, 0.05, sh.width * 0.28, 0, -sh.leg + 0.025, 0, 0x2a2420)]));

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  body.add(new THREE.Mesh(torso, SOLID));
  const head = new THREE.Group();
  head.position.set(sh.length / 2, top + sh.neck * 0.6, 0);
  head.add(new THREE.Mesh(headGeo, SOLID));
  if (sh.neck > 0.1) head.add(new THREE.Mesh(cached(`animal-neck:${k}`, () => box(sh.width * 0.5, sh.neck, sh.width * 0.5, -0.05, -sh.neck / 2, 0, sh.color)), SOLID));
  body.add(head);
  const legs: THREE.Group[] = [];
  for (const fx of [1, -1]) {
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(fx * (sh.length / 2 - sh.width * 0.25), sh.leg, side * (sh.width / 2 - sh.width * 0.15));
      leg.add(new THREE.Mesh(legGeo, SOLID));
      body.add(leg);
      legs.push(leg);
    }
  }
  const shadow = blobShadow(sh.length * 1.2, sh.width * 2.2);
  root.add(shadow);
  return { root, body, legs, head, shadow };
}

// ---------------------------------------------------------------------------
// Farming, fires and stumps
// ---------------------------------------------------------------------------

export const SOIL = cached('soil', () => merge([box(1.25, 0.12, 1.25, 0, 0.02, 0, 0x4a3322), box(1.1, 0.02, 0.12, 0, 0.09, -0.3, 0x3a2718), box(1.1, 0.02, 0.12, 0, 0.09, 0.3, 0x3a2718)]));

/** A carrot plant at a stage of growth: 0 sprout, 1 leafy, 2 ripe (orange shoulders showing). */
export function cropGeometry(stage: number): THREE.BufferGeometry {
  return cached(`carrot:${stage}`, () => {
    const parts: THREE.BufferGeometry[] = [];
    const size = [0.35, 0.7, 1][stage];
    for (const [x, z] of [
      [-0.3, -0.3],
      [0.3, -0.3],
      [-0.3, 0.3],
      [0.3, 0.3],
    ]) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        parts.push(box(0.03, 0.28 * size, 0.08 * size, x + Math.cos(a) * 0.04, 0.1 + 0.14 * size, z + Math.sin(a) * 0.04, stage === 2 ? 0x4f9a3a : 0x6cb84e));
      }
      if (stage === 2) parts.push(paint(new THREE.CylinderGeometry(0.05, 0.04, 0.06, 6).translate(x, 0.11, z), 0xf08a24));
    }
    return merge(parts);
  });
}

export interface FireRig {
  root: THREE.Group;
  logs: THREE.Mesh;
}

export function buildCampfire(): FireRig {
  const stones = cached('fire-stones', () => {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      parts.push(paint(new THREE.DodecahedronGeometry(0.13, 0).translate(Math.cos(a) * 0.55, 0.08, Math.sin(a) * 0.55), 0x77736b));
    }
    return merge(parts);
  });
  const logs = cached('fire-logs', () => {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.3;
      parts.push(paint(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 6).rotateZ(1.1).rotateY(a).translate(Math.cos(a) * 0.12, 0.2, Math.sin(a) * 0.12), 0x5a3a22));
    }
    return merge(parts);
  });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(stones, SOLID));
  const logMesh = new THREE.Mesh(logs, SOLID);
  root.add(logMesh);
  return { root, logs: logMesh };
}

/** A felled tree's stump, and the trunk lying beside it (the model the land's trees use, turned on its side). */
export function buildStump(kind: ObstacleKind, radius: number): THREE.Group {
  const root = new THREE.Group();
  const stump = new THREE.Mesh(
    cached('stump', () => merge([paint(new THREE.CylinderGeometry(1, 1.15, 0.5, 8).translate(0, 0.25, 0), 0x5b3d24), paint(new THREE.CylinderGeometry(0.9, 0.9, 0.02, 8).translate(0, 0.5, 0), 0xc9a26b)])),
    SOLID,
  );
  stump.scale.set(radius, 1, radius);
  root.add(stump);
  const trunk = new THREE.Mesh(
    cached(`log:${kind}`, () => paint(new THREE.CylinderGeometry(0.8, 1, 1, 8).translate(0, 0.5, 0), kind === ObstacleKind.Pine ? 0x5b3d24 : 0x6b4a2b)),
    SOLID,
  );
  trunk.name = 'trunk';
  root.add(trunk);
  return root;
}

// ---------------------------------------------------------------------------
// Bow strings and arrows
// ---------------------------------------------------------------------------

const stringMat = new THREE.LineBasicMaterial({ color: 0xeeeeee });
const ARROW_GEO = cached('flight', () =>
  merge([box(0.012, 0.012, ARROW_LENGTH, 0, 0, -ARROW_LENGTH / 2 + 0.03, 0xc8a878), box(0.02, 0.03, 0.06, 0, 0, -ARROW_LENGTH + 0.03, 0x4a4f55), box(0.004, 0.05, 0.1, 0, 0.02, -0.02, 0xe8e2d0)]),
);

/** An arrow pointing down -Z from its nock, for flights, nocked arrows and arrows stuck in things. */
export function arrowMesh(): THREE.Mesh {
  return new THREE.Mesh(ARROW_GEO, SOLID);
}

const top = new THREE.Vector3();
const bottom = new THREE.Vector3();
const nock = new THREE.Vector3();
const toward = new THREE.Vector3();

/**
 * A bow's string, drawn between its limb tips and wherever it's pulled to, with a nocked arrow. Lives in the
 * scene in world space; call `update` after the bow's model has been placed each frame.
 */
export class BowString {
  readonly line: THREE.Line;
  readonly arrow = arrowMesh();
  private readonly positions: THREE.BufferAttribute;

  constructor(private readonly scene: THREE.Scene) {
    const g = new THREE.BufferGeometry();
    this.positions = new THREE.BufferAttribute(new Float32Array(9), 3);
    g.setAttribute('position', this.positions);
    this.line = new THREE.Line(g, stringMat);
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.arrow.visible = false;
    scene.add(this.line, this.arrow);
  }

  /**
   * Draw the string of the bow in `bow` (a group made by buildTool), pulled back to `pull` (world space,
   * three.js axes) or resting if null. `arrow` shows a nocked arrow on the string.
   */
  update(bow: THREE.Group | null, pull: THREE.Vector3 | null, arrow: boolean): void {
    const visible = !!bow && bow.visible && (!bow.parent || isShown(bow));
    this.line.visible = visible;
    this.arrow.visible = visible && arrow && !!pull;
    if (!visible) return;
    const mesh = toolMesh(bow!);
    mesh.updateWorldMatrix(true, false);
    top.copy(BOW_LIMBS.top).applyMatrix4(mesh.matrixWorld);
    bottom.copy(BOW_LIMBS.bottom).applyMatrix4(mesh.matrixWorld);
    if (pull) nock.copy(pull);
    else nock.copy(top).add(bottom).multiplyScalar(0.5);
    const p = this.positions.array as Float32Array;
    top.toArray(p, 0);
    nock.toArray(p, 3);
    bottom.toArray(p, 6);
    this.positions.needsUpdate = true;
    this.line.geometry.computeBoundingSphere();
    if (this.arrow.visible) {
      // from the nock through the bow's rest
      toward.set(0, 0, 0).applyMatrix4(mesh.matrixWorld);
      this.arrow.position.copy(nock);
      this.arrow.lookAt(toward);
      this.arrow.rotateY(Math.PI);
    }
  }

  dispose(): void {
    this.scene.remove(this.line, this.arrow);
    this.line.geometry.dispose();
  }
}

function isShown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
