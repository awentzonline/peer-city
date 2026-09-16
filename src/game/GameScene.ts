import Phaser from 'phaser';
import { EntityViews } from '@engine/views/EntityViews';
import { NetDebugPanel } from '@engine/ui/NetDebugPanel';
import type { NetWorld } from '@engine/index';
import { TILE, type City } from './city';
import { registerCombat } from './combat';
import type { GameContext } from './context';
import { Car, CarKind, CarMode, Ped, PedMode, Pickup, Player } from './defs';
import { Effects } from './effects';
import type { Hud, MinimapDot } from './hud';
import { updateOwnedPeds } from './peds';
import { PlayerController } from './player';
import { updateOwnedCops } from './police';
import type { Sfx } from './sfx';
import { Spawner } from './spawner';
import { TILE_MARGIN, TILE_SPACING, buildTextures } from './textures';
import { registerViews } from './views';
import { updateOwnedCars } from './vehicles';

export interface SceneDeps {
  world: NetWorld;
  city: City;
  hud: Hud;
  sfx: Sfx;
  playerName: string;
  netLabel: string;
}

export class GameScene extends Phaser.Scene {
  private ctx!: GameContext;
  private views!: EntityViews;
  private player!: PlayerController;
  private spawner!: Spawner;
  private debug!: NetDebugPanel;
  private nextMinimap = 0;
  private camX = 0;
  private camY = 0;

  constructor(private readonly deps: SceneDeps) {
    super('game');
  }

  create(): void {
    const { world, city, hud, sfx, playerName } = this.deps;
    buildTextures(this);

    const ground = this.make.tilemap({ data: city.ground, tileWidth: TILE, tileHeight: TILE });
    const groundTiles = ground.addTilesetImage('tiles', 'tiles', TILE, TILE, TILE_MARGIN, TILE_SPACING)!;
    ground.createLayer(0, groundTiles, 0, 0)!.setDepth(0);
    const shadows = this.make.tilemap({ data: city.shadows, tileWidth: TILE, tileHeight: TILE });
    const shadowTiles = shadows.addTilesetImage('tiles', 'tiles', TILE, TILE, TILE_MARGIN, TILE_SPACING)!;
    shadows.createLayer(0, shadowTiles, 0, 0)!.setDepth(1);

    this.ctx = { world, city, hud, sfx, playerName, scene: this, fx: new Effects(this), me: null, now: performance.now() };
    this.views = new EntityViews(world);
    registerViews(this.ctx, this.views);
    this.player = new PlayerController(this.ctx);
    registerCombat(this.ctx, this.player);
    this.spawner = new Spawner(this.ctx);

    world.setTransferPolicy(Car, (car) => !car.held && car.state.mode !== CarMode.Wrecked);
    world.on('peerJoined', () => hud.message('A player connected nearby'));

    const cam = this.cameras.main;
    cam.setBounds(0, 0, city.pixelWidth, city.pixelHeight);
    this.player.spawn();
    const me = this.ctx.me!;
    this.camX = me.state.x;
    this.camY = me.state.y;
    cam.centerOn(this.camX, this.camY);

    this.debug = new NetDebugPanel(world, document.body, this.deps.netLabel);
    this.debug.visible = new URLSearchParams(location.search).has('debug');
    this.input.keyboard!.on('keydown-BACKTICK', () => (this.debug.visible = !this.debug.visible));
    this.input.keyboard!.on('keydown-N', () => {
      sfx.muted = !sfx.muted;
      hud.message(sfx.muted ? 'Sound off' : 'Sound on');
    });
    this.input.mouse?.disableContextMenu();
    hud.show();
    hud.message(`Welcome to Peer City, ${playerName}`);

    // Browsers stop requestAnimationFrame in background tabs. A peer that stops
    // ticking would freeze the NPCs it owns for everyone nearby, so keep the
    // simulation and network running on a (throttled) timer while hidden.
    let last = performance.now();
    const backgroundTick = window.setInterval(() => {
      const now = performance.now();
      if (document.hidden) this.step(Math.min(now - last, 250) / 1000, false);
      last = now;
    }, 100);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      clearInterval(backgroundTick);
      this.views.dispose();
      this.debug.dispose();
      world.dispose();
    });
  }

  update(_time: number, delta: number): void {
    this.step(Math.min(delta, 50) / 1000, true);
  }

  private step(dt: number, visible: boolean): void {
    const ctx = this.ctx;
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
    ctx.fx.update(dt);
    this.updateCamera(dt);
    this.debug.update(ctx.now);

    if (ctx.now >= this.nextMinimap) {
      this.nextMinimap = ctx.now + 100;
      this.drawMinimap();
    }
  }

  private updateCamera(dt: number): void {
    const me = this.ctx.me;
    if (!me) return;
    const cam = this.cameras.main;
    const car = this.player.currentCar;
    const speed = car ? Math.abs(car.state.speed) : 0;
    // look ahead in the direction of travel when driving
    const lead = car ? Math.min(speed, 500) * 0.35 : 0;
    const tx = me.state.x + (car ? Math.cos(car.state.angle) * lead : 0);
    const ty = me.state.y + (car ? Math.sin(car.state.angle) * lead : 0);
    const k = 1 - Math.exp(-dt * 6);
    this.camX += (tx - this.camX) * k;
    this.camY += (ty - this.camY) * k;
    cam.centerOn(this.camX, this.camY);
    const targetZoom = car ? 1 - Math.min(speed, 600) / 1600 : 1;
    cam.setZoom(cam.zoom + (targetZoom - cam.zoom) * (1 - Math.exp(-dt * 2)));
    this.ctx.sfx.listenerX = me.state.x;
    this.ctx.sfx.listenerY = me.state.y;
  }

  private drawMinimap(): void {
    const { world, me, hud } = this.ctx;
    if (!me) return;
    const dots: MinimapDot[] = [];
    const flash = Math.floor(this.ctx.now / 250) % 2 ? '#ff3b3b' : '#3b7bff';
    for (const c of world.all(Car)) {
      if (c.state.kind === CarKind.Police && c.state.mode === CarMode.Chase) dots.push({ x: c.x, y: c.y, color: flash, size: 3 });
    }
    for (const p of world.all(Ped)) if (p.state.cop && p.state.mode === PedMode.Attack) dots.push({ x: p.x, y: p.y, color: flash, size: 2 });
    for (const p of world.all(Pickup)) dots.push({ x: p.x, y: p.y, color: '#6eff7a', size: 2 });
    for (const p of world.all(Player)) if (p !== me && p.state.hp > 0) dots.push({ x: p.x, y: p.y, color: '#4fc3ff', size: 4 });
    // peers we're connected to but whose avatars are out of range still show at the rim
    for (const f of world.peerFoci()) dots.push({ x: f.x, y: f.y, color: 'rgba(79,195,255,0.6)', size: 3 });
    const angle = this.player.currentCar?.state.angle ?? me.state.angle;
    hud.drawMinimap(me.state.x, me.state.y, angle, dots);
  }
}
