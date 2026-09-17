import * as THREE from 'three';
import { SOLID, box, buildHuman, merge, nameTag, paint, type HumanRig } from '../crossplay/models';
import { CART, DRIVER_SEAT } from './carts';

/**
 * Peer Golf's models: golfers in polo shirts, carts, balls and flags. World axes put z up and three.js puts y up,
 * so a point (x, y, z) is drawn at (x, z, y); that's a mirror, not a rotation (see `sceneQuat`). Models are built
 * straight in scene axes, facing +X.
 */

const SHIRTS = [0xe84393, 0x0984e3, 0x00b894, 0xfdcb6e, 0x6c5ce7, 0xe17055, 0x00cec9, 0xd63031, 0xa29bfe, 0xfab1a0, 0x55efc4, 0xffeaa7];
const PANTS = [0xf5f6fa, 0x2d3436, 0xb2bec3, 0xdfc8a0, 0x34495e];
const SKINS = [0xf5d0a9, 0xe0ac69, 0xc68642, 0x8d5524, 0x5c3a1e];
const HAIR = [0x2c1b0e, 0x6b4423, 0xd4a017, 0x1a1a1a, 0xa52a2a, 0xbbbbbb];
export const CART_COLORS = [0x2e86de, 0xee5253, 0x10ac84, 0xff9f43, 0x5f27cd, 0x222f3e];

/** A golfer's colour, for their shirt, their ball's stripe and their dot on the map. */
export function golferColor(skin: number): number {
  return SHIRTS[skin % SHIRTS.length];
}

export function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function humanFor(skin: number): HumanRig {
  return buildHuman({
    shirt: golferColor(skin),
    pants: PANTS[(skin * 5) % PANTS.length],
    skin: SKINS[(skin * 7) % SKINS.length],
    hair: HAIR[(skin * 3) % HAIR.length],
    // half of everyone wears a cap
    hat: skin % 2 === 0 ? [0xffffff, 0x2d3436, SHIRTS[(skin + 4) % SHIRTS.length]][skin % 3] : undefined,
  });
}

/** Knocked flat on your back, arms out. Put `rig.root` at the feet first; `heading` is where they faced. */
export function poseLying(rig: HumanRig, heading: number, t: number): void {
  rig.body.rotation.set(0, -heading, Math.PI / 2 - 0.05, 'YXZ');
  rig.body.position.y = 0.14;
  rig.legL.rotation.set(0.25, 0, 0);
  rig.legR.rotation.set(-0.25, 0, 0);
  // arms flung out, and a feeble wave now and then
  rig.armL.rotation.set(-1.3 + Math.sin(t * 3) * 0.1, 0, 0);
  rig.armR.rotation.set(1.3, 0, Math.sin(t * 2.3) * 0.15);
  rig.head.rotation.set(Math.sin(t * 4) * 0.3, 0, 0);
  rig.tool.visible = rig.toolL.visible = false;
}

/** Sit a human on a cart's bench: hips on the seat, legs forward, hands on the wheel. Inside the cart's model. */
export function poseSeated(rig: HumanRig, driver: boolean): void {
  rig.root.position.set(DRIVER_SEAT.x, DRIVER_SEAT.z + 0.14 - 0.9, driver ? DRIVER_SEAT.y : -DRIVER_SEAT.y);
  rig.body.rotation.set(0, 0, 0);
  rig.body.position.y = 0;
  rig.legL.rotation.set(0, 0, Math.PI / 2 - 0.15);
  rig.legR.rotation.set(0, 0, Math.PI / 2 - 0.15);
  rig.armL.rotation.set(0.1, 0, driver ? 1.0 : 0.3);
  rig.armR.rotation.set(-0.1, 0, driver ? 1.0 : 0.3);
  rig.shadow.visible = false;
  rig.label.visible = false;
  rig.tool.visible = rig.toolL.visible = false;
}

export interface WheelRig {
  steer: THREE.Group;
  spin: THREE.Group;
  front: boolean;
}

export interface CartModel {
  root: THREE.Group;
  wheels: WheelRig[];
  /** Whoever's driving, sat in the seat, or null. */
  driver: HumanRig | null;
  driverSkin: number;
  label: THREE.Sprite;
}

const WHEEL_Y = -0.3;

let wheelGeo: THREE.BufferGeometry | null = null;
function wheelGeometry(): THREE.BufferGeometry {
  return (wheelGeo ??= merge([
    paint(new THREE.CylinderGeometry(CART.wheelRadius, CART.wheelRadius, 0.17, 14).rotateX(Math.PI / 2), 0x1e1e1e),
    paint(new THREE.CylinderGeometry(0.11, 0.11, 0.18, 10).rotateX(Math.PI / 2), 0xb2bec3),
  ]));
}

const bodies = new Map<number, THREE.BufferGeometry>();
function cartGeometry(color: number): THREE.BufferGeometry {
  let g = bodies.get(color);
  if (g) return g;
  const shell = 0xf5f6fa;
  const trim = 0x2d3436;
  const hw = CART.halfWidth;
  const parts: THREE.BufferGeometry[] = [
    // floor pan and bumpers
    box(2.3, 0.14, hw * 2 - 0.04, 0, 0.02, 0, trim),
    box(0.1, 0.16, hw * 2, 1.18, 0.05, 0, 0x111111),
    box(0.1, 0.16, hw * 2, -1.18, 0.05, 0, 0x111111),
    // the nose and the back, where the bags go
    box(0.6, 0.42, hw * 2 - 0.06, 0.86, 0.3, 0, shell),
    box(0.3, 0.12, hw * 2 - 0.1, 0.62, 0.47, 0, color),
    box(0.62, 0.5, hw * 2 - 0.06, -0.86, 0.33, 0, shell),
    // headlights
    box(0.04, 0.08, 0.14, 1.17, 0.35, 0.38, 0xfff7c2),
    box(0.04, 0.08, 0.14, 1.17, 0.35, -0.38, 0xfff7c2),
    // the bench and its back
    box(0.52, 0.14, hw * 2 - 0.14, DRIVER_SEAT.x, DRIVER_SEAT.z + 0.04, 0, 0xdfe6e9),
    box(0.1, 0.5, hw * 2 - 0.14, DRIVER_SEAT.x - 0.3, DRIVER_SEAT.z + 0.36, 0, 0xdfe6e9),
    box(0.46, 0.16, hw * 2 - 0.14, DRIVER_SEAT.x, DRIVER_SEAT.z - 0.1, 0, shell),
    // wheel and column, in front of the driver
    paint(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 6).rotateZ(-0.7).translate(0.42, 0.65, DRIVER_SEAT.y), trim),
    paint(new THREE.TorusGeometry(0.16, 0.022, 6, 16).rotateY(Math.PI / 2).rotateZ(-0.7).translate(0.26, 0.82, DRIVER_SEAT.y), trim),
    // roof on four posts
    box(1.98, 0.07, hw * 2 + 0.1, -0.1, 1.56, 0, color),
    ...[0.74, -0.94].flatMap((x) => [box(0.05, 1.2, 0.05, x, 0.95, hw - 0.06, trim), box(0.05, 1.2, 0.05, x, 0.95, -hw + 0.06, trim)]),
    // a windscreen frame
    box(0.03, 0.03, hw * 2, 0.74, 1.15, 0, trim),
    // two golf bags standing in the back
    ...[0.24, -0.24].flatMap((z, i) => [
      paint(new THREE.CylinderGeometry(0.12, 0.11, 0.85, 8).rotateZ(0.35).translate(-1.02, 0.85, z), i ? 0x2d3436 : 0xc0392b),
      paint(new THREE.CylinderGeometry(0.02, 0.02, 0.25, 5).rotateZ(0.35).translate(-1.18, 1.35, z + 0.04), 0xdfe6e9),
      paint(new THREE.CylinderGeometry(0.02, 0.02, 0.25, 5).rotateZ(0.35).translate(-1.14, 1.37, z - 0.05), 0xdfe6e9),
    ]),
  ];
  g = merge(parts);
  bodies.set(color, g);
  return g;
}

export function buildCart(slot: number): CartModel {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(cartGeometry(CART_COLORS[slot % CART_COLORS.length]), SOLID));
  const wheels: WheelRig[] = [];
  for (const [x, z] of [
    [0.82, 0.55],
    [0.82, -0.55],
    [-0.82, 0.55],
    [-0.82, -0.55],
  ]) {
    const steer = new THREE.Group();
    steer.position.set(x, WHEEL_Y, z);
    const spin = new THREE.Group();
    spin.add(new THREE.Mesh(wheelGeometry(), SOLID));
    steer.add(spin);
    root.add(steer);
    wheels.push({ steer, spin, front: x > 0 });
  }
  const label = nameTag(2.2);
  root.add(label);
  return { root, wheels, driver: null, driverSkin: -1, label };
}

let ballGeo: THREE.BufferGeometry | null = null;
/** A ball, a little bigger than life so it can be seen at all: views scale it further with distance. */
export function ballGeometry(): THREE.BufferGeometry {
  return (ballGeo ??= new THREE.IcosahedronGeometry(0.03, 2));
}

let flagGeo: THREE.BufferGeometry | null = null;
/** A flagstick standing in the cup, with the flag along +X from the top. */
export function flagGeometry(): THREE.BufferGeometry {
  return (flagGeo ??= merge([
    paint(new THREE.CylinderGeometry(0.018, 0.018, 2.4, 6).translate(0, 1.2, 0), 0xf5f6fa),
    paint(new THREE.CircleGeometry(0.11, 16).rotateX(-Math.PI / 2).translate(0, 0.012, 0), 0x111111),
  ]));
}

let clothGeo: THREE.BufferGeometry | null = null;
/** The flag itself, pivoting at the pole: sways in the wind. */
export function clothGeometry(): THREE.BufferGeometry {
  if (clothGeo) return clothGeo;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.62, -0.2, 0, 0, -0.4, 0], 3));
  g.computeVertexNormals();
  return (clothGeo = g);
}
