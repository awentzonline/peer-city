import { stillIntent, type Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { TouchChips } from '../crossplay/shell';
import { TOUCH_TUNING } from '../crossplay/touch';
import { TouchControls, type TouchButtonSpec } from '../crossplay/touchControls';
import { direction, type HiContext, type Vec3 } from './context';
import { FirstPersonHands } from './hands';
import type { PalKeys } from './hud';
import { idlePalIntent, stillPal, type PalIntent } from './intent';
import { skinTone } from './models';
import { Move } from './moves';
import type { PalFrontend, PalRole } from './pal';
import { SwipePad } from './swipe';

const BUTTONS: TouchButtonSpec[] = [
  { id: 'slap', label: 'SLAP', hint: 'from behind', big: true },
  { id: 'sneak', label: 'SNEAK' },
  { id: 'jump', label: 'JUMP' },
  { id: 'yank', label: 'PULL', hint: 'it away', hidden: true },
  { id: 'menu', label: '⚙', kind: 'chip' },
  { id: 'mic', label: '\u{1F3A4}', kind: 'chip' },
];

export const TOUCH_KEYS: PalKeys = {
  moves: { [Move.None]: '', [Move.High]: 'swipe ↑', [Move.Low]: 'swipe ↓', [Move.Fist]: 'tap', [Move.Double]: 'swipe ↔' },
  slap: 'SLAP',
  sneak: 'SNEAK',
};

/**
 * A phone or tablet. The left thumb walks and the right drags the view. Five goes on the swipe pad: swipe up for up
 * high, down for down low, sideways for a double, tap for a fist bump. At someone holding one out it's a swing, graded
 * on the ring as your finger lifts. SLAP slaps a backside you're behind, SNEAK creeps up on it quietly.
 */
export class TouchPal implements PalFrontend {
  readonly platform = Platform.Touch;
  readonly showSelf = false;
  private readonly intent = idlePalIntent();
  private readonly controls: TouchControls;
  private readonly pad: SwipePad;
  private readonly hands: FirstPersonHands;
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private sneaking = false;

  constructor(
    private readonly ctx: HiContext,
    private readonly sim: PalRole,
    private readonly rig: Rig,
    chips: TouchChips,
  ) {
    rig.setMode('desktop');
    this.hands = new FirstPersonHands(rig, skinTone(ctx.me?.state.skin ?? 0));
    this.controls = new TouchControls({
      buttons: BUTTONS,
      onChip: (id) => (id === 'menu' ? chips.menu() : chips.mic()),
      tuning: { ...TOUCH_TUNING, tapToFire: false },
    });
    this.pad = new SwipePad();
    ctx.hud.message('Swipe the pad to give five: up high, down low, sideways for a double, tap for a fist bump.');
  }

  dispose(): void {
    this.controls.dispose();
    this.pad.dispose();
    this.hands.dispose();
  }

  read(): PalIntent {
    const { controls, intent } = this;
    const t = controls.input;
    stillPal(stillIntent(intent));
    if (this.ctx.settings.open) {
      this.pad.take();
      t.endFrame();
      return intent;
    }
    const [dx, dy] = t.consumeLook();
    intent.turn = dx * TOUCH_TUNING.look;
    intent.lookUp = -dy * TOUCH_TUNING.look;
    intent.strafe = t.stick.x;
    intent.forward = t.stick.y;
    intent.run = t.run && !this.sneaking;
    if (t.pressed('sneak')) {
      this.sneaking = !this.sneaking;
      this.ctx.sfx.play('click');
    }
    intent.crouch = this.sneaking;
    intent.jump = t.pressed('jump');
    intent.slap = t.pressed('slap');
    intent.yank = t.pressed('yank');
    intent.move = this.pad.take();
    t.endFrame();
    return intent;
  }

  present(dt: number): void {
    const { ctx, rig, sim, controls } = this;
    if (!sim.me) return;
    const e = sim.eyePosition(this.tmp);
    rig.setDesktopView(e.x, e.y, e.z, sim.heading, sim.pitch);
    this.hands.update(dt, sim, ctx.now);
    ctx.sfx.setListener(rig.head(this.tmp), direction(sim.heading, sim.pitch, this.dir));
    ctx.hud.showPal(ctx, sim, TOUCH_KEYS, '');
    const active = !ctx.settings.open;
    controls.setActive(active);
    this.pad.setActive(active);
    controls.setLabel('sneak', this.sneaking ? 'STAND' : 'SNEAK', this.sneaking ? 'up' : 'up on them');
    controls.setVisible('yank', sim.me.state.offer !== Move.None);
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {}

  used(): void {}

  died(): void {}

  smacked(_side: Side | null, strength: number): void {
    this.rig.shake(0.03 * strength);
    navigator.vibrate?.(Math.round(20 + strength * 30));
  }
}
