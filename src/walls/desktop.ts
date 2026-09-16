import { DesktopTool } from '../crossplay/desktopTool';
import { readMouseLook, readWalking } from '../crossplay/desktopControls';
import type { DesktopInput } from '../crossplay/input';
import { stillIntent, type Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import { direction, type Vec3, type WallsContext } from './context';
import { idleWallsIntent, type WallsIntent } from './intent';
import { MARKER_PEN, PAINT_ROLLER, SPRAY_CAN } from './kit';
import type { Painter, PainterFrontend } from './painter';

/** Paint tools are held lower and further out than a gun, so the wall you're painting isn't behind them. */
export function lowerTool(held: DesktopTool): void {
  held.model.position.x += 0.05;
  held.model.position.y -= 0.08;
}

const HELP =
  '<b>WASD</b> move · <b>Mouse</b> look · <b>Hold click</b> paint · <b>1 2 3</b> spray / marker / roller · <b>Wheel</b> colour · <b>Q E</b> size · <b>C</b> crouch · <b>Esc</b> settings · <b>V</b> mic';

/**
 * Keyboard and mouse: first person with the tool held out in front, painting where the crosshair points while
 * the mouse button's down. How far you stand from the wall is how wide the spray goes.
 */
export class DesktopPainter implements PainterFrontend {
  readonly platform = Platform.Desktop;
  readonly showSelf = false;
  private readonly intent = idleWallsIntent();
  private readonly held: DesktopTool;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: WallsContext,
    private readonly sim: Painter,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
  }

  dispose(): void {
    this.held.dispose();
  }

  read(): WallsIntent {
    const { input: k, intent, sim } = this;
    const wheel = Math.sign(k.wheel());
    stillIntent(intent);
    Object.assign(intent, { color: null, cycleColor: 0, cycleSize: 0 });
    if (this.ctx.settings.open) {
      k.consumeMouse(); // the menu has the mouse
      return intent;
    }

    readMouseLook(k, intent);
    readWalking(k, intent);
    intent.crouch = k.down('KeyC') || k.down('ControlLeft');
    intent.trigger = k.locked && k.mouse(0);
    if (k.pressed('Digit1')) intent.selectTool = SPRAY_CAN;
    if (k.pressed('Digit2')) intent.selectTool = MARKER_PEN;
    if (k.pressed('Digit3')) intent.selectTool = PAINT_ROLLER;
    intent.cycleColor = wheel;
    intent.cycleSize = k.pressed('KeyE') ? 1 : k.pressed('KeyQ') ? -1 : 0;
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    return intent;
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    if (!sim.me) return;
    const e = sim.eyePosition(this.tmp);
    rig.setDesktopView(e.x, e.y, e.z, sim.heading, sim.pitch);
    this.held.setTool(sim.inventory.current);
    this.held.update(dt, true);
    lowerTool(this.held);
    ctx.sfx.setListener(rig.head(this.tmp), direction(sim.heading, sim.pitch, this.dir));
    ctx.hud.showPainter(ctx, sim, HELP);
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {}

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
  }

  died(): void {}
}
