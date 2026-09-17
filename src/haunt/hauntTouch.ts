import type * as THREE from 'three';
import { MapGestures } from '../crossplay/mapGestures';
import { OverheadView, pageViewport } from '../crossplay/overhead';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { TouchChips } from '../crossplay/shell';
import type { HauntContext } from './context';
import type { HauntFrontend, HauntRole } from './haunt';
import { HAUNT_VIEW, HauntMarker, hauntGlared, hauntUsed, listenAt } from './hauntDesktop';
import type { HauntKeys } from './hud';
import { idleHauntIntent, stillHaunt, type HauntIntent, type Power } from './intent';
import { START } from './manor';

const KEYS: HauntKeys = {
  place: 'Tap where it should come through, or its card again to put it away',
  pick: 'Tap your monsters to pick them out, hold to gather those nearby',
  send: 'Tap the ground',
  bar: '',
};

const REFUSAL_MS = 1800;

/**
 * The Haunt on a phone or tablet, where it's most at home: the house is a map under your fingers. Drag to move, pinch to
 * zoom and twist to turn. Tap a card, then tap the house to use it. Tap your monsters to pick them out (or hold on the
 * ground to gather every one nearby, or ALL), then tap where to send them, or tap a survivor you can see.
 */
export class TouchHaunt implements HauntFrontend {
  readonly platform = Platform.Touch;
  readonly view = new OverheadView(HAUNT_VIEW, { x: START.x, y: START.y + 26, distance: 70, heading: Math.PI / 2 });
  private readonly intent = idleHauntIntent();
  private readonly gestures = new MapGestures();
  private readonly layer = document.createElement('div');
  private readonly chipsEl = document.createElement('div');
  private readonly marker: HauntMarker;
  private arm: Power | 'none' | null = null;
  private selectAll = false;
  private pointer: { x: number; y: number } | null = null;
  private refusal = { text: '', until: 0 };
  private readonly allChip: HTMLButtonElement;

  constructor(
    private readonly ctx: HauntContext,
    private readonly role: HauntRole,
    private readonly rig: Rig,
    chips: TouchChips,
    scene: THREE.Scene,
  ) {
    rig.setMode('desktop');
    this.marker = new HauntMarker(ctx, scene);
    ctx.hud.onPower = (p) => (this.arm = p);

    // fingers on the map: the whole screen, under the HUD's cards
    this.layer.className = 'haunt-map';
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

    this.chipsEl.className = 'touch-chips haunt-chips';
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
    document.body.appendChild(this.chipsEl);
    ctx.hud.message('Drag to look round the house, pinch to zoom. Tap a card, then tap where it should come through.');
  }

  dispose(): void {
    this.layer.remove();
    this.chipsEl.remove();
    this.marker.dispose();
    this.ctx.hud.onPower = null;
  }

  read(): HauntIntent {
    const { intent, view, gestures: g } = this;
    const vp = pageViewport(this.rig.camera.fov);
    stillHaunt(intent);
    if (this.arm !== null) {
      intent.arm = this.arm;
      this.arm = null;
    }
    intent.selectAll = this.selectAll;
    this.selectAll = false;
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
        if (tap) intent.primary = true;
        else intent.gather = true;
      }
    }
    // a finger resting on the map is where the presence lingers
    const finger = g.finger;
    if (finger && !f.drag) {
      const ground = view.groundAt(finger.x, finger.y, vp);
      if (ground) this.pointer = { x: ground.x, y: ground.y };
    }
    intent.pointer = this.pointer;
    intent.focus.x = view.x;
    intent.focus.y = view.y;
    intent.reach = Math.max(1.8, view.distance * 0.045);
    g.endFrame();
    return intent;
  }

  present(): void {
    const { ctx, role, view } = this;
    view.apply(this.rig);
    this.marker.update(this.pointer, role, Math.max(1, view.distance / 30));
    listenAt(ctx, view.x, view.y, view.heading);
    ctx.hud.showHaunt(ctx, role, KEYS, ctx.now < this.refusal.until ? this.refusal.text : '');
    const all = role.mine();
    const label = all.length && all.every((m) => role.selected.has(m.id)) ? 'NONE' : 'ALL';
    if (this.allChip.firstChild!.textContent !== label) this.allChip.firstChild!.textContent = label;
  }

  used(power: Power): void {
    hauntUsed(this.ctx, power);
    navigator.vibrate?.(20);
  }

  refused(reason: string): void {
    this.refusal = { text: reason, until: this.ctx.now + REFUSAL_MS };
    this.ctx.sfx.play('nope');
    navigator.vibrate?.([15, 40, 15]);
  }

  ordered(x: number, y: number, attack: boolean): void {
    this.marker.ping(x, y, attack);
    navigator.vibrate?.(10);
  }

  glared(by: string): void {
    hauntGlared(this.ctx, this.rig, by);
    navigator.vibrate?.(200);
  }
}
