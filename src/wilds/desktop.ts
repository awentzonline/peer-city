import * as THREE from 'three';
import { DesktopTool } from '../crossplay/desktopTool';
import type { DesktopInput } from '../crossplay/input';
import { idleIntent, type AvatarIntent, type Side } from '../crossplay/intent';
import { toolMesh } from '../crossplay/models';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import { direction, type Vec3, type WildsContext } from './context';
import { mapDots } from './hud';
import { AXE, BOW, HOE } from './kit';
import { BowString } from './models';
import type { Survivor, SurvivorFrontend } from './survivor';

const MOUSE_SENSITIVITY = 0.0022;
const VIEW_SCALE = new Map<Tool<any>, number>([
  [BOW, 0.3],
  [AXE, 0.5],
  [HOE, 0.42],
]);
const pull = new THREE.Vector3();

/**
 * Keyboard and mouse. First person with a crosshair: click to swing the axe or till, hold to draw the bow and
 * let go to shoot, click to eat, sow or build a fire, E to pull a ripe crop. Number keys and the wheel pick
 * the tool. When you die the camera circles your body.
 */
export class DesktopSurvivor implements SurvivorFrontend {
  readonly platform = Platform.Desktop;
  private deathOrbit = 0;
  private nextMap = 0;
  private readonly intent = idleIntent();
  private readonly held: DesktopTool;
  private readonly string: BowString;
  private readonly tip: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly tmp: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly ctx: WildsContext,
    private readonly sim: Survivor,
    private readonly input: DesktopInput,
    private readonly rig: Rig,
    scene: THREE.Scene,
  ) {
    rig.setMode('desktop');
    this.held = new DesktopTool(rig);
    this.string = new BowString(scene);
  }

  get showSelf(): boolean {
    return !this.sim.alive;
  }

  dispose(): void {
    this.held.dispose();
    this.string.dispose();
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
    intent.interact = k.pressed('KeyE') || k.pressed('KeyF');
    intent.trigger = k.locked && k.mouse(0);
    intent.cycleTool = Math.sign(k.wheel());
    intent.selectTool = null;
    const tools = sim.inventory.tools.all;
    for (let i = 0; i < tools.length && i < 9; i++) if (k.pressed(`Digit${i + 1}`)) intent.selectTool = tools[i];
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    return intent;
  }

  present(dt: number): void {
    const { ctx, rig, sim } = this;
    const s = sim.me?.state;
    if (!s) return;
    const alive = s.hp > 0;
    if (!alive) {
      this.deathOrbit += dt * 0.4;
      const ground = ctx.land.heightAt(s.x, s.y);
      rig.setDesktopChase(
        { x: s.x + Math.cos(this.deathOrbit) * 4, y: s.y + Math.sin(this.deathOrbit) * 4, z: ground + 3.5 },
        { x: s.x, y: s.y, z: ground + 0.3 },
      );
    } else {
      const e = sim.eyePosition(this.tmp);
      rig.setDesktopView(e.x, e.y, e.z, sim.heading, sim.pitch);
    }
    rig.setTint(0x550000, alive ? 0 : 0.3);
    const tool = sim.inventory.current;
    this.held.setTool(tool);
    this.held.update(dt, alive);

    // Long tools are shrunk to fit the view (the held tool's size suits a pistol); the bow is canted like an archer's.
    const model = this.held.model;
    model.scale.setScalar(tool ? (VIEW_SCALE.get(tool) ?? 0.7) : 0.7);
    model.rotation.z = tool === BOW ? 0.5 : 0;
    // draw the bow back towards you, string and all
    const bow = alive && tool === BOW ? model : null;
    if (bow) bow.position.z += s.draw * 0.08;
    rig.camera.updateMatrixWorld(true);
    const at = bow && s.draw > 0 ? toolMesh(bow).localToWorld(pull.set(0, 0, 0.13 + 0.5 * s.draw)) : null;
    this.string.update(bow, at, s.draw > 0);

    ctx.sfx.setListener(rig.head(this.tmp), direction(sim.heading, sim.pitch, this.dir));
    ctx.hud.showSurvivor(sim, ctx.day, false);
    if (ctx.now >= this.nextMap) {
      this.nextMap = ctx.now + 100;
      ctx.hud.updateMinimap(s.x, s.y, sim.heading, mapDots(ctx));
    }
  }

  moved(): void {}

  placed(): void {}

  hurt(): void {
    this.ctx.hud.hurt();
    this.rig.shake(0.05);
  }

  used(_side: Side | null, _tool: Tool<any>, effect: UseEffect): void {
    this.held.recoil(effect.kick);
    if (effect.hit && effect.hit !== 'miss') this.ctx.hud.hitMarker();
  }

  died(): void {
    this.deathOrbit = this.sim.heading + Math.PI;
  }
}
