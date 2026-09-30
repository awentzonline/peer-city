import * as THREE from 'three';
import { SOLID, box, buildHuman, cached, merge, paint, type HumanRig } from '../crossplay/models';
import { BuddyKind } from './defs';

/** Team kits: jersey and shorts, picked by a pal's `skin`. */
const JERSEYS = [0xd62839, 0x1d4ed8, 0x059669, 0xf59e0b, 0x7c3aed, 0xdb2777, 0x0891b2, 0xea580c, 0x334155, 0x65a30d];
const SHORTS = [0xf8fafc, 0x1e293b, 0x374151, 0x1e3a8a];
const SKINS = [0xf5d0a9, 0xe0ac69, 0xc68642, 0x8d5524, 0x5c3a1e];
const HAIR = [0x2c1b0e, 0x6b4423, 0xd4a017, 0x1a1a1a, 0xa52a2a, 0xbbbbbb];

export function skinTone(skin: number): number {
  return SKINS[(skin * 7) % SKINS.length];
}

/** A pal: a team jersey and shorts, a sweatband cap on every fourth. */
export function palRig(skin: number): HumanRig {
  return buildHuman({
    shirt: JERSEYS[skin % JERSEYS.length],
    pants: SHORTS[(skin * 5) % SHORTS.length],
    skin: skinTone(skin),
    hair: HAIR[(skin * 3) % HAIR.length],
    hat: skin % 4 === 0 ? JERSEYS[(skin + 3) % JERSEYS.length] : undefined,
  });
}

export const BUDDY_SKIN: Record<BuddyKind, number> = {
  [BuddyKind.Coach]: 0xe0ac69,
  [BuddyKind.Lineman]: 0x8d5524,
  [BuddyKind.Mascot]: 0xffc61a,
};

/** A buddy: the coach in a polo and cap with a whistle, the lineman in pads, Buzz in his bee suit. */
export function buddyRig(kind: BuddyKind): HumanRig {
  switch (kind) {
    case BuddyKind.Coach: {
      const r = buildHuman({ shirt: 0x1e3a8a, pants: 0xc8b48a, skin: BUDDY_SKIN[kind], hair: 0x9a9a9a, hat: 0x1e3a8a, badge: 0xd4d4d8 });
      return r;
    }
    case BuddyKind.Lineman: {
      const r = buildHuman({ shirt: 0xd62839, pants: 0xf8fafc, skin: BUDDY_SKIN[kind], hair: 0x1a1a1a });
      r.body.add(
        new THREE.Mesh(
          cached('pads', () => merge([box(0.34, 0.14, 0.7, 0, 1.52, 0, 0xd62839), box(0.02, 0.18, 0.2, -0.17, 1.28, 0, 0xffffff)])),
          SOLID,
        ),
      );
      r.root.scale.setScalar(1.1);
      return r;
    }
    case BuddyKind.Mascot: {
      const r = buildHuman({ shirt: 0xffc61a, pants: 0x1a1a1a, skin: BUDDY_SKIN[kind], hair: 0x1a1a1a });
      r.body.add(
        new THREE.Mesh(
          cached('stripes', () => merge([box(0.27, 0.07, 0.49, 0, 1.18, 0, 0x1a1a1a), box(0.27, 0.07, 0.49, 0, 1.34, 0, 0x1a1a1a), box(0.02, 0.3, 0.46, -0.14, 1.3, 0, 0xe0f2fe)])),
          SOLID,
        ),
      );
      r.head.add(
        new THREE.Mesh(
          cached('antennae', () =>
            merge([
              box(0.015, 0.18, 0.015, 0.02, 0.38, -0.07, 0x1a1a1a),
              box(0.015, 0.18, 0.015, 0.02, 0.38, 0.07, 0x1a1a1a),
              box(0.05, 0.05, 0.05, 0.02, 0.48, -0.07, 0xffc61a),
              box(0.05, 0.05, 0.05, 0.02, 0.48, 0.07, 0xffc61a),
              box(0.03, 0.08, 0.2, 0.13, 0.16, 0, 0x1a1a1a),
            ]),
          ),
          SOLID,
        ),
      );
      return r;
    }
  }
}

/**
 * An open hand, big enough to see across a field: fingers up (+Y), palm facing forward (-Z), its middle at the
 * origin. Shared per skin tone.
 */
export function palmGeometry(skin: number): THREE.BufferGeometry {
  return cached(`palm:${skin}`, () => {
    const parts = [box(0.1, 0.1, 0.03, 0, 0, 0, skin)];
    for (let i = 0; i < 4; i++) parts.push(box(0.021, 0.085 - Math.abs(i - 1.5) * 0.012, 0.026, -0.036 + i * 0.024, 0.09 - Math.abs(i - 1.5) * 0.006, 0, skin));
    parts.push(box(0.022, 0.06, 0.026, -0.062, 0.015, -0.004, skin).rotateZ(0.5));
    return merge(parts);
  });
}

/** A fist, knuckles forward (-Z). */
export function fistGeometry(skin: number): THREE.BufferGeometry {
  return cached(`fist:${skin}`, () => merge([box(0.1, 0.085, 0.09, 0, 0, 0, skin), box(0.1, 0.02, 0.02, 0, 0.03, -0.05, skin), box(0.02, 0.04, 0.05, -0.055, -0.01, -0.02, skin)]));
}

/** A red handprint for the seat of someone's shorts. Faces +X (the model's front), so turn it round for the back. */
export function handprintGeometry(): THREE.BufferGeometry {
  return cached('handprint', () => {
    const red = 0xff2d55;
    const parts = [box(0.005, 0.09, 0.09, 0, 0, 0, red)];
    for (let i = 0; i < 4; i++) parts.push(box(0.005, 0.07, 0.018, 0, 0.08, -0.033 + i * 0.022, red));
    parts.push(paint(new THREE.BoxGeometry(0.005, 0.05, 0.018).rotateX(-0.7).translate(0, 0.02, 0.06), red));
    return merge(parts);
  });
}
