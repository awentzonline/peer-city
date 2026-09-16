import * as THREE from 'three';
import { disposePanel, panel } from './panel';
import { Btn, type Rig, type XRHand } from './rig';
import type { Settings, SettingsRow } from './settings';

/** Panel size in meters, and the canvas it's drawn on. */
const WIDTH = 0.44;
const HEIGHT = 0.5;
const W = 528;
const H = 600;
/** How far in front of your face it hangs when you open it. */
const DISTANCE = 0.5;
/** How far in front of the panel (and how far through it) a fingertip counts as touching a row. Generous,
 * because there's nothing to feel: a hand held out towards a row is reaching for it. */
const TOUCH_NEAR = 0.16;
const TOUCH_THROUGH = 0.05;
/** The fingertip, in controller space: a little ahead of where you hold it. */
const TIP = new THREE.Vector3(0, 0, -0.05);
const ROW_H = 62;
const TOP = 96;
const REDRAW_MS = 120;

const tip = new THREE.Vector3();
const head = new THREE.Vector3();
const forward = new THREE.Vector3();
const FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * The settings menu inside a headset: the same rows as the desktop menu (settings.ts), painted onto a panel
 * that hangs in front of you where you opened it. Put a fingertip on a row and pull the trigger to toggle
 * it, which is the only reach-out-and-touch idiom the rig needs for something this small.
 */
export class VrSettings {
  private readonly view = panel(WIDTH, HEIGHT, W, H, false);
  private rows: SettingsRow[] = [];
  private hovered = -1;
  private nextDraw = 0;

  constructor(
    private readonly settings: Settings,
    private readonly rig: Rig,
  ) {
    rig.root.add(this.view.mesh);
  }

  get open(): boolean {
    return this.settings.open;
  }

  toggle(): void {
    this.setOpen(!this.settings.open);
  }

  setOpen(open: boolean): void {
    this.settings.open = open;
    this.view.mesh.visible = open;
    this.hovered = -1;
    this.nextDraw = 0;
    if (open) this.placeInFront();
  }

  dispose(): void {
    this.settings.open = false;
    disposePanel(this.view);
  }

  /** Read the hands and redraw. Returns whether the menu took this frame's trigger, so tools don't fire too. */
  update(now: number): boolean {
    if (!this.settings.open) return false;
    if (now >= this.nextDraw) {
      this.nextDraw = now + REDRAW_MS;
      this.rows = this.settings.rows();
      this.draw();
    }
    let used = false;
    let hovered = -1;
    this.rig.root.updateMatrixWorld();
    for (const hand of [this.rig.right, this.rig.left]) {
      const row = this.rowUnder(hand);
      if (row < 0) continue;
      hovered = row;
      if (!hand.pressed(Btn.Trigger)) continue;
      this.rows[row].toggle();
      hand.pulse(0.6, 30);
      this.nextDraw = 0;
      used = true;
    }
    if (hovered !== this.hovered) {
      this.hovered = hovered;
      this.nextDraw = 0;
    }
    // A trigger anywhere belongs to the menu while it's up: you're pointing at it, not using a tool.
    return used || hovered >= 0;
  }

  /** Hang it at arm's length in front of the head, facing it, so it stays put while you reach for it. */
  private placeInFront(): void {
    const mesh = this.view.mesh;
    const rig = this.rig;
    rig.root.updateMatrixWorld();
    forward.copy(FORWARD).applyQuaternion(rig.headQuat);
    forward.y *= 0.3; // keep it roughly upright however you were looking
    forward.normalize();
    // The panel rides in the play space, but lookAt wants the head in world space.
    mesh.position.copy(rig.headLocal).addScaledVector(forward, DISTANCE);
    mesh.lookAt(rig.root.localToWorld(head.copy(rig.headLocal)));
  }

  /** Which row a hand's fingertip is touching, or -1. */
  private rowUnder(hand: XRHand): number {
    if (!hand.connected) return -1;
    hand.object.updateMatrixWorld();
    tip.copy(TIP).applyMatrix4(hand.object.matrixWorld);
    this.view.mesh.worldToLocal(tip);
    // The panel faces the head, so a hand in front of it is at positive z in its own space.
    if (tip.z > TOUCH_NEAR || tip.z < -TOUCH_THROUGH || Math.abs(tip.x) > WIDTH / 2 || Math.abs(tip.y) > HEIGHT / 2) return -1;
    const y = (0.5 - tip.y / HEIGHT) * H;
    const i = Math.floor((y - TOP) / ROW_H);
    return i >= 0 && i < this.rows.length && this.rows[i].kind === 'toggle' ? i : -1;
  }

  private draw(): void {
    const { ctx, tex } = this.view;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(16,15,12,0.94)';
    ctx.beginPath();
    ctx.roundRect(4, 4, W - 8, H - 8, 26);
    ctx.fill();
    ctx.strokeStyle = 'rgba(240,223,176,0.25)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f0dfb0';
    ctx.font = 'bold 34px Trebuchet MS, sans-serif';
    ctx.fillText('SETTINGS', 32, 52);

    this.rows.forEach((row, i) => {
      const y = TOP + i * ROW_H;
      if (y + ROW_H > H - 40) return; // anything past the bottom waits until people move
      if (row.kind === 'heading') {
        ctx.fillStyle = '#bfb29a';
        ctx.font = 'bold 20px Trebuchet MS, sans-serif';
        ctx.fillText(row.label.toUpperCase(), 32, y + ROW_H / 2 + 8);
        return;
      }
      if (row.kind === 'note') {
        ctx.fillStyle = '#7d735f';
        ctx.font = '22px Trebuchet MS, sans-serif';
        ctx.fillText(row.label, 32, y + ROW_H / 2);
        return;
      }
      const hot = i === this.hovered;
      ctx.fillStyle = hot ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.roundRect(24, y + 4, W - 48, ROW_H - 8, 10);
      ctx.fill();
      ctx.fillStyle = row.on ? '#6ad36a' : '#6b6155';
      ctx.fillRect(24, y + 4, 6, ROW_H - 8);

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 24px Trebuchet MS, sans-serif';
      ctx.fillText(row.label, 44, y + 22);
      ctx.fillStyle = '#a99e88';
      ctx.font = '18px Trebuchet MS, sans-serif';
      ctx.fillText(row.detail, 44, y + 45);

      ctx.textAlign = 'right';
      ctx.fillStyle = row.on ? '#6ad36a' : '#7d735f';
      ctx.font = 'bold 18px Trebuchet MS, sans-serif';
      ctx.fillText(row.on ? 'ON' : 'OFF', W - 44, y + ROW_H / 2);
      ctx.textAlign = 'left';

      if (row.level > 0) {
        ctx.fillStyle = '#6ad36a';
        ctx.fillRect(30, y + ROW_H - 8, (W - 60) * Math.min(1, row.level), 3);
      }
    });

    ctx.fillStyle = '#9a8f7a';
    ctx.font = '18px Trebuchet MS, sans-serif';
    ctx.fillText('Touch a row and pull the trigger · Y closes', 32, H - 28);
    tex.needsUpdate = true;
  }
}
