import type * as THREE from 'three';
import { MapGestures } from '../crossplay/mapGestures';
import { OverheadView, pageViewport } from '../crossplay/overhead';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { TouchChips } from '../crossplay/shell';
import type { CaptainFrontend, CaptainRole } from './captain';
import { CAPTAIN_START, CAPTAIN_VIEW, CaptainMarker, captainUsed, listenOverMap } from './captainDesktop';
import type { ShinobiContext } from './context';
import type { OrderKind } from './defs';
import type { CaptainKeys } from './hud';
import { idleCaptainIntent, stillCaptain, type Call, type CaptainIntent } from './intent';

const KEYS: CaptainKeys = {
  place: 'Tap where',
  pick: 'Tap your guards to pick them out, hold to gather those nearby',
  send: 'Tap the ground',
  bar: '',
};

const REFUSAL_MS = 1800;

/**
 * The captain on a phone or tablet, where the map is at home under your fingers. Drag to move, pinch to zoom and twist to
 * turn. Tap guards to pick them out (hold on the ground to gather every one nearby, or ALL), then tap where to send them
 * searching; WATCH has them stand watch at the next place you tap instead, and ROUNDS sends them back. Tap a card, then
 * tap the map to make that call.
 */
export class TouchCaptain implements CaptainFrontend {
  readonly platform = Platform.Touch;
  readonly view = new OverheadView(CAPTAIN_VIEW, { ...CAPTAIN_START, distance: 100 });
  private readonly intent = idleCaptainIntent();
  private readonly gestures = new MapGestures();
  private readonly layer = document.createElement('div');
  private readonly chipsEl = document.createElement('div');
  private readonly marker: CaptainMarker;
  private arm: Call | 'none' | null = null;
  private selectAll = false;
  private posting = false;
  private dismiss = false;
  private pointer: { x: number; y: number } | null = null;
  private refusal = { text: '', until: 0 };
  private readonly allChip: HTMLButtonElement;
  private readonly watchChip: HTMLButtonElement;

  constructor(
    private readonly ctx: ShinobiContext,
    private readonly role: CaptainRole,
    private readonly rig: Rig,
    chips: TouchChips,
    scene: THREE.Scene,
  ) {
    rig.setMode('desktop');
    this.marker = new CaptainMarker(ctx, scene);
    ctx.hud.onCall = (c) => (this.arm = c);

    this.layer.className = 'captain-map';
    const g = this.gestures;
    this.layer.addEventListener('pointerdown', (e) => {
      try {
        this.layer.setPointerCapture(e.pointerId);
      } catch {
        /* already gone */
      }
      g.pointerDown(e.pointerId, e.clientX, e.clientY, e.timeStamp);
      e.preventDefault();
    });
    this.layer.addEventListener('pointermove', (e) => g.pointerMove(e.pointerId, e.clientX, e.clientY));
    this.layer.addEventListener('pointerup', (e) => g.pointerUp(e.pointerId, e.timeStamp));
    this.layer.addEventListener('pointercancel', (e) => g.cancel(e.pointerId));
    this.layer.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.appendChild(this.layer);

    this.chipsEl.className = 'touch-chips captain-chips';
    const chip = (label: string, onTap: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = 'touch-btn touch-chip';
      b.innerHTML = '<b></b>';
      b.firstChild!.textContent = label;
      b.addEventListener('click', onTap);
      this.chipsEl.appendChild(b);
      return b;
    };
    chip('⚙', () => chips.menu());
    chip('\u{1F3A4}', () => chips.mic());
    this.allChip = chip('ALL', () => (this.selectAll = true));
    this.watchChip = chip('WATCH', () => (this.posting = !this.posting));
    chip('ROUNDS', () => (this.dismiss = true));
    document.body.appendChild(this.chipsEl);
    ctx.hud.message('Drag to look round the castle, pinch to zoom. Tap guards to pick them out, then tap where to search.');
  }

  dispose(): void {
    this.layer.remove();
    this.chipsEl.remove();
    this.marker.dispose();
    this.ctx.hud.onCall = null;
  }

  read(): CaptainIntent {
    const { intent, view, gestures: g } = this;
    const vp = pageViewport(this.rig.camera.fov);
    stillCaptain(intent);
    if (this.arm !== null) {
      intent.arm = this.arm;
      this.arm = null;
    }
    intent.selectAll = this.selectAll;
    intent.dismiss = this.dismiss;
    this.selectAll = this.dismiss = false;
    g.update(performance.now());
    const f = g.frame;
    if (this.ctx.settings.open) {
      g.clear();
      g.endFrame();
      return intent;
    }
    if (f.drag) view.drag(f.drag.fromX, f.drag.fromY, f.drag.toX, f.drag.toY, vp);
    if (f.pinch) {
      view.zoom(1 / f.pinch.scale, f.pinch.x, f.pinch.y, vp);
      if (Math.abs(f.pinch.turn) > 0.001) view.turn(-f.pinch.turn, f.pinch.x, f.pinch.y, vp);
    }
    const tap = f.taps.at(-1);
    const hold = f.holds.at(-1);
    const at = tap ?? hold;
    if (at) {
      const ground = view.groundAt(at.x, at.y, vp);
      if (ground) {
        this.pointer = { x: ground.x, y: ground.y };
        if (tap && this.posting && this.role.selected.size && this.role.armed === null && !this.onGuard(ground.x, ground.y)) {
          intent.post = true;
          this.posting = false;
        } else if (tap) intent.primary = true;
        else intent.gather = true;
      }
    }
    intent.pointer = this.pointer;
    intent.focus.x = view.x;
    intent.focus.y = view.y;
    intent.reach = Math.max(1.8, view.distance * 0.045);
    g.endFrame();
    return intent;
  }

  /** Whether a tap there is on one of the guards (picking them out), not the ground. */
  private onGuard(x: number, y: number): boolean {
    const reach = Math.max(1.8, this.view.distance * 0.045);
    return this.role.guards().some((g) => Math.hypot(g.x - x, g.y - y) < reach);
  }

  present(): void {
    const { ctx, role, view } = this;
    view.apply(this.rig);
    this.marker.update(this.pointer, role, Math.max(1, view.distance / 30));
    listenOverMap(ctx);
    ctx.hud.showCaptain(ctx, role, { ...KEYS, send: this.posting ? 'Tap where they should stand watch' : KEYS.send }, ctx.now < this.refusal.until ? this.refusal.text : '');
    const all = role.guards();
    const label = all.length && all.every((g) => role.selected.has(g.id)) ? 'NONE' : 'ALL';
    if (this.allChip.firstChild!.textContent !== label) this.allChip.firstChild!.textContent = label;
    this.watchChip.classList.toggle('on', this.posting);
  }

  used(call: Call): void {
    captainUsed(this.ctx, call);
    navigator.vibrate?.(20);
  }

  refused(reason: string): void {
    this.refusal = { text: reason, until: this.ctx.now + REFUSAL_MS };
    this.ctx.sfx.play('nope');
    navigator.vibrate?.([15, 40, 15]);
  }

  ordered(x: number, y: number, kind: OrderKind): void {
    this.marker.ping(x, y, kind);
    navigator.vibrate?.(10);
  }
}
