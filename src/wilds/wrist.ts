import { HeadsetHud } from '../crossplay/headsetHud';
import type { MinimapDot } from '../crossplay/minimap';
import type { Rig } from '../crossplay/rig';
import type { Hud } from './hud';

export interface MapView {
  x: number;
  y: number;
  heading: number;
  dots: MinimapDot[];
}

/**
 * The HUD inside a headset: a watch on the left wrist (health, food, time of day, what's in hand, and a map)
 * and a head-locked strip for banners, hints and messages.
 */
export class Wrist {
  private readonly panels: HeadsetHud;
  private readonly map = document.createElement('canvas');
  private readonly mapCtx: CanvasRenderingContext2D;
  private nextWatch = 0;

  constructor(
    rig: Rig,
    private readonly hud: Hud,
  ) {
    this.panels = new HeadsetHud(rig, hud);
    this.map.width = this.map.height = 300;
    this.mapCtx = this.map.getContext('2d')!;
  }

  update(now: number, view: MapView): void {
    if (!this.panels.update(now) || now < this.nextWatch) return;
    this.nextWatch = now + 150;
    this.drawWatch(view);
  }

  dispose(): void {
    this.panels.dispose();
  }

  private drawWatch(view: MapView): void {
    const hud = this.hud;
    const ctx = this.panels.face('rgba(20,16,10,0.88)');
    const bar = (y: number, value: number, back: string, front: string, label: string) => {
      ctx.fillStyle = back;
      ctx.fillRect(130, y, 340, 26);
      ctx.fillStyle = front;
      ctx.fillRect(130, y, (340 * Math.max(0, value)) / 100, 26);
      ctx.fillStyle = '#e8dcc4';
      ctx.font = 'bold 30px Trebuchet MS, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(label, 36, y + 24);
    };
    bar(40, hud.hp, '#3a0d0d', '#e0533a', 'Health');
    bar(84, hud.food, '#33270e', '#e2a93b', 'Food');
    ctx.font = 'bold 34px Trebuchet MS, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText(hud.toolText, 36, 160);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#c9b88f';
    ctx.fillText(hud.clock, 476, 160);
    hud.drawMinimap(this.mapCtx, 300, view.x, view.y, view.heading, view.dots);
    ctx.drawImage(this.map, 116, 190, 280, 280);
    this.panels.watch.tex.needsUpdate = true;
  }
}
