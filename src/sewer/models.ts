import * as THREE from 'three';
import { SOLID, box, buildHuman, cached, glowTexture, merge, paint, type HumanRig } from '../crossplay/models';
import { LootKind } from './defs';

/**
 * Sewer Lordz's models, low-poly and vertex-coloured like the rest (see crossplay/models.ts). Scene axes: models face +X
 * with +Z on their right, and y is up.
 */

// ---------------------------------------------------------------------------
// Lordz: sewer workers in hi-vis, waders and hard hats with lamps
// ---------------------------------------------------------------------------

const VESTS = [0xff7a1a, 0xe8e21a, 0xff5a2a, 0xc6e82a, 0xffa31a, 0x2ae8c6];
const WADERS = [0x2f4a2a, 0x3a3a2a, 0x28302e, 0x44402a];
const SKINS = [0xf1c9a5, 0xd9a47a, 0xa8714d, 0x7a4e32, 0xe8b894, 0x5c3a24];
const HAIR = [0x2a1d14, 0x5a3a1c, 0xc8a25a, 0x1a1a1a, 0x8c4a2a, 0xb9b3a9];
const HATS = [0xf2c12e, 0xf2f2f2, 0xe86a1a, 0x2a7ae8];

export function lordColor(skin: number): number {
  return VESTS[skin % VESTS.length];
}

export function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export interface LordModel extends HumanRig {
  /** The lamp on the hard hat, which glows. */
  lamp: THREE.Sprite;
  /** The sack on their back, shown once there's something in it. */
  sack: THREE.Group;
}

export function lordModel(skin: number): LordModel {
  const rig = buildHuman({
    shirt: lordColor(skin),
    pants: WADERS[(skin * 3) % WADERS.length],
    skin: SKINS[(skin * 7) % SKINS.length],
    hair: HAIR[(skin * 5) % HAIR.length],
    hat: HATS[(skin * 11) % HATS.length],
    badge: 0xd8d8d8,
  });
  // the lamp on the front of the hat
  rig.head.add(new THREE.Mesh(cached('headlamp', () => merge([box(0.05, 0.06, 0.08, 0.15, 0.27, 0, 0x2a2a2a), box(0.01, 0.045, 0.06, 0.176, 0.27, 0, 0xfff4c8)])), SOLID));
  const lamp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xfff0c0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
  lamp.position.set(0.2, 0.27, 0);
  lamp.scale.setScalar(0.35);
  rig.head.add(lamp);
  // a lumpy sack slung on the back
  const sack = new THREE.Group();
  sack.add(new THREE.Mesh(cached('sack', () => merge([paint(new THREE.SphereGeometry(0.22, 8, 6).scale(0.8, 1, 1), 0x8a6a3a), box(0.06, 0.1, 0.06, 0, 0.22, 0, 0x6a4a2a)])), SOLID));
  sack.position.set(-0.3, 1.2, 0);
  sack.visible = false;
  rig.body.add(sack);
  return { ...rig, lamp, sack };
}

/** Face down in the muck. Put `rig.root` at the feet first. */
export function poseDowned(rig: HumanRig, heading: number, t: number): void {
  rig.body.rotation.set(0, -heading, -Math.PI / 2 + 0.25, 'YXZ');
  rig.body.position.y = 0.3;
  const crawl = Math.sin(t * 3) * 0.3;
  rig.armR.rotation.set(0, 0, Math.PI - 0.5 + crawl);
  rig.armL.rotation.set(0, 0, Math.PI - 0.8 - crawl);
  rig.legL.rotation.set(0, 0, 0.15 + crawl * 0.4);
  rig.legR.rotation.set(0, 0, -0.1 - crawl * 0.4);
  rig.head.rotation.set(0, 0, 0.9);
  rig.shadow.visible = false;
}

/** Floating face down. */
export function poseDead(rig: HumanRig, heading: number, t: number): void {
  rig.body.rotation.set(Math.sin(t * 0.7) * 0.1, -heading, -Math.PI / 2 - 0.1, 'YXZ');
  rig.body.position.y = 0.2 + Math.sin(t * 1.3) * 0.03;
  rig.armR.rotation.set(0.3, 0, 1.2);
  rig.armL.rotation.set(-0.2, 0, 1.4);
  rig.legL.rotation.set(0, 0, 0.1);
  rig.legR.rotation.set(0, 0, -0.05);
  rig.head.rotation.set(0.4, 0, 0);
  rig.shadow.visible = false;
}

// ---------------------------------------------------------------------------
// Goblins: short, green and nasty, in parts that are also their ragdoll
// ---------------------------------------------------------------------------

export type PartName = 'pelvis' | 'torso' | 'head' | 'armL' | 'armR' | 'legL' | 'legR';

export interface GoblinPart {
  name: PartName;
  /** Full size of its box, for physics. */
  size: readonly [number, number, number];
  /** Where its middle is, standing, relative to the feet. */
  center: readonly [number, number, number];
  /** The joint it turns about, and what it hangs from. */
  joint: readonly [number, number, number];
  parent: PartName | null;
}

export const GOBLIN_PARTS: readonly GoblinPart[] = [
  { name: 'pelvis', size: [0.2, 0.16, 0.28], center: [0, 0.56, 0], joint: [0, 0.56, 0], parent: null },
  { name: 'torso', size: [0.24, 0.34, 0.32], center: [0.04, 0.8, 0], joint: [0, 0.63, 0], parent: 'pelvis' },
  { name: 'head', size: [0.28, 0.24, 0.26], center: [0.1, 1.08, 0], joint: [0.06, 0.96, 0], parent: 'torso' },
  { name: 'armL', size: [0.08, 0.5, 0.08], center: [0.03, 0.7, -0.21], joint: [0.03, 0.94, -0.19], parent: 'torso' },
  { name: 'armR', size: [0.08, 0.5, 0.08], center: [0.03, 0.7, 0.21], joint: [0.03, 0.94, 0.19], parent: 'torso' },
  { name: 'legL', size: [0.11, 0.5, 0.11], center: [0, 0.26, -0.09], joint: [0, 0.5, -0.09], parent: 'pelvis' },
  { name: 'legR', size: [0.11, 0.5, 0.11], center: [0, 0.26, 0.09], joint: [0, 0.5, 0.09], parent: 'pelvis' },
];

const GOBLIN_SKINS = [0x6b8a3a, 0x5a7d4a, 0x7f8f3c, 0x4e6b3a, 0x8a8a4a, 0x6a7a5a];
const RAGS = [0x4a3a28, 0x3a3226, 0x5a2e22, 0x2e3a2a];
export const GUNK: [number, number, number] = [0.42, 0.5, 0.12];

export function goblinSkin(look: number): number {
  return GOBLIN_SKINS[look % GOBLIN_SKINS.length];
}

/** A part's geometry, about its own middle. */
function partGeometry(part: PartName, look: number): THREE.BufferGeometry {
  const skin = goblinSkin(look);
  const dark = new THREE.Color(skin).multiplyScalar(0.7).getHex();
  const rag = RAGS[(look * 3) % RAGS.length];
  return cached(`goblin:${part}:${look % 24}`, () => {
    switch (part) {
      case 'pelvis':
        return merge([box(0.2, 0.16, 0.28, 0, 0, 0, rag), box(0.04, 0.14, 0.18, 0.1, -0.08, 0, rag)]);
      case 'torso':
        // pot belly, knobbly spine
        return merge([box(0.24, 0.34, 0.3, 0, 0, 0, skin), box(0.1, 0.22, 0.24, 0.1, -0.04, 0, dark), box(0.06, 0.26, 0.06, -0.13, 0.02, 0, dark)]);
      case 'head':
        return merge([
          box(0.26, 0.22, 0.24, 0, 0, 0, skin),
          // a long hooked nose, and a mouth full of teeth
          box(0.12, 0.06, 0.06, 0.17, -0.01, 0, dark),
          box(0.05, 0.05, 0.05, 0.22, -0.05, 0, dark),
          box(0.02, 0.04, 0.16, 0.13, -0.08, 0, 0x2a0a0a),
          box(0.02, 0.025, 0.02, 0.141, -0.065, -0.05, 0xe8e0b0),
          box(0.02, 0.025, 0.02, 0.141, -0.065, 0.04, 0xe8e0b0),
          // big pointed ears
          paint(new THREE.ConeGeometry(0.06, 0.26, 4).rotateX(Math.PI / 2 - 0.35).translate(0, 0.06, 0.2), skin),
          paint(new THREE.ConeGeometry(0.06, 0.26, 4).rotateX(-Math.PI / 2 + 0.35).translate(0, 0.06, -0.2), skin),
          // a few hairs, and warts
          box(0.02, 0.08, 0.02, -0.02, 0.14, 0.03, 0x1a1a10),
          box(0.02, 0.06, 0.02, 0.03, 0.13, -0.04, 0x1a1a10),
          box(0.03, 0.03, 0.03, 0.12, 0.07, 0.09, dark),
        ]);
      case 'armL':
      case 'armR':
        return merge([box(0.08, 0.42, 0.08, 0, 0.04, 0, skin), box(0.1, 0.08, 0.1, 0.01, -0.21, 0, dark), box(0.05, 0.02, 0.02, 0.06, -0.25, 0.03, 0xd8d0a0), box(0.05, 0.02, 0.02, 0.06, -0.25, -0.03, 0xd8d0a0)]);
      default:
        return merge([box(0.1, 0.44, 0.1, 0, 0.03, 0, skin), box(0.2, 0.06, 0.12, 0.05, -0.22, 0, dark), box(0.04, 0.02, 0.03, 0.16, -0.24, 0.04, 0xd8d0a0), box(0.04, 0.02, 0.03, 0.16, -0.24, -0.04, 0xd8d0a0)]);
    }
  });
}

const eyeMat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffe23a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false });

/** A mesh for one part: the head with its glowing eyes. */
export function goblinPartMesh(part: PartName, look: number): THREE.Mesh {
  const mesh = new THREE.Mesh(partGeometry(part, look), SOLID);
  if (part === 'head') {
    for (const z of [-0.06, 0.06]) {
      const eye = new THREE.Sprite(eyeMat);
      eye.position.set(0.125, 0.035, z);
      eye.scale.setScalar(0.09);
      mesh.add(eye);
    }
  }
  return mesh;
}

export interface GoblinRig {
  root: THREE.Group;
  /** Leans, bobs and lunges; the pelvis. */
  body: THREE.Group;
  /** The pivot each part turns about. */
  pivots: Record<PartName, THREE.Group>;
  meshes: Record<PartName, THREE.Mesh>;
  /** Whatever it's run off with, held over its head. */
  loot: THREE.Group;
}

/** A goblin standing at its feet, facing +X, with a pivot at each joint. */
export function goblinRig(look: number): GoblinRig {
  const root = new THREE.Group();
  const pivots = {} as Record<PartName, THREE.Group>;
  const meshes = {} as Record<PartName, THREE.Mesh>;
  for (const part of GOBLIN_PARTS) {
    const pivot = new THREE.Group();
    const parent = part.parent ? GOBLIN_PARTS.find((p) => p.name === part.parent)! : null;
    pivot.position.set(part.joint[0] - (parent?.joint[0] ?? 0), part.joint[1] - (parent?.joint[1] ?? 0), part.joint[2] - (parent?.joint[2] ?? 0));
    const mesh = goblinPartMesh(part.name, look);
    mesh.position.set(part.center[0] - part.joint[0], part.center[1] - part.joint[1], part.center[2] - part.joint[2]);
    pivot.add(mesh);
    (part.parent ? pivots[part.parent] : root).add(pivot);
    pivots[part.name] = pivot;
    meshes[part.name] = mesh;
  }
  const loot = new THREE.Group();
  loot.position.set(0.05, 0.62, 0);
  pivots.torso.add(loot);
  return { root, body: pivots.pelvis, pivots, meshes, loot };
}

/** Back to standing straight, arms hanging. */
export function restGoblin(r: GoblinRig): void {
  for (const p of Object.values(r.pivots)) p.rotation.set(0, 0, 0);
  r.body.position.set(0, GOBLIN_PARTS[0].joint[1], 0);
}

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------

const GOLD = 0xe8b830;
const GOLD_DARK = 0xb8901a;

/** Loot's model, sitting on the ground at its origin. */
export function lootGeometry(kind: LootKind): THREE.BufferGeometry {
  return cached(`loot:${kind}`, () => {
    switch (kind) {
      case LootKind.Coins:
        return merge([0, 1, 2, 3].map((i) => paint(new THREE.CylinderGeometry(0.05, 0.05, 0.015, 10).translate((i % 2) * 0.03, 0.01 + i * 0.016, 0), i % 2 ? GOLD : GOLD_DARK)));
      case LootKind.Ring:
        return merge([paint(new THREE.TorusGeometry(0.05, 0.014, 6, 16).rotateX(Math.PI / 2).translate(0, 0.02, 0), GOLD), box(0.03, 0.03, 0.03, 0.05, 0.03, 0, 0xd83aff)]);
      case LootKind.Watch:
        return merge([paint(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 14).translate(0, 0.02, 0), GOLD), paint(new THREE.CylinderGeometry(0.05, 0.05, 0.022, 14).translate(0, 0.022, 0), 0xf2ecd8), box(0.2, 0.008, 0.01, 0.12, 0.012, 0, GOLD_DARK)]);
      case LootKind.Teeth:
        return merge([box(0.12, 0.03, 0.06, 0, 0.02, 0, 0xd87a8a), ...[-0.04, -0.013, 0.013, 0.04].map((x, i) => box(0.022, 0.03, 0.02, x, 0.045, 0.02, i === 1 ? GOLD : 0xf2ead0))]);
      case LootKind.Gem:
        return paint(new THREE.OctahedronGeometry(0.07, 0).translate(0, 0.07, 0), 0x3ae88a);
      case LootKind.Crown:
        return merge([
          paint(new THREE.CylinderGeometry(0.13, 0.12, 0.08, 12, 1, true).translate(0, 0.04, 0), GOLD),
          ...[0, 1, 2, 3, 4].map((i) => paint(new THREE.ConeGeometry(0.03, 0.08, 4).translate(Math.cos((i / 5) * Math.PI * 2) * 0.12, 0.12, Math.sin((i / 5) * Math.PI * 2) * 0.12), GOLD)),
          box(0.03, 0.03, 0.03, 0.125, 0.05, 0, 0xe83a3a),
          box(0.03, 0.03, 0.03, -0.125, 0.05, 0, 0x3a6ae8),
        ]);
      case LootKind.Toilet:
        return merge([
          paint(new THREE.CylinderGeometry(0.2, 0.14, 0.38, 12).translate(0, 0.19, 0), GOLD),
          paint(new THREE.TorusGeometry(0.19, 0.035, 6, 14).rotateX(Math.PI / 2).translate(0, 0.4, 0), GOLD_DARK),
          box(0.14, 0.34, 0.36, -0.2, 0.55, 0, GOLD),
          box(0.16, 0.04, 0.38, -0.2, 0.73, 0, GOLD_DARK),
          box(0.04, 0.03, 0.06, -0.11, 0.66, 0.1, 0xf2ead0),
        ]);
    }
  });
}

/** How big loot is, for drawing it in a goblin's hands or on the ground. */
export function lootScale(kind: LootKind): number {
  return kind === LootKind.Toilet ? 0.8 : kind === LootKind.Crown ? 1.3 : 1.8;
}

const glintMat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffe08a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false });

export function lootModel(kind: LootKind): { root: THREE.Group; spin: THREE.Group; glint: THREE.Sprite } {
  const root = new THREE.Group();
  const spin = new THREE.Group();
  spin.add(new THREE.Mesh(lootGeometry(kind), SOLID));
  spin.scale.setScalar(lootScale(kind));
  const glint = new THREE.Sprite(glintMat);
  glint.position.y = 0.2;
  glint.scale.setScalar(0.6);
  root.add(spin, glint);
  return { root, spin, glint };
}
