import * as THREE from 'three';
import { SOLID, blobShadow, box, buildToolPickup, cached, merge, nameTag, paint, pickupGlow } from '../crossplay/models';
import type { Tool } from '../crossplay/tool';
import { CarKind, PickupKind } from './defs';
import { CAR_COLORS, carSpec } from './specs';

/**
 * Peer City's low-poly procedural models: cars and pickups. People and tools are shared (crossplay/models.ts).
 * Models face +X (a heading of 0) with +Z on their right.
 */

export const MAT = {
  solid: SOLID,
  car: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  burnt: new THREE.MeshLambertMaterial({ color: 0x1c1c1c, side: THREE.DoubleSide }),
  glass: new THREE.MeshLambertMaterial({ color: 0xa6cde6, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }),
  sirenRed: [new THREE.MeshLambertMaterial({ color: 0x551515 }), new THREE.MeshBasicMaterial({ color: 0xff2a2a })],
  sirenBlue: [new THREE.MeshLambertMaterial({ color: 0x152055 }), new THREE.MeshBasicMaterial({ color: 0x3b6bff })],
};

// ---------------------------------------------------------------------------
// Cars
// ---------------------------------------------------------------------------

export interface CarRig {
  root: THREE.Group;
  body: THREE.Mesh;
  wheels: THREE.Mesh[];
  /** Rotate `.children[0].rotation.x` to turn the wheel. */
  steering: THREE.Group;
  sirens: THREE.Mesh[];
  /** Stand-in driver shown while AI drives. */
  npc: THREE.Mesh;
  shadow: THREE.Mesh;
  label: THREE.Sprite;
}

function carBody(kind: number, color: number): THREE.BufferGeometry {
  const s = carSpec(kind);
  const L = s.length;
  const W = s.width;
  const hw = W / 2;
  const paintC = kind === CarKind.Taxi ? 0xf4c20d : kind === CarKind.Police ? 0xf2f2f2 : CAR_COLORS[color % CAR_COLORS.length];
  const doorC = kind === CarKind.Police ? 0x151515 : paintC;
  const trim = 0x1c1c1e;
  const bodyH = s.belt - s.floor;
  const midY = (s.floor + s.belt) / 2;
  const cabinLen = s.cabinFront - s.cabinRear;
  const cabinMid = (s.cabinFront + s.cabinRear) / 2;
  const rearTop = s.cargo ? s.roof : s.belt;
  const seat = 0x3a3a3e;
  const parts = [
    box(L - 0.1, 0.12, W - 0.1, 0, s.floor + 0.06, 0, trim),
    box(L / 2 - s.cabinFront, bodyH, W, (s.cabinFront + L / 2) / 2, midY, 0, paintC),
    box(s.cabinRear + L / 2, rearTop - s.floor, W, (s.cabinRear - L / 2) / 2, (s.floor + rearTop) / 2, 0, paintC),
    box(cabinLen, bodyH, 0.08, cabinMid, midY, -(hw - 0.04), doorC),
    box(cabinLen, bodyH, 0.08, cabinMid, midY, hw - 0.04, doorC),
    box(0.14, 0.26, W + 0.02, L / 2 + 0.03, s.floor + 0.12, 0, trim),
    box(0.14, 0.26, W + 0.02, -L / 2 - 0.03, s.floor + 0.12, 0, trim),
    box(0.34, 0.2, W - 0.18, s.cabinFront - 0.17, s.belt - 0.04, 0, 0x202024),
    box(cabinLen + 0.02, 0.07, W - 0.04, cabinMid, s.roof - 0.035, 0, paintC),
  ];
  for (const side of [-1, 1]) {
    parts.push(box(0.04, 0.12, 0.34, L / 2 + 0.005, s.belt - 0.16, side * (hw - 0.3), 0xfff4c8));
    parts.push(box(0.04, 0.12, 0.3, -L / 2 - 0.005, s.belt - 0.16, side * (hw - 0.28), 0xd01616));
    parts.push(box(0.5, 0.14, 0.5, s.eye[0] - 0.05, s.floor + 0.3, side * 0.42, seat));
    parts.push(box(0.12, 0.62, 0.5, s.eye[0] - 0.33, s.floor + 0.65, side * 0.42, seat));
    for (const px of [s.cabinRear + 0.05, s.cabinFront - 0.05]) {
      parts.push(box(0.08, s.roof - s.belt, 0.08, px, (s.roof + s.belt) / 2, side * (hw - 0.06), paintC));
    }
  }
  if (kind === CarKind.Taxi) parts.push(box(0.26, 0.16, 0.62, cabinMid, s.roof + 0.08, 0, 0xffe36b));
  if (kind === CarKind.Police) parts.push(box(0.3, 0.06, 1.3, cabinMid, s.roof + 0.03, 0, trim));
  return merge(parts);
}

function carGlass(kind: number): THREE.BufferGeometry {
  const s = carSpec(kind);
  const hw = s.width / 2;
  const h = s.roof - s.belt - 0.07;
  const y = s.belt + h / 2;
  const parts: THREE.BufferGeometry[] = [new THREE.PlaneGeometry(s.width - 0.14, h).rotateY(Math.PI / 2).translate(s.cabinFront - 0.04, y, 0)];
  if (!s.cargo) parts.push(new THREE.PlaneGeometry(s.width - 0.14, h).rotateY(Math.PI / 2).translate(s.cabinRear + 0.04, y, 0));
  for (const side of [-1, 1]) {
    parts.push(new THREE.PlaneGeometry(s.cabinFront - s.cabinRear - 0.1, h).translate((s.cabinFront + s.cabinRear) / 2, y, side * (hw - 0.05)));
  }
  return merge(parts);
}

const NPC_SHIRTS = [0x6c7a89, 0x8e5b3a, 0x3d5a80, 0x7a4069, 0x4f7942, 0x9a8c6e, 0x5c5c66, 0xa5553a];

export function buildCar(kind: number, color: number): CarRig {
  const s = carSpec(kind);
  const hw = s.width / 2;
  const root = new THREE.Group();
  const body = new THREE.Mesh(
    cached(`car:${kind}:${color}`, () => carBody(kind, color)),
    MAT.car,
  );
  root.add(body);
  const glass = new THREE.Mesh(
    cached(`glass:${kind}`, () => carGlass(kind)),
    MAT.glass,
  );
  glass.renderOrder = 3;
  root.add(glass);

  const wheelGeo = cached(`wheel:${s.wheelR}`, () =>
    merge([paint(new THREE.CylinderGeometry(s.wheelR, s.wheelR, 0.26, 14).rotateX(Math.PI / 2), 0x151515), box(0.1, s.wheelR * 1.3, 0.28, 0, 0, 0, 0x9a9a9a)]),
  );
  const wheels: THREE.Mesh[] = [];
  for (const fx of [1, -1]) {
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(wheelGeo, MAT.solid);
      w.position.set(fx * (s.length / 2 - 0.85), s.wheelR, side * (hw - 0.12));
      wheels.push(w);
      root.add(w);
    }
  }

  const steering = new THREE.Group();
  steering.position.set(s.eye[0] + 0.5, s.eye[1] - 0.47, s.eye[2]);
  steering.rotation.z = 0.45;
  steering.add(
    new THREE.Mesh(
      cached('steering', () => merge([paint(new THREE.TorusGeometry(0.17, 0.022, 6, 18).rotateY(Math.PI / 2), 0x111111), box(0.03, 0.32, 0.03, 0, 0, 0, 0x111111)])),
      MAT.solid,
    ),
  );
  root.add(steering);

  const sirens: THREE.Mesh[] = [];
  if (kind === CarKind.Police) {
    const cabinMid = (s.cabinFront + s.cabinRear) / 2;
    const sirenGeo = cached('siren', () => new THREE.BoxGeometry(0.24, 0.1, 0.5));
    for (const [side, mats] of [
      [-1, MAT.sirenRed],
      [1, MAT.sirenBlue],
    ] as const) {
      const m = new THREE.Mesh(sirenGeo, mats[0]);
      m.position.set(cabinMid, s.roof + 0.11, side * 0.33);
      sirens.push(m);
      root.add(m);
    }
  }

  const npc = new THREE.Mesh(
    cached(`npc:${kind}:${color}`, () => {
      const cop = kind === CarKind.Police;
      const [ex, ey, ez] = s.eye;
      return merge([
        box(0.26, 0.52, 0.42, ex - 0.12, ey - 0.52, ez, cop ? 0x23346e : NPC_SHIRTS[color % NPC_SHIRTS.length]),
        box(0.22, 0.24, 0.22, ex - 0.04, ey - 0.04, ez, 0xe0ac69),
        box(0.24, 0.06, 0.24, ex - 0.05, ey + 0.1, ez, cop ? 0x1f2a52 : 0x2c1b0e),
      ]);
    }),
    MAT.solid,
  );
  npc.visible = false;
  root.add(npc);

  const shadow = blobShadow(s.length * 1.15, s.width * 1.5);
  root.add(shadow);
  const label = nameTag(s.roof + 0.9);
  root.add(label);
  return { root, body, wheels, steering, sirens, npc, shadow, label };
}

// ---------------------------------------------------------------------------
// Pickups
// ---------------------------------------------------------------------------

export interface PickupRig {
  root: THREE.Group;
  spin: THREE.Group;
}

/** `tool` is the kind of tool in a tool pickup (null if this peer doesn't know it). */
export function buildPickup(kind: number, tool: Tool<any> | null): PickupRig {
  if (kind === PickupKind.Tool && tool) return buildToolPickup(tool);
  const cash = kind === PickupKind.Cash;
  const geo = cash
    ? cached('cash', () =>
        merge([box(0.42, 0.1, 0.22, 0, -0.05, 0, 0x2e9e4f), box(0.42, 0.1, 0.22, 0.03, 0.05, 0.02, 0x3cbf62), box(0.1, 0.22, 0.24, 0, 0, 0, 0xe8e0b0)]),
      )
    : cached('health', () =>
        merge([
          box(0.36, 0.36, 0.36, 0, 0, 0, 0xf4f4f4),
          box(0.38, 0.08, 0.24, 0, 0, 0, 0xe53935),
          box(0.38, 0.24, 0.08, 0, 0, 0, 0xe53935),
          box(0.24, 0.08, 0.38, 0, 0, 0, 0xe53935),
          box(0.08, 0.24, 0.38, 0, 0, 0, 0xe53935),
        ]),
      );
  const root = new THREE.Group();
  const spin = new THREE.Group();
  spin.position.y = 0.6;
  spin.add(new THREE.Mesh(geo, SOLID));
  root.add(spin, pickupGlow(cash ? 0x6eff7a : 0xff6b6b));
  return { root, spin };
}
