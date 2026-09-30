import { readMouseLook, readWalking } from '../crossplay/desktopControls';
import type { DesktopInput } from '../crossplay/input';
import { stillIntent, type Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import { direction, type HiContext, type Vec3 } from './context';
import { FirstPersonHands } from './hands';
import type { PalKeys } from './hud';
import { idlePalIntent, stillPal, type PalIntent } from './intent';
import { skinTone } from './models';
import { Move } from './moves';
import type { PalFrontend, PalRole } from './pal';

export const DESKTOP_KEYS: PalKeys = {
  moves: { [Move.None]: '', [Move.High]: '1', [Move.Low]: '2', [Move.Fist]: '3', [Move.Double]: '4' },
  slap: 'F',
  sneak: 'hold C',
};

const HELP =
  '<b>WASD</b> move · <b>Mouse</b> look · <b>1</b> / <b>click</b> up high · <b>2</b> / <b>right-click</b> down low · <b>3</b> fist bump · <b>4</b> double · <b>Q</b> pull it away · <b>F</b> slap · <b>C</b> sneak · <b>Space</b> jump · <b>Esc</b> settings · <b>V</b> mic';

const MOVE_KEYS: [string, Move][] = [
  ['Digit1', Move.High],
  ['Digit2', Move.Low],
  ['Digit3', Move.Fist],
  ['Digit4', Move.Double],
];

/**
 * Keyboard and mouse: first person, your own hands in front of you. A number key (or a click) holds a move out, or at
 * someone holding one out, swings at it: press as the closing ring meets the target round the crosshair.
 */
export class DesktopPal implements PalFrontend {
  readonly platform = Platform.Desktop;
  readonly showSelf = false;
  private readonly intent = idlePalIntent();
  private readonly hands: FirstPersonHands;
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: HiContext,
    private readonly sim: PalRole,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
  ) {
    rig.setMode('desktop');
    this.hands = new FirstPersonHands(rig, skinTone(ctx.me?.state.skin ?? 0));
  }

  dispose(): void {
    this.hands.dispose();
  }

  read(): PalIntent {
    const { input: k, intent } = this;
    stillPal(stillIntent(intent));
    if (this.ctx.settings.open) {
      k.consumeMouse(); // the menu has the mouse
      return intent;
    }
    readMouseLook(k, intent);
    readWalking(k, intent);
    intent.crouch = k.down('KeyC') || k.down('ControlLeft');
    for (const [code, move] of MOVE_KEYS) if (k.pressed(code)) intent.move = move;
    if (k.locked && k.pressed('Mouse0')) intent.move = Move.High;
    if (k.locked && k.pressed('Mouse2')) intent.move = Move.Low;
    intent.yank = k.pressed('KeyQ');
    intent.slap = k.pressed('KeyF');
    return intent;
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    if (!sim.me) return;
    const e = sim.eyePosition(this.tmp);
    rig.setDesktopView(e.x, e.y, e.z, sim.heading, sim.pitch);
    this.hands.update(dt, sim, ctx.now);
    ctx.sfx.setListener(rig.head(this.tmp), direction(sim.heading, sim.pitch, this.dir));
    ctx.hud.showPal(ctx, sim, DESKTOP_KEYS, HELP);
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {}

  used(): void {}

  died(): void {}

  smacked(_side: Side | null, strength: number): void {
    this.rig.shake(0.03 * strength);
  }
}
