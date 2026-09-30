import { HeadsetHud } from '../crossplay/headsetHud';
import type { Rig } from '../crossplay/rig';
import type { Hud } from './hud';

/**
 * The HUD inside a headset: a watch on the left wrist with your points, the combo with whoever you're facing and the
 * top of the leaderboard, and a head-locked strip for banners, hints and messages. A warning of someone behind you goes
 * on the strip, as the hint, so you see it without looking at your wrist.
 */
export class Wrist {
  private readonly panels: HeadsetHud;
  private drawn = -1;

  constructor(
    rig: Rig,
    private readonly hud: Hud,
  ) {
    this.panels = new HeadsetHud(rig, hud);
  }

  update(now: number, myId: number): void {
    if (!this.panels.update(now)) return;
    if (this.hud.version === this.drawn) return;
    this.drawn = this.hud.version;
    this.drawWatch(myId);
  }

  dispose(): void {
    this.panels.dispose();
  }

  private drawWatch(myId: number): void {
    const { hud } = this;
    const ctx = this.panels.face('rgba(20, 16, 38, 0.92)');
    ctx.fillStyle = '#ffd23f';
    ctx.font = '900 84px Trebuchet MS, sans-serif';
    ctx.fillText(`${Math.max(0, hud.score)}`, 30, 104, 300);
    ctx.fillStyle = '#b8b0d8';
    ctx.font = 'bold 26px Trebuchet MS, sans-serif';
    ctx.fillText('POINTS', 34, 136);
    ctx.fillStyle = '#8fd3ff';
    ctx.font = 'bold 30px Trebuchet MS, sans-serif';
    ctx.fillText(hud.comboWith || (hud.best > 1 ? `Best combo ×${hud.best}` : ''), 30, 182, 452);
    hud.board.slice(0, 6).forEach((r, i) => {
      const y = 238 + i * 44;
      ctx.fillStyle = r.id === myId ? '#ffd23f' : '#fff';
      ctx.font = `${r.id === myId ? 'bold ' : ''}32px Trebuchet MS, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillText(`${i + 1}. ${r.name}`, 30, y, 320);
      ctx.textAlign = 'right';
      ctx.fillText(`${r.score}`, 482, y);
    });
    ctx.textAlign = 'left';
    this.panels.watch.tex.needsUpdate = true;
  }
}
