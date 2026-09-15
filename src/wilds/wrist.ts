import { disposePanel, panel } from '../crossplay/panel';
import type { Rig } from '../crossplay/rig';
import type { Hud, MapDot } from './hud';

export interface MapView {
  x: number;
  y: number;
  heading: number;
  dots: MapDot[];
}

/**
 * The HUD inside a headset: a watch on the left wrist (health, food, time of day, what's in hand, and a map)
 * and a head-locked strip for banners, hints and messages.
 */
export class Wrist {
  private readonly watch = panel(0.2, 0.2, 512, 512, false);
  private readonly info = panel(1.2, 0.6, 1024, 512, true);
  private readonly map = document.createElement('canvas');
  private readonly mapCtx: CanvasRenderingContext2D;
  private drawnVersion = -1;
  private infoHasContent = false;
  private nextWatch = 0;

  constructor(
    private readonly rig: Rig,
    private readonly hud: Hud,
  ) {
    this.watch.mesh.position.set(0, 0.05, 0.16);
    this.watch.mesh.rotation.x = -Math.PI / 2 + 0.5;
    rig.left.object.add(this.watch.mesh);
    this.info.mesh.position.set(0, -0.12, -1.5);
    rig.camera.add(this.info.mesh);
    this.map.width = this.map.height = 300;
    this.mapCtx = this.map.getContext('2d')!;
  }

  update(now: number, view: MapView): void {
    const showWatch = this.rig.left.connected;
    this.watch.mesh.visible = showWatch;
    if (this.hud.version !== this.drawnVersion) {
      this.drawnVersion = this.hud.version;
      this.drawInfo(now);
    }
    this.info.mesh.visible = this.infoHasContent;
    if (showWatch && now >= this.nextWatch) {
      this.nextWatch = now + 150;
      this.drawWatch(view);
    }
  }

  dispose(): void {
    disposePanel(this.watch);
    disposePanel(this.info);
  }

  private drawWatch(view: MapView): void {
    const { ctx, tex } = this.watch;
    const hud = this.hud;
    ctx.clearRect(0, 0, 512, 512);
    ctx.fillStyle = 'rgba(20,16,10,0.88)';
    ctx.beginPath();
    ctx.roundRect(6, 6, 500, 500, 44);
    ctx.fill();
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
    hud.feed.slice(-2).forEach((line, i) => {
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
