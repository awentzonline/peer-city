import { HeadsetHud } from '../crossplay/headsetHud';
import type { Rig } from '../crossplay/rig';
import type { SewerContext } from './context';
import type { Hud } from './hud';
import { MAX_HP } from './lord';

/** How often the watch is redrawn while nothing on it changed, ms (the clock ticks). */
const TICK_MS = 500;

/**
 * The HUD inside a headset: a grimy watch on the left wrist and a strip in front of your eyes for banners, hints and
 * messages. The watch shows the dive, your health and air, the hose's pressure, the detector's needle, what's in your
 * sack, how high the water is, and who's down here.
 */
export class Wrist {
  private readonly panels: HeadsetHud;
  private drawnVersion = -1;
  private next = 0;

  constructor(
    rig: Rig,
    private readonly hud: Hud,
  ) {
    this.panels = new HeadsetHud(rig, hud, 0.22);
  }

  update(ctx: SewerContext): void {
    if (!this.panels.update(ctx.now)) return;
    const hud = this.hud;
    if (hud.version === this.drawnVersion && ctx.now < this.next) return;
    this.drawnVersion = hud.version;
    this.next = ctx.now + TICK_MS;
    const c = this.panels.face('rgba(18,22,10,0.92)');
    c.fillStyle = '#c8e05a';
    c.font = 'bold 24px Trebuchet MS, sans-serif';
    c.fillText(hud.phase, 22, 46, 470);
    // health, and air when it's running out
    c.font = 'bold 50px Trebuchet MS, sans-serif';
    c.fillStyle = '#e04a3a';
    c.fillText('♥'.repeat(Math.max(0, hud.hp)), 22, 108);
    c.fillStyle = 'rgba(224,74,58,0.25)';
    c.fillText('♥'.repeat(Math.max(0, MAX_HP - hud.hp)), 22 + Math.max(0, hud.hp) * 40, 108);
    if (hud.air < 1) bar(c, 22, 124, 300, 20, hud.air, '#6ac8ff', 'AIR');
    // pressure, and the detector's needle
    if (hud.hose) bar(c, 22, 156, 300, 26, hud.charge / 100, hud.charge < 15 ? '#e0703a' : '#ffd35a', 'PRESSURE');
    if (hud.sweeping) {
      c.strokeStyle = '#8fe3ff';
      c.lineWidth = 6;
      c.beginPath();
      c.arc(420, 175, 60, Math.PI, 0);
      c.stroke();
      const a = Math.PI + hud.signal * Math.PI;
      c.beginPath();
      c.moveTo(420, 175);
      c.lineTo(420 + Math.cos(a) * 56, 175 + Math.sin(a) * 56);
      c.strokeStyle = hud.signal > 0.6 ? '#7aff7a' : '#e8e8e8';
      c.stroke();
    }
    // the water, up the right edge
    c.fillStyle = '#333';
    c.fillRect(470, 220, 22, 270);
    c.fillStyle = hud.surge ? '#b0a040' : '#6a6a2a';
    c.fillRect(470, 220 + 270 * (1 - hud.water), 22, 270 * hud.water);
    c.font = '22px Trebuchet MS, sans-serif';
    c.fillStyle = '#ffd35a';
    if (hud.sack > 0) c.fillText(`Sack: ${hud.sack}`, 22, 214);
    if (hud.action) {
      c.fillStyle = '#fff';
      bar(c, 22, 226, 430, 24, hud.progress, '#9fe0a8', hud.action);
    }
    hud.party.slice(0, 6).forEach((l, i) => {
      const y = 290 + i * 34;
      c.fillStyle = l.color;
      c.fillRect(22, y - 20, 14, 22);
      c.fillStyle = l.me ? '#ffd35a' : '#e8e8e8';
      c.font = '23px Trebuchet MS, sans-serif';
      c.fillText(`${l.name}  ·  ${l.status}`, 46, y, 410);
    });
    this.panels.watch.tex.needsUpdate = true;
  }

  dispose(): void {
    this.panels.dispose();
  }
}

function bar(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, k: number, color: string, label: string): void {
  c.fillStyle = '#2a2a24';
  c.fillRect(x, y, w, h);
  c.fillStyle = color;
  c.fillRect(x + 2, y + 2, (w - 4) * Math.max(0, Math.min(1, k)), h - 4);
  c.fillStyle = '#111';
  c.font = `bold ${h - 8}px Trebuchet MS, sans-serif`;
  c.fillText(label, x + 8, y + h - 6);
}
