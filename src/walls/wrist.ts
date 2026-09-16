import { HeadsetHud } from '../crossplay/headsetHud';
import type { Rig } from '../crossplay/rig';
import { hex, type Hud } from './hud';
import type { Painter } from './painter';
import { PALETTE } from './yard';

/**
 * The HUD inside a headset: a watch on the left wrist with the colours (the loaded one ringed) and your tools'
 * sizes, and a head-locked strip for hints and messages.
 */
export class Wrist {
  private readonly panels: HeadsetHud;
  private drawn = '';

  constructor(
    rig: Rig,
    private readonly hud: Hud,
  ) {
    this.panels = new HeadsetHud(rig, hud);
  }

  update(now: number, painter: Painter): void {
    if (!this.panels.update(now)) return;
    const key = `${this.hud.version}:${painter.colorIndex}:${painter.size}`;
    if (key === this.drawn) return;
    this.drawn = key;
    this.drawWatch(painter);
  }

  dispose(): void {
    this.panels.dispose();
  }

  private drawWatch(painter: Painter): void {
    const ctx = this.panels.face('rgba(20,24,30,0.9)');
    ctx.fillStyle = '#ffd21f';
    ctx.font = 'bold 28px Trebuchet MS, sans-serif';
    ctx.fillText(this.hud.status, 30, 54, 452);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px Trebuchet MS, sans-serif';
    ctx.fillText(PALETTE[painter.colorIndex].name, 30, 108, 452);
    ctx.font = '26px Trebuchet MS, sans-serif';
    ctx.fillStyle = '#b2bec3';
    const sizes = painter.inventory.tools.all.map((t) => t.spec.sizes[painter.size]).join(' · ');
    ctx.fillText(sizes, 30, 150, 452);
    PALETTE.forEach((c, i) => {
      const x = 30 + (i % 4) * 114;
      const y = 180 + Math.floor(i / 4) * 78;
      if (i === painter.colorIndex) {
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.roundRect(x - 6, y - 6, 110, 72, 16);
        ctx.fill();
      }
      ctx.fillStyle = hex(c.rgb);
      ctx.beginPath();
      ctx.roundRect(x, y, 98, 60, 12);
      ctx.fill();
    });
    this.panels.watch.tex.needsUpdate = true;
  }
}
