import * as THREE from 'three';
import { readMouseLook, readWalking } from '../crossplay/desktopControls';
import { DesktopTool } from '../crossplay/desktopTool';
import type { DesktopInput } from '../crossplay/input';
import { idleIntent, stillIntent, type AvatarIntent, type Side } from '../crossplay/intent';
import { toolMesh } from '../crossplay/models';
import { Platform } from '../crossplay/platform';
import type { Rig } from '../crossplay/rig';
import type { Tool, UseEffect } from '../crossplay/tool';
import { direction, type Vec3, type WildsContext } from './context';
import { mapDots } from './hud';
import { AXE, BOW, HOE } from './kit';
import { BowString } from './models';
import type { Survivor, SurvivorFrontend } from './survivor';

const VIEW_SCALE = new Map<Tool<any>, number>([
  [BOW, 0.3],
  [AXE, 0.5],
  [HOE, 0.42],
]);
const pull = new THREE.Vector3();

/**
 * Keyboard and mouse. First person with a crosshair: click to swing the axe or till, hold to draw the bow and
 * let go to shoot, click to eat, sow or build a fire, E to pull a ripe crop, C to crouch and sneak up on
 * animals. Number keys and the wheel pick the tool. When you die the camera circles your body.
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
    ctx.hud.message('Seeds, food and logs go in your pack: press B to open it and take something out');
  }

  get showSelf(): boolean {
    return !this.sim.alive;
  }

  dispose(): void {
    this.ctx.hud.setPack(null);
    this.held.dispose();
    this.string.dispose();
  }

  read(): AvatarIntent {
    const { input: k, intent, sim } = this;
    readMouseLook(k, intent);
    readWalking(k, intent);
    intent.crouch = k.down('KeyC') || k.down('ControlLeft');
    intent.interact = k.pressed('KeyE') || k.pressed('KeyF');
    intent.trigger = k.locked && k.mouse(0);
    intent.cycleTool = Math.sign(k.wheel());
    intent.selectTool = null;
    // the number keys are what you keep to hand; the rest is in the pack
    const tools = sim.inventory.toHand();
    for (let i = 0; i < tools.length && i < 9; i++) if (k.pressed(`Digit${i + 1}`)) intent.selectTool = tools[i];
    if (k.pressed('KeyB') && !this.ctx.settings.open) this.setPack(!this.ctx.hud.packOpen);
    if (this.ctx.hud.packOpen || this.ctx.settings.open) this.standStill();
    this.held.setTool(sim.inventory.current);
    intent.tip = this.held.tipWorld(this.tip);
    return intent;
  }

  /** Open the pack (which needs the mouse back) or close it (which takes it again). */
  private setPack(open: boolean): void {
    this.ctx.hud.setPack(open ? this.sim.inventory : null);
    if (open) document.exitPointerLock();
    else this.input.requestLock();
  }

  /** While a panel is open (the pack, the settings menu) you stand still and don't use anything: the mouse belongs to it. */
  private standStill(): void {
    stillIntent(this.intent);
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
