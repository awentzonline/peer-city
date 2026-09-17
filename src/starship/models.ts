import * as THREE from 'three';
import { mulberry32 } from '@engine/index';
import { SOLID, box, buildHuman, cached, glowTexture, merge, paint, type HumanRig } from '../crossplay/models';
import { RaiderKind, Station } from './defs';
import { Biome } from './sector';

/**
 * Peer Starship's models, built in code. Space models face +X with +Y up, in u; deck models are in meters. Glowing parts
 * use `GLOW`, which ignores the lights.
 */

export const GLOW = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });

export const STATION_COLORS: Record<Station, number> = {
  [Station.Helm]: 0x5ad0ff,
  [Station.Tactical]: 0xff6a5a,
  [Station.Science]: 0xb48aff,
  [Station.Engineering]: 0xffb84a,
  [Station.Viewer]: 0xe8ecf4,
  [Station.None]: 0x8a94a8,
};

export function css(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Space
// ---------------------------------------------------------------------------

const HULL = 0xd4dae2;
const HULL_DARK = 0x7a8492;
const STRIPE = 0x3a6fd8;
const ENGINE_GLOW = 0x7ad8ff;

/** The ship: a long arrowhead hull with a bridge on top, twin engine pods on pylons, about 44 u stem to stern. */
export function shipModel(): THREE.Group {
  const group = new THREE.Group();
  const hull = cached('ship-hull', () => {
    const bow = new THREE.ConeGeometry(6, 18, 4).rotateY(Math.PI / 4).rotateZ(-Math.PI / 2).scale(1, 0.55, 1).translate(19, 0, 0);
    return merge([
      paint(bow, HULL),
      box(22, 4.2, 12, 1, 0, 0, HULL),
      box(12, 3.4, 8, -15, 0, 0, HULL_DARK),
      box(20, 0.4, 1.2, 2, 2.2, 0, STRIPE),
      // the bridge, on top toward the bow
      box(7, 2, 5, 7, 3, 0, HULL),
      box(5, 1.2, 4, 7.5, 4.4, 0, HULL_DARK),
      // pylons out to the engine pods
      box(4, 1, 20, -9, -0.5, 0, HULL_DARK),
      // engine pods
      paint(new THREE.CylinderGeometry(2, 2.4, 22, 10).rotateZ(Math.PI / 2).translate(-9, -0.5, 10), HULL),
      paint(new THREE.CylinderGeometry(2, 2.4, 22, 10).rotateZ(Math.PI / 2).translate(-9, -0.5, -10), HULL),
      box(18, 0.5, 0.6, -9, 1.6, 10, STRIPE),
      box(18, 0.5, 0.6, -9, 1.6, -10, STRIPE),
    ]);
  });
  const glow = cached('ship-glow', () =>
    merge([
      paint(new THREE.CircleGeometry(2.2, 10).rotateY(-Math.PI / 2).translate(-20.1, -0.5, 10), ENGINE_GLOW),
      paint(new THREE.CircleGeometry(2.2, 10).rotateY(-Math.PI / 2).translate(-20.1, -0.5, -10), ENGINE_GLOW),
      paint(new THREE.CircleGeometry(2.4, 8).rotateY(-Math.PI / 2).translate(-21.1, 0, 0), 0x3aa0ff),
      box(0.4, 0.5, 3.6, 10.2, 4.5, 0, 0xfff2c0),
      box(1, 0.3, 0.3, 9, 0.6, 6.05, 0xff4040),
      box(1, 0.3, 0.3, 9, 0.6, -6.05, 0x40ff60),
    ]),
  );
  group.add(new THREE.Mesh(hull, SOLID), new THREE.Mesh(glow, GLOW));
  return group;
}

/** Raiders: a dark red dart with swept wings, or a cruiser, a heavy crescent with spines. */
export function raiderModel(kind: RaiderKind): THREE.Group {
  const group = new THREE.Group();
  if (kind === RaiderKind.Fighter) {
    const body = cached('raider-fighter', () =>
      merge([
        paint(new THREE.ConeGeometry(3, 16, 5).rotateZ(-Math.PI / 2).scale(1, 0.5, 1), 0x4a1c22),
        paint(new THREE.BoxGeometry(8, 0.6, 20).translate(-5, 0, 0), 0x2a1216).applyMatrix4(new THREE.Matrix4().makeShear(0, 0, 0, 0, 0.6, 0)),
        box(3, 2, 2, -4, 1, 0, 0x6a2a30),
      ]),
    );
    const glow = cached('raider-fighter-glow', () => merge([box(0.6, 1, 1.6, -8, 0, 0, 0xff5a2a), box(1.4, 0.3, 0.3, 4, 0.6, 0, 0xff2a2a)]));
    group.add(new THREE.Mesh(body, SOLID), new THREE.Mesh(glow, GLOW));
  } else {
    const body = cached('raider-cruiser', () => {
      const parts = [
        paint(new THREE.TorusGeometry(14, 3.5, 6, 14, Math.PI * 1.2).rotateX(Math.PI / 2).rotateY(Math.PI * 0.4).scale(1, 0.6, 1), 0x3a161c),
        box(26, 5, 7, -2, 0, 0, 0x4a1c22),
        paint(new THREE.ConeGeometry(4, 12, 5).rotateZ(-Math.PI / 2).scale(1, 0.6, 1).translate(16, 0, 0), 0x5a2228),
      ];
      for (let i = -2; i <= 2; i++) parts.push(paint(new THREE.ConeGeometry(0.8, 7, 4).translate(i * 5 - 2, 5, 0), 0x2a1216));
      return merge(parts);
    });
    const glow = cached('raider-cruiser-glow', () => merge([box(0.8, 2.4, 5, -15.2, 0, 0, 0xff5a2a), box(2, 0.6, 3, 10, 2.6, 0, 0xff2a2a)]));
    group.add(new THREE.Mesh(body, SOLID), new THREE.Mesh(glow, GLOW));
  }
  return group;
}

/** The starbase: a spindle through a great ring on spokes, with lit windows. About 220 u across. */
export function starbaseModel(): THREE.Group {
  const group = new THREE.Group();
  const body = merge([
    paint(new THREE.CylinderGeometry(14, 22, 150, 12), 0xa8b0bc),
    paint(new THREE.CylinderGeometry(26, 26, 22, 16), 0xc8d0da),
    paint(new THREE.TorusGeometry(100, 9, 8, 40).rotateX(Math.PI / 2), 0xbcc4ce),
    paint(new THREE.CylinderGeometry(6, 6, 190, 8).rotateZ(Math.PI / 2), 0x8a929e),
    paint(new THREE.CylinderGeometry(6, 6, 190, 8).rotateX(Math.PI / 2), 0x8a929e),
    paint(new THREE.SphereGeometry(18, 12, 8).translate(0, 84, 0), 0xc8d0da),
  ]);
  const lights = merge(
    Array.from({ length: 40 }, (_, i) => {
      const a = (i / 40) * Math.PI * 2;
      return box(2, 2.4, 2, Math.cos(a) * 109.5, 0, Math.sin(a) * 109.5, i % 5 ? 0xfff0b0 : 0x6ad0ff);
    }).concat([box(54, 2, 54, 0, 11.5, 0, 0x6ad0ff), paint(new THREE.SphereGeometry(4, 8, 6).translate(0, 104, 0), 0xff4a4a)]),
  );
  group.add(new THREE.Mesh(body, SOLID), new THREE.Mesh(lights, GLOW));
  return group;
}

const BIOME_COLORS: Record<Biome, { low: number; high: number; air: number; ground: number; sky: number }> = {
  [Biome.Desert]: { low: 0xa85a36, high: 0xe8b07a, air: 0xffa870, ground: 0x9a5a3a, sky: 0xd89a6a },
  [Biome.Ice]: { low: 0x8ab0d8, high: 0xf4f8ff, air: 0xa8d8ff, ground: 0xc8d8e8, sky: 0x9ab8d8 },
  [Biome.Jungle]: { low: 0x1f5a34, high: 0x6aa84a, air: 0x9aff9a, ground: 0x2e5a2a, sky: 0x6a9a7a },
  [Biome.Volcanic]: { low: 0x1a1618, high: 0xff5a1a, air: 0xff6a3a, ground: 0x2a2224, sky: 0x4a2a2a },
  [Biome.Barren]: { low: 0x5a5a60, high: 0xb8b8c0, air: 0xc8c8d8, ground: 0x6a6a70, sky: 0x1a1a24 },
};

export function biomeColors(biome: Biome): (typeof BIOME_COLORS)[Biome] {
  return BIOME_COLORS[biome];
}

/** A planet: a lumpy-coloured sphere in its biome's colours, and a thin glow of air round it. */
export function planetModel(radius: number, biome: Biome, seed: number): THREE.Group {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(radius, 48, 32);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const { low, high } = BIOME_COLORS[biome];
  const a = new THREE.Color(low);
  const b = new THREE.Color(high);
  const c = new THREE.Color();
  const rand = mulberry32(seed);
  const waves = Array.from({ length: 6 }, () => ({ x: rand() * 6 - 3, y: rand() * 6 - 3, z: rand() * 6 - 3, p: rand() * 6 }));
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / radius;
    const y = pos.getY(i) / radius;
    const z = pos.getZ(i) / radius;
    let n = 0;
    for (const w of waves) n += Math.sin(x * w.x * 2 + y * w.y * 2 + z * w.z * 2 + w.p);
    const t = THREE.MathUtils.clamp(0.5 + n * 0.14 + (biome === Biome.Ice ? Math.abs(y) * 0.5 : 0), 0, 1);
    c.copy(a).lerp(b, t).toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  group.add(new THREE.Mesh(geo, SOLID));
  const air = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: BIOME_COLORS[biome].air, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
  air.scale.setScalar(radius * 2.6);
  group.add(air);
  return group;
}

/** Stars at infinity: a sphere of points to keep centred on the camera. */
export function starfield(count = 3000, radius = 40000): THREE.Points {
  const rand = mulberry32(99);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    pos.set([Math.cos(t) * r * radius, u * radius, Math.sin(t) * r * radius], i * 3);
    c.setHSL(0.55 + rand() * 0.15, rand() * 0.4, 0.6 + rand() * 0.4).toArray(col, i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
  points.frustumCulled = false;
  points.renderOrder = -10;
  return points;
}

/** A soft glowing sprite, additive. */
export function glowSprite(color: number, size: number, opacity = 1): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  s.scale.setScalar(size);
  return s;
}

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

/** A crew member: coloured by what they tend to do. */
export function crewModel(skin: number): HumanRig {
  const shirts = [STATION_COLORS[Station.Helm], STATION_COLORS[Station.Tactical], STATION_COLORS[Station.Science], STATION_COLORS[Station.Engineering]];
  const skins = [0xf1c8a0, 0xd8a47a, 0xa8744a, 0x7a4a2a, 0xe8b890];
  const hair = [0x2a1a10, 0x5a3a20, 0xd8b060, 0x101010, 0x8a3a1a];
  const rig = buildHuman({ shirt: shirts[skin % 4], pants: 0x22262e, skin: skins[(skin * 3) % 5], hair: hair[(skin * 7) % 5], badge: 0xffd35a });
  // shoulders in the uniform's dark
  rig.body.add(new THREE.Mesh(cached('crew-yoke', () => box(0.27, 0.12, 0.49, 0, 1.52, 0, 0x22262e)), SOLID));
  return rig;
}

/** A sentinel drone: a dark ball with a ring round it and a red eye. The eye looks +X. */
export function sentinelModel(): { root: THREE.Group; eye: THREE.Mesh; ring: THREE.Mesh } {
  const root = new THREE.Group();
  const body = new THREE.Mesh(
    cached('sentinel', () => merge([paint(new THREE.IcosahedronGeometry(0.34, 1), 0x2a2e38), box(0.1, 0.5, 0.1, 0, -0.35, 0, 0x3a3e48)])),
    SOLID,
  );
  const ring = new THREE.Mesh(cached('sentinel-ring', () => paint(new THREE.TorusGeometry(0.52, 0.04, 6, 20).rotateX(Math.PI / 2), 0x6a7080)), SOLID);
  const eye = new THREE.Mesh(cached('sentinel-eye', () => paint(new THREE.SphereGeometry(0.1, 8, 6).translate(0.3, 0.02, 0), 0xff3a2a)), GLOW);
  root.add(body, ring, eye, glowSprite(0xff3a2a, 0.5, 0.6));
  (root.children[3] as THREE.Sprite).position.set(0.34, 0.02, 0);
  return { root, eye, ring };
}

/** The relic: a turning golden octahedron in a glow. */
export function relicModel(): { root: THREE.Group; gem: THREE.Mesh } {
  const root = new THREE.Group();
  const gem = new THREE.Mesh(
    cached('relic', () => merge([paint(new THREE.OctahedronGeometry(0.22, 0).scale(1, 1.5, 1), 0xffd35a), paint(new THREE.TorusGeometry(0.3, 0.02, 4, 16), 0xfff0b0)])),
    GLOW,
  );
  root.add(gem, glowSprite(0xffc84a, 1.4, 0.7));
  return { root, gem };
}

export function torpedoCasing(): THREE.BufferGeometry {
  return cached('torpedo-casing', () =>
    merge([
      paint(new THREE.CylinderGeometry(0.16, 0.16, 1.1, 10).rotateZ(Math.PI / 2), 0x5a6070),
      paint(new THREE.SphereGeometry(0.16, 10, 6).scale(1.6, 1, 1).translate(0.55, 0, 0), 0xc03a2a),
      box(0.3, 0.02, 0.4, -0.45, 0, 0, 0x3a3e48),
    ]),
  );
}

export function groundRing(inner: number, outer: number, color: number): THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> {
  const m = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  m.renderOrder = 3;
  return m;
}
