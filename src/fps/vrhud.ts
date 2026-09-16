import { HeadsetHud } from '../crossplay/headsetHud';
import type { Rig } from '../crossplay/rig';
import type { Hud, MinimapDot } from './hud';

export interface MapView {
  x: number;
  y: number;
  heading: number;
  dots: MinimapDot[];
}

/**
 * The HUD inside a headset: a wristwatch panel on the left controller (cash, wanted level, health, minimap) and
 * a head-locked strip for banners, hints and the kill feed (crossplay/headsetHud.ts).
 */
export class VrHud {
  private readonly panels: HeadsetHud;
  private readonly map = document.createElement('canvas');
  private readonly mapCtx: CanvasRenderingContext2D;
  private nextWrist = 0;

  constructor(
    rig: Rig,
    private readonly hud: Hud,
  ) {
    this.panels = new HeadsetHud(rig, hud);
    this.map.width = this.map.height = 340;
    this.mapCtx = this.map.getContext('2d')!;
  }

  update(now: number, active: boolean, view: MapView | null): void {
    if (!this.panels.update(now, active) || !view || now < this.nextWrist) return;
    this.nextWrist = now + 150;
    this.drawWrist(view);
  }

  dispose(): void {
    this.panels.dispose();
  }

  private drawWrist(view: MapView): void {
    const hud = this.hud;
    const ctx = this.panels.face('rgba(8,16,26,0.88)');
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
    ctx.fillText(hud.toolText, 36, 168);
    hud.drawMinimap(this.mapCtx, 340, view.x, view.y, view.heading, view.dots);
    ctx.drawImage(this.map, 106, 186, 300, 300);
    this.panels.watch.tex.needsUpdate = true;
  }
}
