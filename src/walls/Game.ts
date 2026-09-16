import { EntityViews, type NetWorld } from '@engine/index';
import type { Launch } from '../crossplay/lobby';
import type { Seat } from '../crossplay/role';
import { Shell } from '../crossplay/shell';
import type { WallsContext } from './context';
import { Painter as PainterDef } from './defs';
import { DesktopPainter } from './desktop';
import { Effects } from './effects';
import type { Hud } from './hud';
import type { WallsIntent } from './intent';
import { Painter, type PainterFrontend } from './painter';
import { Scenery } from './scenery';
import type { Sfx } from './sfx';
import type { WallStore } from './store';
import { WallSync, type SavedTile } from './sync';
import { TouchPainter } from './touch';
import { registerViews } from './views';
import { VrPainter } from './vr';
import { buildSurfaces } from './yard';

/** How often the walls are kept in this browser while they're changing, ms. */
const AUTOSAVE_MS = 15_000;

export interface GameDeps {
  world: NetWorld;
  hud: Hud;
  sfx: Sfx;
  /** How the lobby started the game. `mode/shard` names the yard, here and in the store, and `loaded` is what the store had for it. */
  launch: Launch<SavedTile[] | null>;
  store: WallStore;
  /** How long to look for other painters before starting walls of your own, ms. */
  settleMs: number;
}

export class Game {
  readonly shell: Shell;
  readonly ctx: WallsContext;
  readonly painter: Painter;
  readonly seat: Seat<WallsIntent, PainterFrontend>;
  private readonly views: EntityViews;
  private readonly extraViews: { update(dt: number): void };
  private savedVersion = 0;
  private nextSave = 0;

  constructor(private readonly deps: GameDeps) {
    const { world, hud, sfx, launch } = deps;
    const shell = (this.shell = new Shell({
      world,
      sfx,
      launch,
      players: PainterDef,
      company: 'painters',
      announce: (text) => hud.message(text),
      showLock: (locked, platform) => hud.setLocked(locked, platform),
    }));
    const { rig, scene } = shell.stage;
    new Scenery(scene);
    const surfaces = buildSurfaces();
    const ctx: WallsContext = (this.ctx = {
      world,
      surfaces,
      sync: null as unknown as WallSync,
      sfx,
      hud,
      settings: shell.settings,
      fx: new Effects(scene),
      me: null,
      playerName: launch.playerName,
      now: performance.now(),
    });
    ctx.sync = new WallSync(
      {
        world,
        surfaces,
        me: () => ctx.me,
        now: () => performance.now(),
        wallClock: () => Date.now() / 1000,
        message: (text) => hud.message(text),
        saved: () => launch.loaded,
      },
      { settleMs: deps.settleMs, staleMs: 12_000 },
    );
    const painter = (this.painter = new Painter(ctx));
    this.views = new EntityViews(world);
    this.extraViews = registerViews(ctx, this.views, scene, { showSelf: () => this.seat.frontend.showSelf }, painter);

    world.on('entityAdded', (e) => {
      if (e.def !== PainterDef || e.mine) return;
      setTimeout(() => {
        const name = world.getAs(PainterDef, e.id)?.state.name;
        if (name) hud.message(`${name} is painting here`);
      }, 1500);
      sfx.play('join');
    });
    painter.spawn();
    this.seat = shell.seat<WallsIntent, PainterFrontend>(painter, {
      desktop: (input) => new DesktopPainter(ctx, painter, input, rig),
      vr: (poses) => new VrPainter(ctx, painter, rig, poses),
      touch: (chips) => new TouchPainter(ctx, painter, rig, chips),
    });

    hud.show();
    hud.message(`Welcome to the yard, ${launch.playerName}!`);
    if (!launch.touch) hud.message('Hold the mouse button to spray. Get closer for a sharper line.');
    hud.message(launch.touch ? 'Tap a colour along the bottom, or use a tool on the rack by the gate.' : 'Pick colours off the rack by the gate, or with the wheel.');

    shell.run({
      simulate: (dt, now) => {
        ctx.now = now;
        shell.receive(now);
        ctx.sync.update();
        this.seat.step(dt);
        this.autosave();
      },
      present: (dt, now) => {
        hud.tick(now);
        this.views.update(dt);
        this.extraViews.update(dt);
        this.seat.present(dt);
        rig.update(dt);
      },
    });
  }

  /** Keep the walls in this browser every so often while they're changing, so they're here next time. */
  private autosave(force = false): void {
    const { sync } = this.ctx;
    if (!sync.synced || sync.version === this.savedVersion) return;
    if (!force && this.ctx.now < this.nextSave) return;
    this.savedVersion = sync.version;
    this.nextSave = this.ctx.now + AUTOSAVE_MS;
    void this.deps.store.save(this.deps.launch.netLabel, this.ctx.surfaces);
  }

  dispose(): void {
    this.autosave(true);
    this.shell.dispose();
  }
}
