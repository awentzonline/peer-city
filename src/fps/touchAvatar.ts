import { DesktopTool } from '../crossplay/desktopTool';
import type { Side } from '../crossplay/intent';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import { FIRE } from '../crossplay/touch';
import { TouchControls, type TouchButtonSpec } from '../crossplay/touchControls';
import type { AvatarFrontend, AvatarSim } from './avatar';
import { direction, type GameContext, type Vec3 } from './context';
import { idleIntent, type AvatarIntent } from './intent';
import type { MinimapFeed } from './minimap';

/** Radians of view per pixel dragged; a touch drag covers much less screen than a mouse can. */
const LOOK = 0.0042;

const BUTTONS: TouchButtonSpec[] = [
  { id: FIRE, label: 'FIRE', big: true },
  { id: 'use', label: 'USE', hint: 'car' },
  { id: 'jump', label: 'JUMP' },
  { id: 'crouch', label: 'DUCK' },
  { id: 'cam', label: 'CAM', hidden: true },
  { id: 'horn', label: 'HORN', hidden: true },
  { id: 'menu', label: '⚙', kind: 'chip' },
  { id: 'mic', label: '\u{1F3A4}', kind: 'chip' },
];

/**
 * A phone or tablet. First person with a crosshair, like the desktop: the left thumb walks (pushed all the
 * way, it runs), the right thumb looks, and a tap where you're looking fires, so a second finger shoots
 * without leaving the aim. The buttons by the right thumb are the keys desktop has, and the strip up the
 * right edge is the number keys. Driving is third person by default, since a windscreen fills a small
 * screen with very little of the road.
 */
export class TouchAvatar implements AvatarFrontend {
  readonly platform = Platform.Touch;
  thirdPerson = true;
  private crouching = false;
  private deathOrbit = 0;
  private readonly intent = idleIntent();
  private readonly controls: TouchControls;
  private readonly held: DesktopTool;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: GameContext,
    private readonly sim: AvatarSim,
    private readonly rig: Rig,
    private readonly minimap: MinimapFeed,
    chips: { menu: () => void; mic: () => void },
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.controls = new TouchControls({
      buttons: BUTTONS,
      onChip: (id) => (id === 'menu' ? chips.menu() : chips.mic()),
    });
    ctx.hud.message('Left thumb walks, right thumb looks, tap to shoot. Tap a gun on the right to switch.');
  }

  get showSelf(): boolean {
    const s = this.sim.me?.state;
    return !!s && (s.hp === 0 || (s.car !== 0 && this.thirdPerson));
  }

  dispose(): void {
    this.controls.dispose();
    this.held.dispose();
  }

  /** Every press is read here, in one place, because `read` ends the input's frame. */
  read(): AvatarIntent {
    const { controls, intent, sim } = this;
    const t = controls.input;
    if (this.ctx.settings.open) {
      this.standStill();
      t.endFrame();
      return intent;
    }
    const [dx, dy] = t.consumeLook();
    intent.turn = dx * LOOK;
    intent.lookUp = -dy * LOOK;
    intent.strafe = t.stick.x;
    intent.forward = t.stick.y;
    intent.run = t.run;
    intent.jump = t.pressed('jump');
    intent.brake = t.down('jump');
    intent.horn = t.pressed('horn');
    intent.interact = t.pressed('use');
    // Holding FIRE keeps an automatic weapon going; a tap in the look zone is one shot.
    intent.trigger = t.down(FIRE) || t.pressed(FIRE);
    if (t.pressed('crouch')) this.crouching = !this.crouching;
    if (sim.driving) this.crouching = false;
    intent.crouch = this.crouching;
    intent.cycleTool = 0;
    intent.selectTool = null;
    const tools = sim.inventory.toHand();
    for (let i = 0; i < tools.length; i++) if (t.pressed(`slot${i}`)) intent.selectTool = tools[i];
    if (sim.driving && t.pressed('cam')) this.thirdPerson = !this.thirdPerson;
    this.held.setTool(sim.inventory.current);
    intent.tip = this.thirdPerson && sim.me?.state.car ? null : this.held.tipWorld(this.tip);
    t.endFrame();
    return intent;
  }

  /** While the settings menu is open you stand still and don't use anything: the screen belongs to it. */
  private standStill(): void {
    const { intent } = this;
    Object.assign(intent, { turn: 0, lookUp: 0, strafe: 0, forward: 0, run: false, jump: false, brake: false, horn: false, interact: false, trigger: false });
    intent.cycleTool = 0;
    intent.selectTool = null;
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
    ctx.hud.showAvatar(sim, 'USE');
    if (this.minimap.fresh) ctx.hud.updateMinimap(s.x, s.y, sim.heading, this.minimap.dots);
    this.showControls(alive, !!car);
  }

  /** The buttons say what they do here and now: the same button brakes in a car and jumps on foot. */
  private showControls(alive: boolean, driving: boolean): void {
    const { controls, sim } = this;
    controls.setActive(alive && !this.ctx.settings.open);
    if (!alive) return;
    controls.setLabel('jump', driving ? 'BRAKE' : 'JUMP', '');
    controls.setLabel('use', driving ? 'EXIT' : 'USE', driving ? 'car' : sim.nearCar ? 'take car' : '');
    controls.setVisible('crouch', !driving);
    controls.setVisible('cam', driving);
    controls.setVisible('horn', driving);
    controls.setVisible(FIRE, !driving);
    const inv = sim.inventory;
    controls.setSlots(driving ? [] : inv.toHand().map((tool) => ({ name: tool.name, charges: inv.charges(tool), current: tool === inv.current })));
  }

  moved(): void {}

  placed(): void {}

  seated(): void {}

  hurt(): void {
    this.ctx.hud.hurt();
    this.rig.shake(0.05);
    navigator.vibrate?.(30);
  }

  used(_side: Side | null, _tool: Tool, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    if (effect.hit && effect.hit !== 'miss') this.ctx.hud.hitMarker(effect.hit === 'head');
  }

  died(): void {
    this.deathOrbit = this.sim.heading + Math.PI;
    navigator.vibrate?.([60, 40, 120]);
  }
}
