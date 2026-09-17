import { HeadsetHud } from '../crossplay/headsetHud';
import type { Rig } from '../crossplay/rig';
import type { HauntContext } from './context';
import { POWERS } from './haunt';
import type { Hud } from './hud';

/** How often the watch is redrawn while nothing on it changed, ms (the clock ticks). */
const TICK_MS = 500;

/**
 * The HUD inside a headset: a watch on the left wrist and a strip in front of your eyes for banners, hints and messages.
 * A survivor's watch shows the night, their health and battery and who's in the house; the Haunt's shows its dread and
 * what it has armed.
 */
export class Wrist {
  private readonly panels: HeadsetHud;
  private drawnVersion = -1;
  private next = 0;

  constructor(
    rig: Rig,
    private readonly hud: Hud,
    private readonly role: 'survivor' | 'haunt',
  ) {
    this.panels = new HeadsetHud(rig, hud, 0.22);
  }

  update(ctx: HauntContext): void {
    if (!this.panels.update(ctx.now)) return;
    const hud = this.hud;
    if (hud.version === this.drawnVersion && ctx.now < this.next) return;
    this.drawnVersion = hud.version;
    this.next = ctx.now + TICK_MS;
    const c = this.panels.face(this.role === 'haunt' ? 'rgba(24,12,36,0.92)' : 'rgba(10,10,16,0.9)');
    c.fillStyle = '#e8d9b0';
    c.font = 'bold 26px Georgia, serif';
    c.fillText(hud.phase, 26, 50, 460);
    if (this.role === 'survivor') {
      c.font = 'bold 54px Georgia, serif';
      c.fillStyle = '#e04a3a';
      c.fillText('♥'.repeat(hud.hp), 26, 120);
      c.fillStyle = 'rgba(224,74,58,0.25)';
      c.fillText('♥'.repeat(Math.max(0, 3 - hud.hp)), 26 + hud.hp * 44, 120);
      c.fillStyle = '#333';
      c.fillRect(250, 82, 220, 32);
      c.fillStyle = hud.battery < 25 ? '#e0703a' : '#f5e6a8';
      c.fillRect(254, 86, 212 * (hud.battery / 100), 24);
      c.font = '24px Georgia, serif';
      c.fillStyle = '#ffd35a';
      if (hud.carrying) c.fillText('You have a key', 26, 160);
    } else {
      c.fillStyle = '#333';
      c.fillRect(26, 80, 460, 34);
      c.fillStyle = '#b46bff';
      c.fillRect(30, 84, 452 * Math.min(1, hud.dread / 200), 26);
      c.fillStyle = '#fff';
      c.font = 'bold 26px Georgia, serif';
      c.fillText(`${hud.dread} dread`, 34, 106);
      c.fillText(hud.armed === null ? 'A: arm a power' : `${POWERS[hud.armed].name} (${POWERS[hud.armed].cost})`, 26, 152, 460);
      c.font = '22px Georgia, serif';
      c.fillText(hud.army, 26, 184, 460);
    }
    hud.party.slice(0, 7).forEach((l, i) => {
      const y = 230 + i * 36;
      c.fillStyle = l.color;
      c.fillRect(26, y - 20, 16, 22);
      c.fillStyle = l.me ? '#ffd35a' : l.seen ? '#e8e8e8' : '#8a8a8a';
      c.font = '24px Georgia, serif';
      c.fillText(`${l.name}  ·  ${l.status}`, 52, y, 430);
    });
    this.panels.watch.tex.needsUpdate = true;
  }

  dispose(): void {
    this.panels.dispose();
  }
}
