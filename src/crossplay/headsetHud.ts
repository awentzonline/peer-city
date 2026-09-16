import type { HudBase } from './hud';
import { disposePanel, panel, type Panel } from './panel';
import type { Rig } from './rig';

/**
 * A HUD a headset can see, since the page's DOM isn't visible inside one: a watch on the left wrist, whose face
 * each game draws, and a strip in front of your eyes with the banner, the hint and the latest messages from a
 * `HudBase`, drawn the same in every game.
 */
export class HeadsetHud {
  /** The watch face: 512 × 512 pixels. Draw on `watch.ctx` (after `face()`), then set `watch.tex.needsUpdate`. */
  readonly watch: Panel;
  private readonly strip = panel(1.2, 0.6, 1024, 512, true);
  private drawnVersion = -1;
  private stripHasContent = false;

  constructor(
    private readonly rig: Rig,
    private readonly hud: HudBase,
    /** Meters across the watch. */
    watchSize = 0.2,
  ) {
    this.watch = panel(watchSize, watchSize, 512, 512, false);
    this.watch.mesh.position.set(0, 0.05, 0.16);
    this.watch.mesh.rotation.x = -Math.PI / 2 + 0.5;
    rig.left.object.add(this.watch.mesh);
    this.strip.mesh.position.set(0, -0.12, -1.5);
    rig.camera.add(this.strip.mesh);
  }

  /**
   * Call every rendered frame: redraws the strip when the HUD has changed, and shows the watch while the left
   * controller's tracked. Returns whether the watch is showing, so the game can redraw its face as often as that
   * needs. `active` false hides both.
   */
  update(now: number, active = true): boolean {
    const watching = active && this.rig.left.connected;
    this.watch.mesh.visible = watching;
    if (active && this.hud.version !== this.drawnVersion) {
      this.drawnVersion = this.hud.version;
      this.drawStrip(now);
    }
    this.strip.mesh.visible = active && this.stripHasContent;
    return watching;
  }

  /** Clear the watch and give it a rounded backing in `fill`, ready to draw on. */
  face(fill: string): CanvasRenderingContext2D {
    const { ctx } = this.watch;
    ctx.clearRect(0, 0, 512, 512);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(6, 6, 500, 500, 44);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    return ctx;
  }

  dispose(): void {
    disposePanel(this.watch);
    disposePanel(this.strip);
  }

  private drawStrip(now: number): void {
    const { ctx, tex } = this.strip;
    const { banner, hint, feed } = this.hud;
    ctx.clearRect(0, 0, 1024, 512);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let any = false;
    if (banner.text && banner.until > now) {
      ctx.font = 'bold 130px Trebuchet MS, sans-serif';
      ctx.lineWidth = 12;
      ctx.strokeStyle = '#000';
      ctx.strokeText(banner.text, 512, 170);
      ctx.fillStyle = banner.color;
      ctx.fillText(banner.text, 512, 170);
      any = true;
    }
    if (hint) {
      ctx.font = 'bold 40px Trebuchet MS, sans-serif';
      const w = ctx.measureText(hint).width + 60;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.roundRect(512 - w / 2, 300, w, 70, 20);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(hint, 512, 336);
      any = true;
    }
    ctx.font = '32px Trebuchet MS, sans-serif';
    feed
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
    this.stripHasContent = any;
    tex.needsUpdate = true;
  }
}
