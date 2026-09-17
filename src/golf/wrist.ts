import { HeadsetHud } from '../crossplay/headsetHud';
import type { Rig } from '../crossplay/rig';
import type { GolfContext } from './context';
import type { Hud } from './hud';

/** How often the watch's map is redrawn, ms. */
const MAP_MS = 250;

/**
 * The HUD inside a headset: a watch on the left wrist (the hole and its clock, your ball, the leaderboard, and a
 * little map to find your ball by) and a head-locked strip for banners, hints and messages.
 */
export class Wrist {
  private readonly panels: HeadsetHud;
  private drawnVersion = -1;
  private nextMap = 0;

  constructor(
    rig: Rig,
    private readonly hud: Hud,
  ) {
    this.panels = new HeadsetHud(rig, hud, 0.22);
  }

  update(ctx: GolfContext, heading: number): void {
    if (!this.panels.update(ctx.now)) return;
    const s = ctx.me?.state;
    if (!s || (this.hud.version === this.drawnVersion && ctx.now < this.nextMap)) return;
    this.drawnVersion = this.hud.version;
    this.nextMap = ctx.now + MAP_MS;
    const hud = this.hud;
    const c = this.panels.face('rgba(18,40,26,0.92)');
    c.fillStyle = '#f5e6a8';
    c.font = 'bold 28px Trebuchet MS, sans-serif';
    c.fillText(hud.phase, 28, 52, 456);
    c.fillStyle = '#fff';
    c.font = 'bold 26px Trebuchet MS, sans-serif';
    c.fillText(hud.ball || hud.hole, 28, 94, 456);
    hud.lines.slice(0, 6).forEach((l, i) => {
      const y = 150 + i * 38;
      c.fillStyle = l.me ? '#f5e6a8' : '#dfe6e9';
      c.font = '26px Trebuchet MS, sans-serif';
      c.textAlign = 'left';
      c.fillText(`${l.place}  ${l.name}`, 28, y, 200);
      c.textAlign = 'right';
      c.fillText(l.score, 290, y);
      c.textAlign = 'left';
    });
    // the map, in the bottom right corner
    c.save();
    c.translate(300, 300);
    this.hud.drawMinimap(c, 190, s.x, s.y, heading, 110);
    c.restore();
    this.panels.watch.tex.needsUpdate = true;
  }

  dispose(): void {
    this.panels.dispose();
  }
}
