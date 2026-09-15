import type { AvatarFrontend, AvatarSim } from './avatar';
import { direction, type GameContext, type Vec3 } from './context';
import { DesktopTool } from './desktopTool';
import type { DesktopInput } from './input';
import { idleIntent, type AvatarIntent, type Side } from './intent';
import type { MinimapFeed } from './minimap';
import { Platform } from './platform';
import type { Rig } from './rig';
import type { Tool, UseEffect } from './tool';

const MOUSE_SENSITIVITY = 0.0022;

/**
 * Keyboard and mouse. First person with a crosshair: tools are used from your eyes through the middle of
 * the screen, and effects such as tracers leave the tool model. Number keys and the wheel pick the tool.
 * V swaps to a chase camera while driving, and when you die the camera circles your body.
 */
export class DesktopAvatar implements AvatarFrontend {
  readonly platform = Platform.Desktop;
  thirdPerson = false;
  private deathOrbit = 0;
  private readonly intent = idleIntent();
  private readonly held: DesktopTool;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: GameContext,
    private readonly sim: AvatarSim,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
    private readonly minimap: MinimapFeed,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
  }

  get showSelf(): boolean {
    const s = this.sim.me?.state;
    return !!s && (s.hp === 0 || (s.car !== 0 && this.thirdPerson));
  }

  dispose(): void {
    this.held.dispose();
  }

  read(): AvatarIntent {
    const { input: k, intent, sim } = this;
    const key = (code: string) => (k.down(code) ? 1 : 0);
    const [dx, dy] = k.consumeMouse();
    intent.turn = dx * MOUSE_SENSITIVITY;
    intent.lookUp = -dy * MOUSE_SENSITIVITY;
    intent.strafe = key('KeyD') - key('KeyA');
    intent.forward = key('KeyW') - key('KeyS');
    intent.run = k.down('ShiftLeft') || k.down('ShiftRight');
    intent.jump = k.pressed('Space');
    intent.brake = k.down('Space');
    intent.horn = k.pressed('KeyH');
    intent.interact = k.pressed('KeyF') || k.pressed('KeyE');
    intent.trigger = k.locked && k.mouse(0);
    intent.cycleTool = Math.sign(k.wheel());
    intent.selectTool = null;
    const tools = sim.inventory.tools.all;
    for (let i = 0; i < tools.length && i < 9; i++) if (k.pressed(`Digit${i + 1}`)) intent.selectTool = tools[i];
    if (sim.driving && k.pressed('KeyV')) this.thirdPerson = !this.thirdPerson;
    this.held.setTool(sim.inventory.current);
    intent.tip = this.thirdPerson && sim.me?.state.car ? null : this.held.tipWorld(this.tip);
    return intent;
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    const s = sim.me?.state;
    if (!s) return;
    const car = s.car ? sim.currentCar : undefined;
    const alive = s.hp > 0;
    if (!alive) {
      this.deathOrbit += dt * 0.4;
      rig.setDesktopChase({ x: s.x + Math.cos(this.deathOrbit) * 4, y: s.y + Math.sin(this.deathOrbit) * 4, z: 3.5 }, { x: s.x, y: s.y, z: 0.3 });
    } else if (car && this.thirdPerson) {
      const a = car.state.angle;
      const back = Math.max(2, Math.min(8, ctx.city.raycast(car.state.x, car.state.y, a + Math.PI, 8) - 0.6));
      rig.setDesktopChase(
        { x: car.state.x - Math.cos(a) * back, y: car.state.y - Math.sin(a) * back, z: 3.2 },
        { x: car.state.x + Math.cos(a) * 4, y: car.state.y + Math.sin(a) * 4, z: 1.2 },
      );
    } else {
      const e = sim.eyePosition(this.tmp);
      rig.setDesktopView(e.x, e.y, e.z, sim.heading, sim.pitch);
    }
    rig.setTint(0x550000, alive ? 0 : 0.3);
    this.held.setTool(sim.inventory.current);
    this.held.update(dt, alive && !(car && this.thirdPerson));
    ctx.sfx.setListener(rig.head(this.tmp), direction(sim.heading, sim.pitch, this.dir));
    ctx.hud.showAvatar(sim, 'F');
    if (this.minimap.fresh) ctx.hud.updateMinimap(s.x, s.y, sim.heading, this.minimap.dots);
  }

  moved(): void {}

  placed(): void {}

  seated(): void {}

  hurt(): void {
    this.ctx.hud.hurt();
    this.rig.shake(0.05);
  }

  used(_side: Side | null, _tool: Tool, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    if (effect.hit && effect.hit !== 'miss') this.ctx.hud.hitMarker(effect.hit === 'head');
  }

  died(): void {
    this.deathOrbit = this.sim.heading + Math.PI;
  }
}
