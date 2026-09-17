import { HeadsetHud } from '../crossplay/headsetHud';
import type { Rig } from '../crossplay/rig';
import { CALLS, CALL_ORDER } from './captain';
import type { ShinobiContext } from './context';
import type { Hud } from './hud';

/** How often the watch is redrawn while nothing on it changed, ms (the clock ticks). */
const TICK_MS = 500;

/**
 * The HUD inside a headset: a watch on the left wrist and a strip in front of your eyes for banners, hints and messages.
 * A shinobi's watch shows the night, their health, what they carry and how visible they are; the captain's shows the
 * calls and how they're coming round.
 */
export class Wrist {
  private readonly panels: HeadsetHud;
  private drawnVersion = -1;
  private next = 0;

  constructor(
    rig: Rig,
    private readonly hud: Hud,
    private readonly role: 'shinobi' | 'captain',
  ) {
    this.panels = new HeadsetHud(rig, hud, 0.22);
  }

  update(ctx: ShinobiContext): void {
    if (!this.panels.update(ctx.now)) return;
    const hud = this.hud;
    if (hud.version === this.drawnVersion && ctx.now < this.next) return;
    this.drawnVersion = hud.version;
    this.next = ctx.now + TICK_MS;
    const c = this.panels.face(this.role === 'captain' ? 'rgba(14,20,34,0.92)' : 'rgba(10,10,14,0.9)');
    c.fillStyle = '#e8dcc0';
    c.font = 'bold 24px Georgia, serif';
    c.fillText(hud.phase, 26, 50, 460);
    if (this.role === 'shinobi') {
      c.font = 'bold 54px Georgia, serif';
      c.fillStyle = '#e04a3a';
      c.fillText('♥'.repeat(Math.max(0, hud.hp)), 26, 120);
      c.fillStyle = 'rgba(224,74,58,0.25)';
      c.fillText('♥'.repeat(Math.max(0, 3 - hud.hp)), 26 + Math.max(0, hud.hp) * 44, 120);
      c.font = '28px Georgia, serif';
      c.fillStyle = '#d8dde8';
      c.fillText(`Kunai ×${Math.max(0, hud.kunai)}   Shuriken ×${Math.max(0, hud.shuriken)}`, 26, 170, 460);
      // how visible you are
      c.fillStyle = '#333';
      c.fillRect(26, 196, 460, 30);
      c.fillStyle = hud.hidden ? '#4a7a4a' : hud.exposure > 60 ? '#ffb35a' : '#8a9ac0';
      c.fillRect(30, 200, 452 * Math.max(0, hud.exposure) / 100, 22);
      c.fillStyle = '#fff';
      c.font = 'bold 22px Georgia, serif';
      c.fillText(hud.hidden ? 'hidden' : `seen ${Math.max(0, hud.exposure)}%`, 36, 219);
    } else {
      const waits = hud.calls.split('|');
      c.font = '26px Georgia, serif';
      CALL_ORDER.forEach((call, i) => {
        const wait = Number(waits[i] ?? 0);
        c.fillStyle = call === hud.armed ? '#6ad0ff' : wait > 0 ? '#777' : '#e8e8e8';
        c.fillText(`${CALLS[call].name}${wait > 0 ? ` · ${wait}s` : ''}`, 26, 100 + i * 34, 460);
      });
      c.fillStyle = '#e8dcc0';
      c.fillText(hud.roster, 26, 250, 460);
    }
    hud.party.slice(0, 6).forEach((l, i) => {
      const y = 290 + i * 34;
      c.fillStyle = l.color;
      c.fillRect(26, y - 20, 16, 22);
      c.fillStyle = l.me ? '#ffd35a' : '#e8e8e8';
      c.font = '24px Georgia, serif';
      c.fillText(`${l.name}  ·  ${l.status}`, 52, y, 430);
    });
    this.panels.watch.tex.needsUpdate = true;
  }

  dispose(): void {
    this.panels.dispose();
  }
}
