import * as THREE from 'three';

/** A flat canvas in the scene, for HUDs a headset can see. Draw on `ctx`, then set `tex.needsUpdate`. */
export interface Panel {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  w: number;
  h: number;
}

/**
 * A `width` × `height` meter panel with a `w` × `h` pixel canvas. An `overlay` draws over everything (for
 * head-locked text); otherwise it's hidden by what's in front of it, like a watch face. Starts hidden.
 */
export function panel(width: number, height: number, w: number, h: number, overlay: boolean): Panel {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: !overlay, fog: false }),
  );
  mesh.renderOrder = overlay ? 999 : 10;
  mesh.visible = false;
  return { mesh, ctx: canvas.getContext('2d')!, tex, w, h };
}

export function disposePanel({ mesh, tex }: Panel): void {
  mesh.removeFromParent();
  mesh.geometry.dispose();
  mesh.material.dispose();
  tex.dispose();
}
