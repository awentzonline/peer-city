import * as THREE from 'three';
import { EntityViews, NetDebugPanel, type NetWorld } from '@engine/index';
import type { City } from './city';
import { buildCity } from './cityMesh';
import { registerCombat } from './combat';
import type { GameContext } from './context';
import { Car, CarKind, CarMode, Ped, PedMode, Pickup, Player } from './defs';
import { Effects } from './effects';
import { Hands } from './hands';
import type { Hud, MinimapDot } from './hud';
import { DesktopInput } from './input';
import { updateOwnedPeds } from './peds';
import { PlayerController } from './player';
import { updateOwnedCops } from './police';
import { Rig } from './rig';
import type { Sfx } from './sfx';
import { Spawner } from './spawner';
import { registerViews } from './views';
import { updateOwnedCars } from './vehicles';
import { VrHud } from './vrhud';

export interface GameDeps {
  world: NetWorld;
  city: City;
  hud: Hud;
  sfx: Sfx;
  playerName: string;
  netLabel: string;
  container: HTMLElement;
  /** Emulate a headset on desktop (?xrsim). */
  sim: boolean;
}

export const VR_SESSION_INIT: XRSessionInit = { optionalFeatures: ['local-floor', 'bounded-floor'] };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: Rig;
  readonly input: DesktopInput;
  readonly ctx: GameContext;
  readonly player: PlayerController;
  private readonly views: EntityViews;
  private readonly spawner: Spawner;
  private readonly vrHud: VrHud;
  private readonly debug: NetDebugPanel;
  private readonly sky: THREE.Mesh;
  private readonly vrButton = document.getElementById('vr-enter') as HTMLButtonElement;
  private readonly head = { x: 0, y: 0, z: 0 };
  private dots: MinimapDot[] = [];
  private nextMinimap = 0;
  private last = performance.now();

  static async vrSupported(): Promise<boolean> {
    try {
      return (await navigator.xr?.isSessionSupported('immersive-vr')) ?? false;
    } catch {
      return false;
    }
  }

  constructor(private readonly deps: GameDeps) {
    const { world, city, hud, sfx } = deps;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    deps.container.appendChild(this.renderer.domElement);

    this.rig = new Rig(this.scene, window.innerWidth / window.innerHeight);
    this.sky = buildCity(city, this.scene).sky;
    this.input = new DesktopInput(this.renderer.domElement);
    this.ctx = {
      world,
      city,
      sfx,
      hud,
      fx: new Effects(this.scene, this.rig),
      scene: this.scene,
      rig: this.rig,
      me: null,
      playerName: deps.playerName,
      now: performance.now(),
    };
    const hands = new Hands(this.rig);
    this.player = new PlayerController(this.ctx, this.input, hands);
    this.views = new EntityViews(world);
    registerViews(this.ctx, this.views, this.player);
    registerCombat(this.ctx, this.player);
    this.spawner = new Spawner(this.ctx);
    this.vrHud = new VrHud(this.rig, hud);

    world.setTransferPolicy(Car, (car) => !car.held && car.state.mode !== CarMode.Wrecked);
    world.on('peerJoined', () => hud.message('A player connected nearby'));
    this.player.spawn();

    this.debug = new NetDebugPanel(world, document.body, deps.netLabel);
    this.debug.visible = new URLSearchParams(location.search).has('debug');

    window.addEventListener('resize', () => this.resize());
    this.input.onLockChange = (locked) => hud.setLocked(locked, this.rig.mode === 'vr');
    this.renderer.xr.addEventListener('sessionstart', () => this.onSessionStart());
    this.renderer.xr.addEventListener('sessionend', () => this.onSessionEnd());
    if (deps.sim) this.rig.setMode('sim');
    hud.setLocked(false, false);
    hud.show();
    hud.message(`Welcome to Peer City 3D, ${deps.playerName}`);

    void Game.vrSupported().then((ok) => (this.vrButton.hidden = !ok));
    this.vrButton.addEventListener('click', () => {
      this.enterVR().catch((err: unknown) => hud.message(`Couldn't start VR: ${errorText(err)}`));
    });

    // Browsers stop requestAnimationFrame in background tabs. A peer that stops
    // ticking would freeze the NPCs it owns for everyone nearby, so keep the
    // simulation and network running on a (throttled) timer while hidden.
    let last = performance.now();
    window.setInterval(() => {
      const now = performance.now();
      if (document.hidden) this.step(Math.min(now - last, 250) / 1000, false);
      last = now;
    }, 100);

    // setAnimationLoop (not requestAnimationFrame) so the loop keeps running on the headset's clock.
    this.renderer.setAnimationLoop((_time, frame) => this.frame(frame));
  }

  /** Must be called from a user gesture. */
  enterVR(): Promise<void> {
    if (!navigator.xr) return Promise.reject(new Error('WebXR is not available in this browser'));
    return navigator.xr.requestSession('immersive-vr', VR_SESSION_INIT).then((session) => this.startSession(session));
  }

  async startSession(session: XRSession): Promise<void> {
    const features = (session as XRSession & { enabledFeatures?: readonly string[] }).enabledFeatures;
    const floor = !features || features.includes('local-floor');
    // A floor-level space puts your real floor on the street. Without one, assume standing height.
    this.rig.floorY = floor ? 0 : 1.6;
    this.renderer.xr.setReferenceSpaceType(floor ? 'local-floor' : 'local');
    await this.renderer.xr.setSession(session);
  }

  private onSessionStart(): void {
    this.rig.setMode('vr');
    this.vrButton.hidden = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.ctx.hud.setLocked(true, true);
    this.ctx.hud.message('VR: left stick move, right stick turn, triggers shoot, A enter car');
  }

  private onSessionEnd(): void {
    this.rig.floorY = 0;
    this.rig.setMode(this.deps.sim ? 'sim' : 'desktop');
    this.player.onLeaveVR();
    this.vrButton.hidden = false;
    this.ctx.hud.setLocked(this.input.locked, false);
  }

  private resize(): void {
    if (this.renderer.xr.isPresenting) return;
    this.rig.camera.aspect = window.innerWidth / window.innerHeight;
    this.rig.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private frame(xrFrame?: XRFrame): void {
    const now = performance.now();
    const dt = Math.min(now - this.last, 50) / 1000;
    this.last = now;
    if (this.rig.mode === 'vr') {
      const space = this.renderer.xr.getReferenceSpace();
      if (xrFrame && space) this.rig.readXR(xrFrame, space);
    } else if (this.rig.mode === 'sim') {
      this.rig.readSim(this.input, dt);
    }
    this.step(dt, true);
    this.input.endFrame();
    this.renderer.render(this.scene, this.rig.camera);
  }

  private step(dt: number, visible: boolean): void {
    const { ctx, rig } = this;
    ctx.now = performance.now();

    ctx.world.update(ctx.now);
    this.player.update(dt);
    // integrate long background steps in small slices so physics stays stable
    for (let left = dt; left > 0; left -= 0.05) {
      const slice = Math.min(left, 0.05);
      updateOwnedCars(ctx, slice);
      updateOwnedPeds(ctx, slice);
      updateOwnedCops(ctx, slice);
    }
    this.spawner.update();
    if (!visible) return;

    this.views.update(dt);
    this.player.updateView(dt);
    rig.update(dt);
    ctx.fx.update(dt);
    const head = rig.head(this.head);
    this.sky.position.set(head.x, 0, head.y);
    this.debug.update(ctx.now);
    ctx.hud.tick(ctx.now);

    if (this.input.pressed('Backquote')) this.debug.visible = !this.debug.visible;
    if (this.input.pressed('KeyN')) {
      ctx.sfx.muted = !ctx.sfx.muted;
      ctx.hud.message(ctx.sfx.muted ? 'Sound off' : 'Sound on');
    }

    const me = ctx.me;
    if (!me) return;
    if (ctx.now >= this.nextMinimap) {
      this.nextMinimap = ctx.now + 100;
      this.dots = this.minimapDots();
      if (rig.mode !== 'vr') ctx.hud.updateMinimap(me.state.x, me.state.y, this.player.viewHeading, this.dots);
    }
    this.vrHud.update(ctx.now, rig.xr, { x: me.state.x, y: me.state.y, heading: this.player.viewHeading, dots: this.dots });
  }

  private minimapDots(): MinimapDot[] {
    const { world, me, now } = this.ctx;
    const dots: MinimapDot[] = [];
    const flash = Math.floor(now / 250) % 2 ? '#ff3b3b' : '#3b7bff';
    for (const c of world.all(Car)) {
      if (c.state.kind === CarKind.Police && c.state.mode === CarMode.Chase) dots.push({ x: c.x, y: c.y, color: flash, size: 3 });
    }
    for (const p of world.all(Ped)) if (p.state.cop && p.state.mode === PedMode.Attack) dots.push({ x: p.x, y: p.y, color: flash, size: 2 });
    for (const p of world.all(Pickup)) dots.push({ x: p.x, y: p.y, color: '#6eff7a', size: 2 });
    for (const p of world.all(Player)) if (p !== me && p.state.hp > 0) dots.push({ x: p.x, y: p.y, color: '#4fc3ff', size: 4 });
    // peers we're connected to but whose avatars are out of range still show at the rim
    for (const f of world.peerFoci()) dots.push({ x: f.x, y: f.y, color: 'rgba(79,195,255,0.6)', size: 3 });
    return dots;
  }
}
