import { HeadsetHud } from '../crossplay/headsetHud';
import type { Rig } from '../crossplay/rig';
import type { Builder } from './builder';
import type { Hud } from './hud';
import { PARTS, PLACEABLE } from './parts';

/**
 * The HUD inside a headset: a watch on the left wrist (the race, what the part gun's loaded with, how your
 * racer adds up) and a head-locked strip for banners, hints and messages.
 */
export class Wrist {
  private readonly panels: HeadsetHud;
  private drawnVersion = -1;
  private drawnPart = -1;

  constructor(
    rig: Rig,
    private readonly hud: Hud,
  ) {
    this.panels = new HeadsetHud(rig, hud, 0.22);
  }

  update(now: number, builder: Builder): void {
    if (!this.panels.update(now)) return;
    if (this.hud.version === this.drawnVersion && builder.part === this.drawnPart) return;
    this.drawnVersion = this.hud.version;
    this.drawnPart = builder.part;
    this.drawWatch(builder);
  }

  dispose(): void {
    this.panels.dispose();
  }

  private drawWatch(builder: Builder): void {
    const hud = this.hud;
    const ctx = this.panels.face('rgba(20,24,30,0.9)');
    ctx.fillStyle = '#f5c542';
    ctx.font = 'bold 30px Trebuchet MS, sans-serif';
    ctx.fillText(hud.phase, 30, 56, 452);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 34px Trebuchet MS, sans-serif';
    if (builder.seated) {
      ctx.fillText(hud.drive, 30, 110, 452);
      hud.lines.slice(0, 7).forEach((l, i) => {
        ctx.fillStyle = l.me ? '#f5c542' : '#dfe6e9';
        ctx.font = '28px Trebuchet MS, sans-serif';
        ctx.fillText(`${l.place}  ${l.name}`, 30, 170 + i * 42, 300);
        ctx.textAlign = 'right';
        ctx.fillText(l.detail, 482, 170 + i * 42);
        ctx.textAlign = 'left';
      });
    } else {
      ctx.fillText(hud.build, 30, 110, 452);
      ctx.font = '24px Trebuchet MS, sans-serif';
      ctx.fillStyle = '#b2bec3';
      ctx.fillText(hud.stats, 30, 150, 452);
      PLACEABLE.forEach((kind, i) => {
        const x = 30 + (i % 3) * 152;
        const y = 180 + Math.floor(i / 3) * 96;
        const on = kind === builder.part;
        ctx.fillStyle = on ? '#fff' : 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.roundRect(x, y, 140, 84, 14);
        ctx.fill();
        ctx.fillStyle = `#${PARTS[kind].color.toString(16).padStart(6, '0')}`;
        ctx.fillRect(x + 10, y + 12, 24, 24);
        ctx.fillStyle = on ? '#111' : '#dfe6e9';
        ctx.font = 'bold 24px Trebuchet MS, sans-serif';
        ctx.fillText(PARTS[kind].name, x + 10, y + 68, 124);
      });
    }
    this.panels.watch.tex.needsUpdate = true;
  }
}
