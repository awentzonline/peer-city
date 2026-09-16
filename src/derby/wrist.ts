import { disposePanel, panel } from '../crossplay/panel';
import type { Rig } from '../crossplay/rig';
import type { Builder } from './builder';
import type { Hud } from './hud';
import { PARTS, PLACEABLE } from './parts';

/**
 * The HUD inside a headset: a watch on the left wrist (the race, what the part gun's loaded with, how your
 * racer adds up) and a head-locked strip for banners, hints and messages.
 */
export class Wrist {
  private readonly watch = panel(0.22, 0.22, 512, 512, false);
  private readonly info = panel(1.2, 0.6, 1024, 512, true);
  private drawnVersion = -1;
  private drawnPart = -1;
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

  update(now: number, builder: Builder): void {
    this.watch.mesh.visible = this.rig.left.connected;
    if (this.hud.version === this.drawnVersion && builder.part === this.drawnPart) {
      this.info.mesh.visible = this.infoHasContent;
      return;
    }
    this.drawnVersion = this.hud.version;
    this.drawnPart = builder.part;
    this.drawWatch(builder);
    this.drawInfo(now);
    this.info.mesh.visible = this.infoHasContent;
  }

  dispose(): void {
    disposePanel(this.watch);
    disposePanel(this.info);
  }

  private drawWatch(builder: Builder): void {
    const { ctx, tex } = this.watch;
    const hud = this.hud;
    ctx.clearRect(0, 0, 512, 512);
    ctx.fillStyle = 'rgba(20,24,30,0.9)';
    ctx.beginPath();
    ctx.roundRect(6, 6, 500, 500, 44);
    ctx.fill();
    ctx.textAlign = 'left';
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
    tex.needsUpdate = true;
  }

  private drawInfo(now: number): void {
    const { ctx, tex } = this.info;
    const hud = this.hud;
    ctx.clearRect(0, 0, 1024, 512);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let any = false;
    if (hud.banner.text && hud.banner.until > now) {
      ctx.font = 'bold 130px Trebuchet MS, sans-serif';
      ctx.lineWidth = 12;
      ctx.strokeStyle = '#000';
      ctx.strokeText(hud.banner.text, 512, 170);
      ctx.fillStyle = hud.banner.color;
      ctx.fillText(hud.banner.text, 512, 170);
      any = true;
    }
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
