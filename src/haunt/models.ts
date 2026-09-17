import * as THREE from 'three';
import { SOLID, blobShadow, box, buildHuman, cached, glowTexture, merge, nameTag, paint, type HumanRig } from '../crossplay/models';
import { MonsterKind } from './defs';

/**
 * Peer Haunt's models, low-poly and vertex-coloured like the rest (see crossplay/models.ts). Scene axes: models face +X
 * with +Z on their right, and y is up.
 */

// ---------------------------------------------------------------------------
// Survivors
// ---------------------------------------------------------------------------

/** Coats and jumpers in colours that still read by flashlight. */
const COATS = [0x8a3b2e, 0x2f5d7c, 0x6b7a3a, 0xa57c2c, 0x5c3f73, 0x3f6f64, 0x7d2f4f, 0x9b9486, 0x44506b, 0xb0562c];
const TROUSERS = [0x2b2b33, 0x3b3226, 0x2a3440, 0x4a4238, 0x1f2a24];
const SKINS = [0xf1c9a5, 0xd9a47a, 0xa8714d, 0x7a4e32, 0xe8b894, 0x5c3a24];
const HAIR = [0x2a1d14, 0x5a3a1c, 0xc8a25a, 0x1a1a1a, 0x8c4a2a, 0xb9b3a9];

export function survivorColor(skin: number): number {
  return COATS[skin % COATS.length];
}

export function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function survivorModel(skin: number): HumanRig {
  return buildHuman({
    shirt: survivorColor(skin),
    pants: TROUSERS[(skin * 3) % TROUSERS.length],
    skin: SKINS[(skin * 7) % SKINS.length],
    hair: HAIR[(skin * 5) % HAIR.length],
    hat: skin % 4 === 1 ? 0x3a3a3a : undefined,
  });
}

/** Down on the floor, propped on an arm, reaching out. Put `rig.root` at the feet first. */
export function poseDowned(rig: HumanRig, heading: number, t: number): void {
  rig.body.rotation.set(0, -heading, -Math.PI / 2 + 0.25, 'YXZ');
  rig.body.position.y = 0.32;
  const crawl = Math.sin(t * 3) * 0.25;
  rig.armR.rotation.set(0, 0, Math.PI - 0.5 + crawl);
  rig.armL.rotation.set(0, 0, Math.PI - 0.8 - crawl);
  rig.legL.rotation.set(0, 0, 0.15 + crawl * 0.4);
  rig.legR.rotation.set(0, 0, -0.1 - crawl * 0.4);
  rig.head.rotation.set(0, 0, 0.9);
  rig.shadow.visible = false;
}

/** Lying still. */
export function poseDead(rig: HumanRig, heading: number): void {
  rig.body.rotation.set(0, -heading, -Math.PI / 2 + 0.03, 'YXZ');
  rig.body.position.y = 0.16;
  rig.armR.rotation.set(0.3, 0, 0.5);
  rig.armL.rotation.set(-0.2, 0, -0.3);
  rig.legL.rotation.set(0, 0, 0.1);
  rig.legR.rotation.set(0, 0, -0.05);
  rig.head.rotation.set(0.4, 0, 0);
  rig.shadow.visible = false;
}

// ---------------------------------------------------------------------------
// Monsters
// ---------------------------------------------------------------------------

export interface MonsterModel {
  root: THREE.Group;
  /** Leans, bobs and lunges. */
  body: THREE.Group;
  eyes: THREE.Sprite[];
  /** Everything that tints as it burns: the shade's shroud (unlit), or flesh a flashlight lights (with an emissive glow to burn). */
  materials: (THREE.MeshBasicMaterial | THREE.MeshLambertMaterial)[];
  limbs: THREE.Group[];
  label: THREE.Sprite;
  /** Only the Haunt sees these: a ring when it's picked out, and how much of it is left. */
  ring: THREE.Mesh;
  bar: THREE.Group;
  barFill: THREE.Mesh;
  /** A glow over its head in its kind's colour, so the Haunt can find it from far off. */
  badge: THREE.Sprite;
  shadow: THREE.Mesh;
}

/** Each kind's colour on the Haunt's screen. */
export const MONSTER_COLORS: Record<MonsterKind, number> = {
  [MonsterKind.Shade]: 0xb46bff,
  [MonsterKind.Crawler]: 0xffc94a,
  [MonsterKind.Brute]: 0xff5a3a,
};

const eyeMaterials = new Map<number, THREE.SpriteMaterial>();
function eyeMaterial(color: number): THREE.SpriteMaterial {
  let m = eyeMaterials.get(color);
  if (!m) eyeMaterials.set(color, (m = new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false })));
  return m;
}

function eye(color: number, x: number, y: number, z: number, size: number): THREE.Sprite {
  const s = new THREE.Sprite(eyeMaterial(color));
  s.position.set(x, y, z);
  s.scale.setScalar(size);
  return s;
}

const RING_GEO = new THREE.RingGeometry(0.62, 0.8, 32).rotateX(-Math.PI / 2);

export function monsterModel(kind: MonsterKind): MonsterModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const materials: (THREE.MeshBasicMaterial | THREE.MeshLambertMaterial)[] = [];
  const limbs: THREE.Group[] = [];
  const eyes: THREE.Sprite[] = [];
  const shadow = blobShadow(1, 1);
  root.add(shadow);
  let top = 2;

  switch (kind) {
    case MonsterKind.Shade: {
      // a tattered shroud with nothing inside it but two pale eyes
      const robe = new THREE.MeshBasicMaterial({ color: 0x0d0b14, transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthWrite: false });
      const hem = new THREE.MeshBasicMaterial({ color: 0x1c1826, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
      materials.push(robe, hem);
      body.add(new THREE.Mesh(cached('shade-robe', () => new THREE.ConeGeometry(0.5, 1.7, 9, 3, true).translate(0, 0.95, 0)), robe));
      body.add(new THREE.Mesh(cached('shade-hood', () => new THREE.SphereGeometry(0.27, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.62).translate(0, 1.75, 0)), robe));
      const tatters = new THREE.Group();
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        const strip = new THREE.Mesh(cached('shade-strip', () => new THREE.PlaneGeometry(0.22, 0.6).translate(0, -0.3, 0)), hem);
        strip.position.set(Math.cos(a) * 0.46, 0.18, Math.sin(a) * 0.46);
        strip.rotation.y = -a + Math.PI / 2;
        tatters.add(strip);
        limbs.push(strip as unknown as THREE.Group);
      }
      body.add(tatters);
      // arms reaching out of the sleeves
      for (const side of [-1, 1]) {
        const arm = new THREE.Group();
        arm.position.set(0.05, 1.45, side * 0.28);
        arm.add(new THREE.Mesh(cached('shade-arm', () => new THREE.ConeGeometry(0.11, 0.75, 6, 1, true).rotateZ(Math.PI / 2).translate(0.35, 0, 0)), robe));
        body.add(arm);
        limbs.push(arm);
      }
      eyes.push(eye(0xcfe6ff, 0.22, 1.72, -0.08, 0.13), eye(0xcfe6ff, 0.22, 1.72, 0.08, 0.13));
      body.add(...eyes);
      top = 2.1;
      break;
    }
    case MonsterKind.Crawler: {
      // something pale and too long, on all fours
      const skin = new THREE.MeshLambertMaterial({ vertexColors: true });
      materials.push(skin);
      body.add(
        new THREE.Mesh(
          cached('crawler-body', () =>
            merge([
              box(0.95, 0.26, 0.36, 0, 0.55, 0, 0x8d9580),
              box(0.5, 0.2, 0.3, -0.62, 0.5, 0, 0x7c8470),
              paint(new THREE.SphereGeometry(0.2, 8, 6).scale(1.3, 0.9, 1).translate(0.62, 0.62, 0), 0x9aa38c),
              box(0.22, 0.06, 0.2, 0.8, 0.52, 0, 0x2a1515),
              // ribs
              box(0.04, 0.05, 0.38, 0.1, 0.44, 0, 0x6c7461),
              box(0.04, 0.05, 0.38, -0.1, 0.44, 0, 0x6c7461),
              box(0.04, 0.05, 0.38, 0.3, 0.44, 0, 0x6c7461),
            ]),
          ),
          skin,
        ),
      );
      const limb = cached('crawler-limb', () => merge([box(0.08, 0.5, 0.08, 0, -0.25, 0, 0x838b76), box(0.16, 0.05, 0.1, 0.05, -0.5, 0, 0x5f6655)]));
      for (const [x, z] of [
        [0.35, -0.24],
        [0.35, 0.24],
        [-0.45, -0.22],
        [-0.45, 0.22],
      ]) {
        const g = new THREE.Group();
        g.position.set(x, 0.55, z);
        g.add(new THREE.Mesh(limb, skin));
        body.add(g);
        limbs.push(g);
      }
      eyes.push(eye(0xfff08a, 0.83, 0.68, -0.08, 0.1), eye(0xfff08a, 0.83, 0.68, 0.08, 0.1));
      body.add(...eyes);
      top = 1.1;
      break;
    }
    case MonsterKind.Brute: {
      // a hulking, hunched thing in a butcher's apron
      const flesh = new THREE.MeshLambertMaterial({ vertexColors: true });
      materials.push(flesh);
      // stained apron over grey, dead-looking skin
      const human = buildHuman({ shirt: 0x3a302c, pants: 0x191513, skin: 0x5d5752, hair: 0x0d0b0b, badge: 0x5a1414 });
      human.body.traverse((o) => {
        if (o instanceof THREE.Mesh) o.material = flesh;
      });
      human.body.scale.set(1.5, 1.3, 1.7);
      // hunched right over, head thrust forward, arms hanging past the knees
      human.body.rotation.z = -0.5;
      human.head.rotation.z = 0.45;
      human.armL.scale.y = human.armR.scale.y = 1.35;
      human.shadow.visible = false;
      human.label.visible = false;
      body.add(human.body);
      limbs.push(human.armL, human.armR, human.legL, human.legR);
      // on the face, in the head's own space, so they turn and stoop with it
      eyes.push(eye(0xff3a2a, 0.13, 0.16, -0.06, 0.09), eye(0xff3a2a, 0.13, 0.16, 0.06, 0.09));
      human.head.add(...eyes);
      top = 2.8;
      break;
    }
  }

  const label = nameTag(top + 0.3);
  root.add(label);
  const ring = new THREE.Mesh(RING_GEO, new THREE.MeshBasicMaterial({ color: 0xc58cff, transparent: true, opacity: 0.9, depthWrite: false, fog: false }));
  ring.position.y = 0.05;
  ring.visible = false;
  root.add(ring);
  const bar = new THREE.Group();
  bar.position.y = top + 0.1;
  const back = new THREE.Mesh(cached('bar-back', () => new THREE.PlaneGeometry(0.9, 0.1)), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false, fog: false }));
  const fill = new THREE.Mesh(cached('bar-fill', () => new THREE.PlaneGeometry(0.86, 0.06).translate(0.43, 0, 0)), new THREE.MeshBasicMaterial({ color: 0xb46bff, depthWrite: false, fog: false }));
  fill.position.set(-0.43, 0, 0.001);
  bar.add(back, fill);
  bar.visible = false;
  root.add(bar);
  const badge = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: MONSTER_COLORS[kind], blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, fog: false }));
  badge.position.y = top + 0.5;
  badge.renderOrder = 20;
  badge.visible = false;
  root.add(badge);
  return { root, body, eyes, materials, limbs, label, ring, bar, barFill: fill, badge, shadow };
}

export function disposeMonster(m: MonsterModel): void {
  m.root.removeFromParent();
  for (const mat of m.materials) mat.dispose();
  (m.ring.material as THREE.Material).dispose();
  (m.barFill.material as THREE.Material).dispose();
  m.badge.material.dispose();
  m.label.material.map?.dispose();
  m.label.material.dispose();
}

// ---------------------------------------------------------------------------
// Keys, the presence, and beams
// ---------------------------------------------------------------------------

/** An old iron key with a bow you could put a finger through, lying along +X. */
export function keyGeometry(): THREE.BufferGeometry {
  return cached('key', () =>
    merge([
      paint(new THREE.TorusGeometry(0.06, 0.018, 6, 14).rotateY(Math.PI / 2).translate(-0.12, 0, 0), 0xe0b64a),
      box(0.22, 0.03, 0.03, 0.03, 0, 0, 0xd2a63c),
      box(0.03, 0.06, 0.02, 0.1, -0.04, 0, 0xd2a63c),
      box(0.03, 0.04, 0.02, 0.05, -0.03, 0, 0xd2a63c),
    ]),
  );
}

export function keyModel(): { root: THREE.Group; spin: THREE.Group; glow: THREE.Sprite } {
  const root = new THREE.Group();
  const spin = new THREE.Group();
  spin.add(new THREE.Mesh(keyGeometry(), SOLID));
  spin.scale.setScalar(1.6);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffc94a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
  glow.scale.setScalar(0.9);
  root.add(spin, glow);
  return { root, spin, glow };
}

/** The Haunt as survivors feel it: a knot of darkness with two dim eyes, only ever half there. */
export function presenceModel(): { root: THREE.Group; mist: THREE.Sprite[]; eyes: THREE.Sprite[] } {
  const root = new THREE.Group();
  const mistMat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0x05030a, transparent: true, opacity: 0.8, depthWrite: false });
  const mist: THREE.Sprite[] = [];
  for (let i = 0; i < 6; i++) {
    const s = new THREE.Sprite(mistMat);
    s.position.set((Math.random() - 0.5) * 0.6, 1.1 + i * 0.18, (Math.random() - 0.5) * 0.6);
    s.scale.setScalar(1.3 - i * 0.08);
    mist.push(s);
    root.add(s);
  }
  const eyeMat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0x9fb4ff, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.8, depthWrite: false, fog: false });
  const eyes = [new THREE.Sprite(eyeMat), new THREE.Sprite(eyeMat)];
  eyes[0].position.set(0, 1.75, -0.11);
  eyes[1].position.set(0, 1.75, 0.11);
  for (const e of eyes) {
    e.scale.setScalar(0.1);
    root.add(e);
  }
  return { root, mist, eyes };
}

/** A beam of light from a flashlight: a cone from its tip, along -Z, `length` long. */
export function beamGeometry(length: number, halfAngle: number): THREE.BufferGeometry {
  return cached(`beam:${length}:${halfAngle}`, () => {
    const r = Math.tan(halfAngle) * length;
    const g = new THREE.ConeGeometry(r, length, 20, 1, true).rotateX(Math.PI / 2).translate(0, 0, -length / 2);
    // bright at the lens, gone by the far end
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.max(0, 1 + pos.getZ(i) / length) ** 1.6;
      colors[i * 3] = 1 * k;
      colors[i * 3 + 1] = 0.94 * k;
      colors[i * 3 + 2] = 0.78 * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  });
}

/** A flat ring on the ground: the Haunt's cursor, order pings and the like. */
export function groundRing(inner: number, outer: number, color: number): THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> {
  const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, fog: false, side: THREE.DoubleSide }));
  m.renderOrder = 5;
  return m;
}
