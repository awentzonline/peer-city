import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import rifleUrl from '../../assets/models/weapons/AssaultRifle_01.glb?url';
import pistolUrl from '../../assets/models/weapons/Pistol_01.glb?url';
import shotgunUrl from '../../assets/models/weapons/Shotgun_03.glb?url';
import sniperUrl from '../../assets/models/weapons/SniperRifle_01.glb?url';
import smgUrl from '../../assets/models/weapons/SubmachineGun_02.glb?url';

/**
 * Model assets, converted to GLB by scripts/assets/convert.py. Everything is
 * loaded up front so scene code can build models synchronously. Each model's
 * flat-coloured materials are baked into vertex colours on one merged
 * geometry, so an asset renders with the shared vertex-colour material like
 * the procedural models do.
 */
const SOURCES = {
  pistol: pistolUrl,
  smg: smgUrl,
  shotgun: shotgunUrl,
  rifle: rifleUrl,
  sniper: sniperUrl,
};

export type AssetName = keyof typeof SOURCES;

const geometries = new Map<AssetName, THREE.BufferGeometry>();
let loading: Promise<void> | null = null;

export function loadAssets(): Promise<void> {
  const loader = new GLTFLoader();
  return (loading ??= Promise.all(
    (Object.keys(SOURCES) as AssetName[]).map(async (name) => {
      const gltf = await loader.loadAsync(SOURCES[name]);
      geometries.set(name, bake(gltf.scene));
    }),
  ).then(() => undefined));
}

/** The baked geometry of a loaded asset, in the model's own units and axes. Shared: clone before changing it. */
export function assetGeometry(name: AssetName): THREE.BufferGeometry {
  const g = geometries.get(name);
  if (!g) throw new Error(`asset "${name}" used before loadAssets() finished`);
  return g;
}

function bake(root: THREE.Object3D): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.getAttribute('position'));
    g.setAttribute('normal', src.getAttribute('normal'));
    g.applyMatrix4(mesh.matrixWorld);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = src.groups.length ? src.groups : [{ start: 0, count: Infinity, materialIndex: 0 }];
    const colors = new Float32Array(g.getAttribute('position').count * 3);
    for (const group of groups) {
      const color = (mats[group.materialIndex ?? 0] as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1);
      const end = Math.min(group.start + group.count, colors.length / 3);
      for (let i = group.start; i < end; i++) color.toArray(colors, i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(g);
    src.dispose();
  });
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('asset has no meshes');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}
