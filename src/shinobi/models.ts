import * as THREE from 'three';
import { SOLID, box, buildHuman, cached, glowTexture, merge, paint, type HumanRig } from '../crossplay/models';
import { radialTexture } from '../crossplay/textures';
import { GuardKind } from './defs';

/**
 * Peer Shinobi's models, low-poly and vertex-coloured like the rest (see crossplay/models.ts). Scene axes: models face +X
 * with +Z on their right, and y is up.
 */

// ---------------------------------------------------------------------------
// Shinobi
// ---------------------------------------------------------------------------

/** Each shinobi's scarf and sash, so they can tell each other apart in the dark. */
const SCARVES = [0x8a2a2a, 0x2a5a8a, 0x5a7a2a, 0x8a6a2a, 0x5a2a7a, 0x2a7a6a, 0x7a2a5a, 0x6a6a6a];
const SKINS = [0xf1c9a5, 0xd9a47a, 0xa8714d, 0x7a4e32, 0xe8b894];

export function shinobiColor(skin: number): number {
  return SCARVES[skin % SCARVES.length];
}

export function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function shinobiModel(skin: number): HumanRig {
  const scarf = shinobiColor(skin);
  const rig = buildHuman({ shirt: 0x1c1d24, pants: 0x17181e, skin: 0x1f2027, hair: 0x15161b, badge: scarf });
  // a strip of face showing between hood and mask, and a headband's tails
  rig.head.add(new THREE.Mesh(cached(`shinobi-face:${skin}`, () => merge([box(0.012, 0.05, 0.18, 0.123, 0.16, 0, SKINS[(skin * 3) % SKINS.length]), box(0.014, 0.022, 0.05, 0.127, 0.165, -0.05, 0x101010), box(0.014, 0.022, 0.05, 0.127, 0.165, 0.05, 0x101010), box(0.26, 0.04, 0.26, 0, 0.23, 0, scarf), box(0.2, 0.03, 0.04, -0.2, 0.2, 0.05, scarf).rotateZ(-0.3)])), SOLID));
  // a sash round the waist
  rig.body.add(new THREE.Mesh(cached(`shinobi-sash:${skin}`, () => box(0.27, 0.07, 0.49, 0, 1.08, 0, scarf)), SOLID));
  return rig;
}

/** Down, propped on an arm. Put `rig.root` at the feet first. */
export function poseDowned(rig: HumanRig, heading: number, t: number): void {
  rig.body.rotation.set(0, -heading, -Math.PI / 2 + 0.3, 'YXZ');
  rig.body.position.y = 0.32;
  const crawl = Math.sin(t * 3) * 0.2;
  rig.armR.rotation.set(0, 0, Math.PI - 0.5 + crawl);
  rig.armL.rotation.set(0, 0, Math.PI - 0.8 - crawl);
  rig.legL.rotation.set(0, 0, 0.15);
  rig.legR.rotation.set(0, 0, -0.1);
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

/** Clinging to a wall: arms up, knees bent. */
export function poseClimbing(rig: HumanRig, t: number): void {
  const reach = Math.sin(t * 6) * 0.35;
  rig.armR.rotation.set(0, 0, Math.PI - 0.3 + reach);
  rig.armL.rotation.set(0, 0, Math.PI - 0.3 - reach);
  rig.legL.rotation.set(0, 0, 0.5 - reach * 0.5);
  rig.legR.rotation.set(0, 0, 0.5 + reach * 0.5);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export interface GuardModel extends HumanRig {
  kind: GuardKind;
  /** A spear or bow, in the body's space. */
  weapon: THREE.Group;
  /** A paper lantern held out on a pole, with its glow. */
  lantern: THREE.Group;
  lanternGlow: THREE.Sprite;
}

const COLORS: Record<GuardKind, { shirt: number; pants: number; hat: number }> = {
  [GuardKind.Spear]: { shirt: 0x2f3b52, pants: 0x23262e, hat: 0x2a2520 },
  [GuardKind.Archer]: { shirt: 0x3d4a33, pants: 0x262a22, hat: 0x2a2520 },
  [GuardKind.Samurai]: { shirt: 0x6a1e1e, pants: 0x241615, hat: 0x1d1a1a },
  [GuardKind.Lord]: { shirt: 0x46306a, pants: 0x2c1f45, hat: 0x0e0e10 },
};

export function guardModel(kind: GuardKind): GuardModel {
  const c = COLORS[kind];
  const rig = buildHuman({ shirt: c.shirt, pants: c.pants, skin: 0xe0b48c, hair: 0x151515 });
  const hat = cached(`guard-hat:${kind}`, () => {
    switch (kind) {
      case GuardKind.Spear:
      case GuardKind.Archer:
        // a jingasa: a wide, shallow, lacquered cone
        return paint(new THREE.ConeGeometry(0.34, 0.14, 12).translate(0, 0.33, 0), c.hat);
      case GuardKind.Samurai:
        // a helmet with a neck guard and a gold crest
        return merge([box(0.3, 0.14, 0.3, 0, 0.3, 0, c.hat), box(0.12, 0.1, 0.4, -0.12, 0.2, 0, c.hat), paint(new THREE.ConeGeometry(0.03, 0.2, 4).rotateZ(-0.4).translate(0.08, 0.45, 0), 0xd6b04a)]);
      case GuardKind.Lord:
        // a tall black eboshi
        return merge([box(0.18, 0.34, 0.16, -0.02, 0.44, 0, c.hat), box(0.26, 0.05, 0.26, 0, 0.29, 0, c.hat)]);
    }
  });
  rig.head.add(new THREE.Mesh(hat, SOLID));
  if (kind === GuardKind.Samurai) rig.body.add(new THREE.Mesh(cached('samurai-armour', () => merge([box(0.3, 0.12, 0.62, 0, 1.45, 0, 0x4a1414), box(0.28, 0.3, 0.52, 0, 1.12, 0, 0x551818), box(0.02, 0.4, 0.04, -0.2, 1.1, -0.28, 0x111111)])), SOLID));
  if (kind === GuardKind.Lord) rig.body.add(new THREE.Mesh(cached('lord-robe', () => merge([paint(new THREE.CylinderGeometry(0.32, 0.42, 0.9, 10).translate(0, 0.55, 0), COLORS[GuardKind.Lord].pants), box(0.3, 0.08, 0.5, 0, 1.1, 0, 0xc9a64a)])), SOLID));

  const weapon = new THREE.Group();
  if (kind === GuardKind.Spear) {
    weapon.add(new THREE.Mesh(cached('yari', () => merge([paint(new THREE.CylinderGeometry(0.02, 0.025, 2.5, 5).translate(0, 1.25, 0), 0x4a3524), paint(new THREE.ConeGeometry(0.035, 0.3, 4).translate(0, 2.65, 0), 0xc9ced8)])), SOLID));
    weapon.position.set(0.12, 0.05, 0.42);
  } else if (kind === GuardKind.Archer) {
    weapon.add(new THREE.Mesh(cached('yumi', () => merge([paint(new THREE.TorusGeometry(0.9, 0.018, 4, 16, Math.PI * 0.75).rotateZ(Math.PI / 2 - Math.PI * 0.375), 0x3a2a1c), box(0.005, 1.6, 0.005, -0.45, 0, 0, 0xd8d0c0)])), SOLID));
    weapon.position.set(0.3, 1.2, -0.38);
  } else if (kind === GuardKind.Samurai) {
    weapon.add(new THREE.Mesh(cached('katana', () => merge([box(0.03, 0.25, 0.03, 0, 0.12, 0, 0x151515), box(0.012, 0.8, 0.035, 0, 0.66, 0, 0xc9ced8)])), SOLID));
    weapon.position.set(0.1, 0.95, -0.3);
    weapon.rotation.z = -1.9;
  }
  rig.body.add(weapon);

  const lantern = new THREE.Group();
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffb35a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.85 }));
  glow.scale.setScalar(0.9);
  lantern.add(new THREE.Mesh(cached('chochin', () => merge([paint(new THREE.CylinderGeometry(0.11, 0.11, 0.3, 8).translate(0, -0.2, 0), 0xf2d7a0), box(0.24, 0.03, 0.24, 0, -0.04, 0, 0x151515), box(0.24, 0.03, 0.24, 0, -0.36, 0, 0x151515), box(0.015, 0.5, 0.015, -0.2, 0.15, 0, 0x4a3524).rotateZ(0.5)])), new THREE.MeshBasicMaterial({ vertexColors: true })));
  glow.position.y = -0.2;
  lantern.add(glow);
  lantern.position.set(0.45, 1.25, -0.35);
  lantern.visible = false;
  rig.body.add(lantern);
  return { ...rig, kind, weapon, lantern, lanternGlow: glow };
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

const iconMaterials = new Map<string, THREE.SpriteMaterial>();

/** A `?` or `!` over a guard's head, or a diamond over the lord's. Materials are shared: set opacity on a clone. */
export function iconMaterial(text: '?' | '!' | '◆' | '✕', color: string): THREE.SpriteMaterial {
  const key = `${text}${color}`;
  let m = iconMaterials.get(key);
  if (!m) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.font = 'bold 104px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, 64, 70);
    ctx.fillStyle = color;
    ctx.fillText(text, 64, 70);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    iconMaterials.set(key, (m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false })));
  }
  return m;
}

/** A flat fan on the ground: what a guard can see, on the captain's map. Faces +X. */
export function fanGeometry(radius: number, halfAngle: number): THREE.BufferGeometry {
  return cached(`fan:${radius}:${halfAngle}`, () => {
    const g = new THREE.CircleGeometry(radius, 18, -halfAngle, halfAngle * 2).rotateX(-Math.PI / 2);
    // bright at the guard, fading out
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const k = 1 - Math.hypot(pos.getX(i), pos.getZ(i)) / radius;
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 0.25 + 0.75 * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g;
  });
}

/** A flat ring on the ground: selections, the captain's cursor, pings. */
export function groundRing(inner: number, outer: number, color: number): THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> {
  const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, fog: false, side: THREE.DoubleSide }));
  m.renderOrder = 5;
  return m;
}

let poolTex: THREE.Texture | null = null;
/** Warm light pooled on the ground round a lantern or brazier, so you can see where it's bright. */
export function lightPool(radius: number, color = 0xffa850, opacity = 0.3): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  poolTex ??= radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.45, 'rgba(255,255,255,0.55)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  const m = new THREE.Mesh(
    cached('pool', () => new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2)) as THREE.PlaneGeometry,
    new THREE.MeshBasicMaterial({ map: poolTex, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  m.scale.setScalar(radius);
  m.renderOrder = 2;
  return m;
}

/** A text label on a sprite, for the captain's pings. */
export function textSprite(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 80;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 40px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, 256, 42, 500);
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 42, 500);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false }));
  s.scale.set(6.4, 1, 1);
  s.renderOrder = 30;
  return s;
}

export function disposeSprite(s: THREE.Sprite): void {
  s.material.map?.dispose();
  s.material.dispose();
}

/** An iron brazier on legs, its fire drawn by the views. */
export function brazierGeometry(): THREE.BufferGeometry {
  return cached('brazier', () => {
    const parts: THREE.BufferGeometry[] = [paint(new THREE.CylinderGeometry(0.4, 0.22, 0.3, 10).translate(0, 1.05, 0), 0x2a2724)];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      parts.push(paint(new THREE.CylinderGeometry(0.03, 0.03, 1, 4).rotateZ(0.2).rotateY(a).translate(Math.cos(a) * 0.22, 0.5, Math.sin(a) * 0.22), 0x1d1b19));
    }
    parts.push(paint(new THREE.CylinderGeometry(0.34, 0.34, 0.05, 10).translate(0, 1.18, 0), 0xff7a2a));
    return merge(parts);
  });
}
