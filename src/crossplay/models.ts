import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assetGeometry } from './assets';
import { labelTexture, radialTexture } from './textures';
import type { Tool } from './tool';

/**
 * Low-poly procedural models. Parts are vertex-coloured boxes merged into a few meshes, so every model costs
 * a handful of draw calls and shares one material. Models face +X (a heading of 0) with +Z on their right.
 */

export function paint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

export function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color);
}

/** Merge painted parts into one geometry, disposing of the parts. Mixing indexed and non-indexed parts is fine. */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const same = parts.every((p) => !!p.index === !!parts[0].index);
  const input = same ? parts : parts.map((p) => (p.index ? p.toNonIndexed() : p));
  for (const g of input) if (g.getAttribute('uv')) g.deleteAttribute('uv');
  const g = mergeGeometries(input, false);
  for (const p of new Set([...parts, ...input])) p.dispose();
  if (!g) throw new Error('geometry merge failed');
  g.computeBoundingSphere();
  return g;
}

const cache = new Map<string, THREE.BufferGeometry>();
/** A geometry made once per key and shared. */
export function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = cache.get(key);
  if (!g) cache.set(key, (g = make()));
  return g;
}

/** The shared vertex-colour material every procedural and asset model draws with. */
export const SOLID = new THREE.MeshLambertMaterial({ vertexColors: true });

let glowTex: THREE.Texture | null = null;
export function glowTexture(): THREE.Texture {
  return (glowTex ??= radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.35, 'rgba(255,255,255,0.4)'],
    [1, 'rgba(255,255,255,0)'],
  ]));
}

let shadowMat: THREE.MeshBasicMaterial | null = null;
const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

export function blobShadow(sx: number, sz: number): THREE.Mesh {
  shadowMat ??= new THREE.MeshBasicMaterial({
    map: radialTexture([
      [0, 'rgba(0,0,0,0.5)'],
      [0.55, 'rgba(0,0,0,0.3)'],
      [1, 'rgba(0,0,0,0)'],
    ]),
    transparent: true,
    depthWrite: false,
  });
  const m = new THREE.Mesh(shadowGeo, shadowMat);
  m.scale.set(sx, 1, sz);
  m.position.y = 0.04;
  m.renderOrder = 1;
  return m;
}

export function setLabel(sprite: THREE.Sprite, text: string): void {
  const mat = sprite.material;
  mat.map?.dispose();
  mat.map = labelTexture(text);
  mat.needsUpdate = true;
}

export function disposeLabel(sprite: THREE.Sprite): void {
  sprite.material.map?.dispose();
  sprite.material.dispose();
}

/** A name tag sprite, hidden until given a label. */
export function nameTag(height: number): THREE.Sprite {
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
  label.scale.set(1.6, 0.4, 1);
  label.position.y = height;
  label.visible = false;
  return label;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const EMPTY = new THREE.BufferGeometry();
const toolGeometries = new WeakMap<Tool<any>, THREE.BufferGeometry>();
const gripQuaternions = new WeakMap<Tool<any>, THREE.Quaternion>();

/** How a tool is turned in the hand, from its grip angles. Shared: don't change it. */
export function gripQuaternion(tool: Tool<any>): THREE.Quaternion {
  let q = gripQuaternions.get(tool);
  if (!q) {
    const { pitch, yaw, roll } = tool.grip;
    q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    gripQuaternions.set(tool, q);
  }
  return q;
}

/** Where a tool's tip is in the hand's space: the grip is the origin and the hand points down -Z. */
export function toolTip(tool: Tool<any>, out = new THREE.Vector3()): THREE.Vector3 {
  const [x, y, z] = tool.grip.tip;
  return out.set(x, y, z).applyQuaternion(gripQuaternion(tool));
}

/** Which way a tool points in the hand's space, as a unit vector. */
export function toolForward(tool: Tool<any>, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(0, 0, -1).applyQuaternion(gripQuaternion(tool));
}

/** A tool's model fitted to its grip, shared by everything showing the kind. Its space is the tool's own: the grip at the origin, the tip at `grip.tip`. */
export function toolGeometry(tool: Tool<any>): THREE.BufferGeometry {
  let g = toolGeometries.get(tool);
  if (!g) {
    const { asset, build } = tool.model;
    if (asset) {
      g = fitTool(assetGeometry(asset), tool);
    } else {
      const src = build!();
      g = fitTool(src, tool);
      src.dispose();
    }
    toolGeometries.set(tool, g);
  }
  return g;
}

/**
 * A tool as it's held. The group is the hand: its origin is the grip and it points down -Z, so place and
 * aim the group. The model inside it (`toolMesh`) is turned by the tool's grip angles. Null leaves it empty.
 */
export function buildTool(tool: Tool<any> | null): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(EMPTY, SOLID));
  setToolModel(group, tool);
  return group;
}

/** The model in a group made by buildTool. Its space is the tool's own: the grip at the origin, the tip at `grip.tip`. */
export function toolMesh(group: THREE.Group): THREE.Mesh {
  return group.children[0] as THREE.Mesh;
}

/** Swap the tool in a group made by buildTool (anything added to the group after it stays). */
export function setToolModel(group: THREE.Group, tool: Tool<any> | null): void {
  const mesh = toolMesh(group);
  mesh.visible = !!tool;
  mesh.geometry = tool ? toolGeometry(tool) : EMPTY;
  if (tool) mesh.quaternion.copy(gripQuaternion(tool));
  else mesh.quaternion.identity();
}

/**
 * Fits a model to a tool: turned by `model.orient`, `model.length` meters long,
 * and the middle of its front face on `grip.tip`, so the grip lands on the origin.
 */
function fitTool(src: THREE.BufferGeometry, tool: Tool<any>): THREE.BufferGeometry {
  const { orient, length } = tool.model;
  const [tx, ty, tz] = tool.grip.tip;
  const g = src.clone();
  if (orient) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(orient[0], orient[1], orient[2])));
  g.computeBoundingBox();
  const k = length / (g.boundingBox!.max.z - g.boundingBox!.min.z);
  g.scale(k, k, k);
  g.computeBoundingBox();
  const { min, max } = g.boundingBox!;
  const pos = g.getAttribute('position');
  let y = 0;
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getZ(i) > min.z + 0.004) continue;
    y += pos.getY(i);
    n++;
  }
  g.translate(tx - (min.x + max.x) / 2, ty - y / n, tz - min.z);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** A tool lying on the ground to pick up: it spins about its middle in a glow of its colour. Spin and bob `spin`. */
export function buildToolPickup(tool: Tool<any>): { root: THREE.Group; spin: THREE.Group } {
  const geo = toolGeometry(tool);
  const root = new THREE.Group();
  const spin = new THREE.Group();
  spin.position.y = 0.6;
  const mesh = new THREE.Mesh(geo, SOLID);
  geo.boundingBox!.getCenter(mesh.position).negate(); // held at the grip; spin about the middle
  spin.add(mesh);
  root.add(spin, pickupGlow(tool.color));
  return { root, spin };
}

export function pickupGlow(color: number): THREE.Sprite {
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
  );
  glow.scale.set(1.4, 1.4, 1);
  glow.position.y = 0.6;
  return glow;
}

// ---------------------------------------------------------------------------
// Humans
// ---------------------------------------------------------------------------

export const HUMAN = { hip: 0.9, shoulder: 1.52, shoulderZ: 0.31, neck: 1.58, height: 1.86 };

export interface HumanLook {
  shirt: number;
  pants: number;
  skin: number;
  hair: number;
  /** A peaked cap instead of hair. */
  hat?: number;
  /** A badge on the chest. */
  badge?: number;
}

export interface HumanRig {
  root: THREE.Group;
  /** Yaw and falling over happen here; `root` stays upright at the feet. */
  body: THREE.Group;
  head: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  /** Tools in the right and left hands, made by buildTool. */
  tool: THREE.Group;
  toolL: THREE.Group;
  shadow: THREE.Mesh;
  label: THREE.Sprite;
}

export function buildHuman(look: HumanLook): HumanRig {
  const key = `${look.shirt}:${look.pants}:${look.skin}:${look.hair}:${look.hat}:${look.badge}`;
  const torso = cached(`torso:${key}`, () =>
    merge([
      box(0.24, 0.22, 0.42, 0, 0.99, 0, look.pants),
      box(0.26, 0.56, 0.48, 0, 1.3, 0, look.shirt),
      ...(look.badge !== undefined ? [box(0.02, 0.07, 0.08, 0.135, 1.43, -0.13, look.badge)] : []),
    ]),
  );
  const head = cached(`head:${key}`, () =>
    merge([
      box(0.24, 0.26, 0.24, 0, 0.13, 0, look.skin),
      box(0.02, 0.05, 0.17, 0.125, 0.16, 0, 0x1e1e1e),
      ...(look.hat !== undefined
        ? [box(0.28, 0.07, 0.28, 0, 0.28, 0, look.hat), box(0.1, 0.02, 0.26, 0.16, 0.25, 0, look.hat)]
        : [box(0.26, 0.07, 0.26, -0.01, 0.27, 0, look.hair)]),
    ]),
  );
  const arm = cached(`arm:${key}`, () => merge([box(0.12, 0.6, 0.12, 0, -0.3, 0, look.shirt), box(0.11, 0.1, 0.11, 0, -0.65, 0, look.skin)]));
  const leg = cached(`leg:${key}`, () => merge([box(0.18, 0.78, 0.18, 0, -0.39, 0, look.pants), box(0.26, 0.08, 0.18, 0.04, -0.84, 0, 0x202020)]));

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  body.add(new THREE.Mesh(torso, SOLID));
  const pivot = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
    const p = new THREE.Group();
    p.position.set(x, y, z);
    p.add(new THREE.Mesh(geo, SOLID));
    body.add(p);
    return p;
  };
  const headGroup = pivot(head, 0, HUMAN.neck, 0);
  const legL = pivot(leg, 0, HUMAN.hip, -0.12);
  const legR = pivot(leg, 0, HUMAN.hip, 0.12);
  const armL = pivot(arm, 0, HUMAN.shoulder, -HUMAN.shoulderZ);
  const armR = pivot(arm, 0, HUMAN.shoulder, HUMAN.shoulderZ);

  const tool = buildTool(null);
  const toolL = buildTool(null);
  for (const g of [tool, toolL]) {
    g.rotation.order = 'YXZ';
    g.visible = false;
    root.add(g);
  }
  const shadow = blobShadow(0.9, 0.9);
  root.add(shadow);
  const label = nameTag(2.2);
  root.add(label);
  return { root, body, head: headGroup, legL, legR, armL, armR, tool, toolL, shadow, label };
}
