import * as THREE from 'three';
import { SOLID, box, buildHuman, cached, merge, nameTag, paint, type HumanRig } from '../crossplay/models';
import { CELL, DIRS, Dir, PARTS, PartKind, WHEEL_DROP, type Design } from './parts';

/**
 * Peer Derby's models. Racers are built from their designs: every part but the wheels merged into one mesh,
 * and each wheel in its own pivot so it can steer and spin.
 *
 * World and racer axes put z up, and three.js puts y up, so a point (x, y, z) is drawn at (x, z, y). That's a
 * mirror, not a rotation, so a racer's quaternion becomes (-x, -z, -y, w) in the scene (see `sceneQuat`).
 */

export const SHIRTS = [0xc0392b, 0x2980b9, 0x27ae60, 0x8e44ad, 0xf39c12, 0x16a085, 0xd35400, 0x2c3e50, 0xe84393, 0x6c5ce7];
const PANTS = [0x34495e, 0x2d3436, 0x4a4238, 0x55503f];
const SKINS = [0xf5d0a9, 0xe0ac69, 0xc68642, 0x8d5524, 0x5c3a1e];
const HAIR = [0x2c1b0e, 0x6b4423, 0xd4a017, 0x1a1a1a, 0xa52a2a, 0xbbbbbb];

export function humanFor(skin: number): HumanRig {
  return buildHuman({
    shirt: SHIRTS[skin % SHIRTS.length],
    pants: PANTS[(skin * 5) % PANTS.length],
    skin: SKINS[(skin * 7) % SKINS.length],
    hair: HAIR[(skin * 3) % HAIR.length],
    hat: skin % 4 === 0 ? SHIRTS[(skin + 3) % SHIRTS.length] : undefined,
  });
}

export { sceneQuat } from '../crossplay/rigid';

/** A direction in racer space, as a scene vector. */
function sceneDir(d: Dir): THREE.Vector3 {
  const [x, y, z] = DIRS[d];
  return new THREE.Vector3(x, z, y);
}

const UP = new THREE.Vector3(0, 1, 0);

/** Turn a geometry built pointing up (+Y, scene) to point along a racer-space direction. */
function pointAlong(g: THREE.BufferGeometry, d: Dir): THREE.BufferGeometry {
  const q = new THREE.Quaternion().setFromUnitVectors(UP, sceneDir(d));
  return g.applyQuaternion(q);
}

/** A part's geometry, around the middle of its cell, in scene axes. Wheels come from `wheelGeometry`. */
export function partGeometry(kind: PartKind, dir: Dir, seatColor = PARTS[PartKind.Seat].color): THREE.BufferGeometry {
  return cached(`part:${kind}:${dir}:${kind === PartKind.Seat ? seatColor : 0}`, () => {
    const h = CELL / 2;
    const spec = PARTS[kind];
    switch (kind) {
      case PartKind.Seat:
        return merge([
          box(0.5, 0.3, 0.5, 0, -0.1, 0, 0x6d4c2f),
          box(0.44, 0.1, 0.44, 0.02, 0.1, 0, seatColor),
          box(0.1, 0.5, 0.44, -0.2, 0.38, 0, seatColor),
          box(0.05, 0.22, 0.05, 0.05, 0.25, 0.22, 0x2d3436),
          box(0.05, 0.22, 0.05, 0.05, 0.25, -0.22, 0x2d3436),
        ]);
      case PartKind.Block:
        return merge([
          box(0.48, 0.48, 0.48, 0, 0, 0, spec.color),
          box(0.5, 0.07, 0.5, 0, h - 0.06, 0, 0x8a6a3f),
          box(0.5, 0.07, 0.5, 0, -h + 0.06, 0, 0x8a6a3f),
          box(0.07, 0.5, 0.07, h - 0.04, 0, h - 0.04, 0x8a6a3f),
          box(0.07, 0.5, 0.07, -h + 0.04, 0, h - 0.04, 0x8a6a3f),
          box(0.07, 0.5, 0.07, h - 0.04, 0, -h + 0.04, 0x8a6a3f),
          box(0.07, 0.5, 0.07, -h + 0.04, 0, -h + 0.04, 0x8a6a3f),
        ]);
      case PartKind.Ballast:
        return merge([
          box(0.46, 0.2, 0.36, 0, -0.15, 0, 0x3d4148),
          box(0.2, 0.18, 0.2, 0, 0.02, 0, 0x4a4f57),
          box(0.5, 0.14, 0.3, 0.02, 0.17, 0, spec.color),
          paint(new THREE.ConeGeometry(0.07, 0.22, 6).rotateZ(-Math.PI / 2).translate(0.35, 0.17, 0), 0x4a4f57),
        ]);
      case PartKind.Rocket:
        return pointAlong(
          merge([
            paint(new THREE.CylinderGeometry(0.16, 0.16, 0.36, 10).translate(0, -0.06, 0), spec.color),
            paint(new THREE.CylinderGeometry(0.1, 0.17, 0.14, 10).translate(0, 0.19, 0), 0x2d3436),
            paint(new THREE.CylinderGeometry(0.17, 0.17, 0.04, 10).translate(0, -0.08, 0), 0xf1c40f),
            box(0.02, 0.2, 0.18, 0, -0.14, 0.18, 0xecf0f1),
            box(0.02, 0.2, 0.18, 0, -0.14, -0.18, 0xecf0f1),
          ]),
          dir,
        );
      case PartKind.Wing:
        return merge([
          box(0.62, 0.05, 0.56, -0.02, 0, 0, spec.color),
          box(0.16, 0.052, 0.56, 0.2, 0.002, 0, 0xc0392b),
          box(0.06, 0.2, 0.06, -0.1, -0.12, 0, 0x7f8c8d),
        ]);
      case PartKind.Balloon:
        return merge([
          box(0.12, 0.08, 0.12, 0, -0.2, 0, 0x7f8c8d),
          box(0.012, 0.6, 0.012, 0, 0.12, 0, 0xecf0f1),
          paint(new THREE.SphereGeometry(0.38, 12, 10).scale(1, 1.15, 1).translate(0, 0.9, 0), spec.color),
          paint(new THREE.ConeGeometry(0.05, 0.08, 6).rotateX(Math.PI).translate(0, 0.46, 0), spec.color),
        ]);
      case PartKind.Bumper:
        return merge([
          box(0.44, 0.44, 0.44, 0, 0, 0, spec.color),
          box(0.5, 0.1, 0.5, 0, 0.12, 0, 0x2d3436),
          box(0.5, 0.1, 0.5, 0, -0.12, 0, 0x2d3436),
        ]);
      case PartKind.Runner:
        return merge([
          box(0.5, 0.1, 0.36, 0, -0.2, 0, spec.color),
          box(0.12, 0.12, 0.36, 0.25, -0.1, 0, spec.color),
          box(0.08, 0.3, 0.08, -0.1, 0, 0.1, 0x95a5a6),
          box(0.08, 0.3, 0.08, -0.1, 0, -0.1, 0x95a5a6),
          box(0.4, 0.06, 0.4, 0, 0.18, 0, 0xb2bec3),
        ]);
      default:
        return box(0.5, 0.5, 0.5, 0, 0, 0, spec.color);
    }
  });
}

/** A wheel spinning about scene +Z (racer-space +Y), before it's turned onto its axle. */
function wheelGeometry(kind: PartKind): THREE.BufferGeometry {
  return cached(`wheel:${kind}`, () => {
    const { radius: r, width: w } = PARTS[kind].wheel!;
    const parts = [
      paint(new THREE.CylinderGeometry(r, r, w, 16).rotateX(Math.PI / 2), PARTS[kind].color),
      paint(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 10).rotateX(Math.PI / 2), 0xbdc3c7),
      paint(new THREE.CylinderGeometry(r * 0.15, r * 0.15, w + 0.06, 8).rotateX(Math.PI / 2), 0xe74c3c),
    ];
    // a spoke, so you can see it roll
    parts.push(box(r * 1.1, r * 0.12, w + 0.03, 0, 0, 0, 0x7f8c8d));
    if (kind === PartKind.BigWheel) for (let i = 0; i < 10; i++) parts.push(box(0.1, 0.06, w + 0.02, 0, r, 0, 0x2b2b2b).rotateZ((i / 10) * Math.PI * 2));
    return merge(parts);
  });
}

export interface WheelRig {
  part: number;
  radius: number;
  /** Turns about the scene's up axis to steer. */
  steer: THREE.Group;
  /** Rolls about the axle. */
  spin: THREE.Group;
  /** In front of the middle: it steers. */
  steers: boolean;
  /** Its axle is along racer-space X: it rolls sideways, and steering doesn't turn it. */
  sideways: boolean;
}

export interface RocketRig {
  part: number;
  /** Nozzle, racer space. */
  at: { x: number; y: number; z: number };
  dir: Dir;
}

export interface RacerModel {
  root: THREE.Group;
  body: THREE.Mesh;
  wheels: WheelRig[];
  rockets: RocketRig[];
  /** Where the driver sits: a human, placed in the seat. */
  driver: HumanRig | null;
  label: THREE.Sprite;
  ready: THREE.Sprite;
}

/** Build a racer's model from its design, leaving out parts not kept. Its root is in racer space (mirrored to the scene). */
export function buildRacer(design: Design, keep: readonly boolean[], color: number): RacerModel {
  const root = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const wheels: WheelRig[] = [];
  const rockets: RocketRig[] = [];
  const seat = SHIRTS[color % SHIRTS.length];
  // the middle along the racer, weighing each part (and the driver), as the physics finds which wheels steer
  let mass = 0;
  let moment = 0;
  design.forEach((p, i) => {
    if (!keep[i]) return;
    const m = PARTS[p.kind].mass + (p.kind === PartKind.Seat ? 70 : 0);
    mass += m;
    moment += p.x * CELL * m;
  });
  const comX = moment / Math.max(1, mass);

  design.forEach((p, i) => {
    if (!keep[i]) return;
    const spec = PARTS[p.kind];
    const x = p.x * CELL;
    const y = p.z * CELL;
    const z = p.y * CELL;
    if (spec.wheel) {
      const steer = new THREE.Group();
      steer.position.set(x, y - WHEEL_DROP, z);
      const sideways = p.dir === Dir.PX || p.dir === Dir.NX;
      const axle = new THREE.Group();
      if (sideways) axle.rotation.y = Math.PI / 2;
      const spin = new THREE.Group();
      spin.add(new THREE.Mesh(wheelGeometry(p.kind), SOLID));
      axle.add(spin);
      steer.add(axle);
      root.add(steer);
      wheels.push({ part: i, radius: spec.wheel.radius, steer, spin, steers: !sideways && x > comX + 0.1, sideways });
      return;
    }
    geos.push(partGeometry(p.kind, p.dir, seat).clone().translate(x, y, z));
    if (spec.thrust) {
      const [dx, dy, dz] = DIRS[p.dir];
      rockets.push({ part: i, at: { x: p.x * CELL + dx * 0.3, y: p.y * CELL + dy * 0.3, z: p.z * CELL + dz * 0.3 }, dir: p.dir });
    }
  });
  const body = new THREE.Mesh(geos.length ? merge(geos) : new THREE.BufferGeometry(), SOLID);
  root.add(body);

  const label = nameTag(1.9);
  root.add(label);
  const ready = nameTag(2.4);
  ready.scale.set(1.2, 0.3, 1);
  root.add(ready);
  return { root, body, wheels, rockets, driver: null, label, ready };
}

export function disposeRacer(m: RacerModel): void {
  m.root.removeFromParent();
  m.body.geometry.dispose();
  m.label.material.map?.dispose();
  m.label.material.dispose();
  m.ready.material.map?.dispose();
  m.ready.material.dispose();
}

/** Sit a human in a racer's seat: hips on the seat, legs out in front, hands forward. */
export function seatHuman(rig: HumanRig): void {
  rig.root.position.set(0, CELL / 2 - 0.9 + 0.02, 0);
  rig.body.rotation.set(0, 0, 0);
  rig.legL.rotation.set(0, 0, Math.PI / 2 - 0.1);
  rig.legR.rotation.set(0, 0, Math.PI / 2 - 0.1);
  rig.armL.rotation.set(0.15, 0, 1.1);
  rig.armR.rotation.set(-0.15, 0, 1.1);
  rig.shadow.visible = false;
  rig.label.visible = false;
}

/** A see-through cube for previewing a part, or marking one to take off. */
export function ghostCube(): THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial> {
  const m = new THREE.Mesh(new THREE.BoxGeometry(CELL + 0.04, CELL + 0.04, CELL + 0.04), new THREE.MeshBasicMaterial({ color: 0x55efc4, transparent: true, opacity: 0.4, depthWrite: false }));
  m.renderOrder = 3;
  m.visible = false;
  return m;
}

/** A loose part, for debris. */
export function debrisGeometry(kind: PartKind, dir: Dir): THREE.BufferGeometry {
  return PARTS[kind].wheel ? wheelGeometry(kind) : partGeometry(kind, dir);
}
