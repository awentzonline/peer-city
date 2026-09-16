import { disposePanel, panel } from '../crossplay/panel';
import type { Rig } from '../crossplay/rig';
import { hex, type Hud } from './hud';
import type { Painter } from './painter';
import { PALETTE } from './yard';

/**
 * The HUD inside a headset: a watch on the left wrist with the colours (the loaded one ringed) and your tools'
 * sizes, and a head-locked strip for hints and messages.
 */
export class Wrist {
  private readonly watch = panel(0.2, 0.2, 512, 512, false);
  private readonly info = panel(1.2, 0.6, 1024, 512, true);
  private drawn = '';
  private infoHasContent = false;

  constructor(
    private readonly rig: Rig,
    private readonly hud: Hud,
  ) {
    this.watch.mesh.position.set(0, 0.05, 0.16);
    this.watch.mesh.rotation.x = -Math.PI / 2 + 0.5;
    rig.left.object.add(this.watch.mesh);
    this.info.mesh.position.set(0, -0.12, -1.5);
    rig.camera.add(this.info.mesh);
  }

  update(now: number, painter: Painter): void {
    this.watch.mesh.visible = this.rig.left.connected;
    const key = `${this.hud.version}:${painter.colorIndex}:${painter.size}:${Math.floor(now / 1000)}`;
    if (key === this.drawn) {
      this.info.mesh.visible = this.infoHasContent;
      return;
    }
    this.drawn = key;
    this.drawWatch(painter);
    this.drawInfo(now);
    this.info.mesh.visible = this.infoHasContent;
  }

  dispose(): void {
    disposePanel(this.watch);
    disposePanel(this.info);
  }

  private drawWatch(painter: Painter): void {
    const { ctx, tex } = this.watch;
    ctx.clearRect(0, 0, 512, 512);
    ctx.fillStyle = 'rgba(20,24,30,0.9)';
    ctx.beginPath();
    ctx.roundRect(6, 6, 500, 500, 44);
    ctx.fill();
    ctx.textAlign = 'left';
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
    tex.needsUpdate = true;
  }

  private drawInfo(now: number): void {
    const { ctx, tex } = this.info;
    const hud = this.hud;
    ctx.clearRect(0, 0, 1024, 512);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let any = false;
    if (hud.hint) {
      ctx.font = 'bold 40px Trebuchet MS, sans-serif';
      const w = ctx.measureText(hud.hint).width + 60;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.roundRect(512 - w / 2, 300, w, 70, 20);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(hud.hint, 512, 336);
      any = true;
    }
    ctx.font = '32px Trebuchet MS, sans-serif';
    hud.feed
      .filter((line) => line.until > now)
      .slice(-2)
      .forEach((line, i) => {
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
