import * as THREE from 'three';
import { EntityViews, NetDebugPanel, type NetWorld } from '@engine/index';
import { AvatarSim, type AvatarFrontend } from './avatar';
import type { City } from './city';
import { buildCity } from './cityMesh';
import { registerCombat } from './combat';
import type { GameContext } from './context';
import { Car, CarMode } from './defs';
import { DesktopAvatar } from './desktopAvatar';
import { Effects } from './effects';
import type { Hud } from './hud';
import { DesktopInput } from './input';
import type { AvatarIntent } from './intent';
import { MinimapFeed } from './minimap';
import { updateOwnedPeds } from './peds';
import { updateOwnedCops } from './police';
import { Rig, WebXrPoses } from './rig';
import { Seat } from './role';
import type { Sfx } from './sfx';
import { Spawner } from './spawner';
import { registerViews } from './views';
import { updateOwnedCars } from './vehicles';
import { VrAvatar } from './vrAvatar';
import { SimulatedXr } from './xrsim';

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

/** How long without an animation frame before the game keeps itself running on a timer. */
const STALLED_MS = 200;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: Rig;
  readonly input: DesktopInput;
  readonly ctx: GameContext;
  readonly avatar: AvatarSim;
  /** The local player: the avatar role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<AvatarIntent, AvatarFrontend>;
  private readonly simulateXr: boolean;
  private readonly minimap: MinimapFeed;
  private readonly views: EntityViews;
  private readonly spawner: Spawner;
  private readonly debug: NetDebugPanel;
  private readonly sky: THREE.Mesh;
  private readonly vrButton = document.getElementById('vr-enter') as HTMLButtonElement;
  private readonly head = { x: 0, y: 0, z: 0 };
  private last = performance.now();

  static async vrSupported(): Promise<boolean> {
    try {
      return (await navigator.xr?.isSessionSupported('immersive-vr')) ?? false;
    } catch {
      return false;
    }
  }

  constructor(deps: GameDeps) {
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
      me: null,
      playerName: deps.playerName,
      now: performance.now(),
    };
    this.simulateXr = deps.sim;
    this.avatar = new AvatarSim(this.ctx);
    this.minimap = new MinimapFeed(this.ctx);
    this.views = new EntityViews(world);
    registerViews(this.ctx, this.views, { showSelf: () => this.seat.frontend.showSelf, steer: () => this.avatar.steer });
    registerCombat(this.ctx, this.avatar);
    this.spawner = new Spawner(this.ctx);

    world.setTransferPolicy(Car, (car) => !car.held && car.state.mode !== CarMode.Wrecked);
    world.on('peerJoined', () => hud.message('A player connected nearby'));
    this.avatar.spawn();
    this.seat = new Seat<AvatarIntent, AvatarFrontend>(this.avatar, () => this.frontend());

    this.debug = new NetDebugPanel(world, document.body, deps.netLabel);
    this.debug.visible = new URLSearchParams(location.search).has('debug');

    window.addEventListener('resize', () => this.resize());
    this.input.onLockChange = () => this.showLockPrompt();
    this.renderer.xr.addEventListener('sessionstart', () => this.onSessionStart());
    this.renderer.xr.addEventListener('sessionend', () => this.onSessionEnd());
    this.showLockPrompt();
    hud.show();
    hud.message(`Welcome to Peer City 3D, ${deps.playerName}`);

    void Game.vrSupported().then((ok) => (this.vrButton.hidden = !ok));
    this.vrButton.addEventListener('click', () => {
      this.enterVR().catch((err: unknown) => hud.message(`Couldn't start VR: ${errorText(err)}`));
    });

    // Browsers stop animation frames in background tabs. A peer that stops ticking would freeze the NPCs
    // it owns for everyone nearby, so whenever frames stop coming, keep simulating on a (throttled) timer.
    window.setInterval(() => {
      if (performance.now() - this.last >= STALLED_MS) this.tick(250, false);
    }, 100);

    // setAnimationLoop (not requestAnimationFrame) so the loop keeps running on the headset's clock.
    this.renderer.setAnimationLoop(() => {
      this.tick(50, true);
      this.renderer.render(this.scene, this.rig.camera);
    });
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

  /** A frontend for how this page is being played right now. */
  private frontend(): AvatarFrontend {
    const { ctx, avatar, rig, minimap } = this;
    if (this.renderer.xr.isPresenting) return new VrAvatar(ctx, avatar, rig, new WebXrPoses(this.renderer.xr), minimap);
    if (this.simulateXr) return new VrAvatar(ctx, avatar, rig, new SimulatedXr(this.input), minimap);
    return new DesktopAvatar(ctx, avatar, this.input, rig, minimap);
  }

  private onSessionStart(): void {
    this.vrButton.hidden = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.seat.use(() => this.frontend());
    this.showLockPrompt();
  }

  private onSessionEnd(): void {
    this.rig.floorY = 0;
    this.vrButton.hidden = false;
    this.seat.use(() => this.frontend());
    this.showLockPrompt();
  }

  /** The page's "click to play" prompt and crosshair, which a headset can't see. */
  private showLockPrompt(): void {
    this.ctx.hud.setLocked(this.input.locked, this.renderer.xr.isPresenting);
  }

  private resize(): void {
    if (this.renderer.xr.isPresenting) return;
    this.rig.camera.aspect = window.innerWidth / window.innerHeight;
    this.rig.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Advance by the time since the last tick, at most `maxMs`. */
  private tick(maxMs: number, visible: boolean): void {
    const now = performance.now();
    const dt = Math.min(now - this.last, maxMs) / 1000;
    this.last = now;
    this.step(dt, visible);
    this.input.endFrame();
  }

  private step(dt: number, visible: boolean): void {
    const { ctx, rig } = this;
    ctx.now = performance.now();

    ctx.world.update(ctx.now);
    this.seat.step(dt);
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
    ctx.hud.tick(ctx.now);
    this.minimap.update();
    this.seat.present(dt);
    rig.update(dt);
    ctx.fx.update(dt);
    const head = rig.head(this.head);
    this.sky.position.set(head.x, 0, head.y);
    this.debug.update(ctx.now);

    // global keys, whatever the platform
    if (this.input.pressed('Backquote')) this.debug.visible = !this.debug.visible;
    if (this.input.pressed('KeyN')) {
      ctx.sfx.muted = !ctx.sfx.muted;
      ctx.hud.message(ctx.sfx.muted ? 'Sound off' : 'Sound on');
    }
  }
}
