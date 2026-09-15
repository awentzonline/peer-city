import * as THREE from 'three';
import type { Hud, MinimapDot } from './hud';
import type { Rig } from './rig';

interface Panel {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  w: number;
  h: number;
}

function panel(width: number, height: number, w: number, h: number, overlay: boolean): Panel {
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

export interface MapView {
  x: number;
  y: number;
  heading: number;
  dots: MinimapDot[];
}

/**
 * The HUD inside a headset: a wristwatch panel on the left controller (cash,
 * wanted level, health, minimap) and a head-locked strip for banners, hints
 * and the kill feed.
 */
export class VrHud {
  private readonly wrist = panel(0.2, 0.2, 512, 512, false);
  private readonly info = panel(1.2, 0.6, 1024, 512, true);
  private readonly map = document.createElement('canvas');
  private readonly mapCtx: CanvasRenderingContext2D;
  private drawnVersion = -1;
  private infoHasContent = false;
  private nextWrist = 0;

  constructor(
    private readonly rig: Rig,
    private readonly hud: Hud,
  ) {
    this.wrist.mesh.position.set(0, 0.05, 0.16);
    this.wrist.mesh.rotation.x = -Math.PI / 2 + 0.5;
    rig.left.object.add(this.wrist.mesh);
    this.info.mesh.position.set(0, -0.12, -1.5);
    rig.camera.add(this.info.mesh);
    this.map.width = this.map.height = 340;
    this.mapCtx = this.map.getContext('2d')!;
  }

  update(now: number, active: boolean, view: MapView | null): void {
    const showWrist = active && this.rig.left.connected;
    this.wrist.mesh.visible = showWrist;
    if (active && this.hud.version !== this.drawnVersion) {
      this.drawnVersion = this.hud.version;
      this.drawInfo(now);
    }
    this.info.mesh.visible = active && this.infoHasContent;
    if (showWrist && view && now >= this.nextWrist) {
      this.nextWrist = now + 150;
      this.drawWrist(view);
    }
  }

  dispose(): void {
    for (const { mesh, tex } of [this.wrist, this.info]) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
      tex.dispose();
    }
  }

  private drawWrist(view: MapView): void {
    const { ctx, tex } = this.wrist;
    const hud = this.hud;
    ctx.clearRect(0, 0, 512, 512);
    ctx.fillStyle = 'rgba(8,16,26,0.88)';
    ctx.beginPath();
    ctx.roundRect(6, 6, 500, 500, 44);
    ctx.fill();
    ctx.font = 'bold 58px Trebuchet MS, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#6ee07a';
    ctx.fillText(`$${hud.cash.toLocaleString()}`, 36, 82);
    ctx.font = '46px sans-serif';
    ctx.textAlign = 'center';
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i < hud.wanted ? '#ffd54a' : 'rgba(255,255,255,0.18)';
      ctx.fillText('★', 290 + i * 44, 80);
    }
    ctx.fillStyle = '#3a0d0d';
    ctx.fillRect(36, 104, 440, 22);
    ctx.fillStyle = '#e53935';
    ctx.fillRect(36, 104, (440 * Math.max(0, hud.hp)) / 100, 22);
    ctx.font = 'bold 36px Trebuchet MS, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText(hud.weaponText, 36, 168);
    hud.drawMinimap(this.mapCtx, 340, view.x, view.y, view.heading, view.dots);
    ctx.drawImage(this.map, 106, 186, 300, 300);
    tex.needsUpdate = true;
  }

  private drawInfo(now: number): void {
    const { ctx, tex } = this.info;
    const hud = this.hud;
    ctx.clearRect(0, 0, 1024, 512);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let any = false;
    if (hud.banner.text && hud.banner.until > now) {
      ctx.font = 'bold 140px Trebuchet MS, sans-serif';
      ctx.lineWidth = 12;
      ctx.strokeStyle = '#000';
      ctx.strokeText(hud.banner.text, 512, 170);
      ctx.fillStyle = hud.banner.color;
      ctx.fillText(hud.banner.text, 512, 170);
      any = true;
    }
    if (hud.hint) {
      ctx.font = 'bold 44px Trebuchet MS, sans-serif';
      const w = ctx.measureText(hud.hint).width + 60;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.roundRect(512 - w / 2, 300, w, 70, 20);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(hud.hint, 512, 336);
      any = true;
    }
    const lines = hud.feed.slice(-2);
    ctx.font = '34px Trebuchet MS, sans-serif';
    lines.forEach((line, i) => {
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(line.text, 512, 420 + i * 44);
      ctx.fillStyle = '#fff';
      ctx.fillText(line.text, 512, 420 + i * 44);
      any = true;
    });
    this.infoHasContent = any;
    tex.needsUpdate = true;
  }
}
