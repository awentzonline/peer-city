import { EntityViews, type NetWorld } from '@engine/index';
import type { Launch } from '../crossplay/lobby';
import type { Frontend, Seat } from '../crossplay/role';
import { Shell } from '../crossplay/shell';
import { registerActions } from './actions';
import { CaptainRole, type CaptainFrontend } from './captain';
import { DesktopCaptain } from './captainDesktop';
import { TouchCaptain } from './captainTouch';
import { VrCaptain } from './captainVr';
import { Paths, type Castle } from './castle';
import type { ShinobiContext } from './context';
import { Shinobi as ShinobiDef } from './defs';
import { DesktopShinobi } from './desktop';
import { Effects } from './effects';
import { Flights } from './flights';
import { stepRules } from './frame';
import type { Hud, NightNews } from './hud';
import type { CaptainIntent, ShinobiIntent } from './intent';
import { RoundKeeper } from './round';
import { Scenery } from './scenery';
import type { Sfx } from './sfx';
import { ShinobiRole, type ShinobiFrontend } from './shinobi';
import { TouchShinobi } from './touch';
import { registerViews } from './views';
import { VrShinobi } from './vr';

export type RoleName = 'shinobi' | 'captain';

export interface GameDeps {
  world: NetWorld;
  castle: Castle;
  hud: Hud;
  sfx: Sfx;
  launch: Launch<unknown>;
}

export class Game {
  readonly shell: Shell;
  readonly ctx: ShinobiContext;
  readonly role: RoleName;
  readonly shinobi: ShinobiRole | null = null;
  readonly captain: CaptainRole | null = null;
  /** The local player: their role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<ShinobiIntent, ShinobiFrontend> | Seat<CaptainIntent, CaptainFrontend>;
  private readonly keeper: RoundKeeper;
  private readonly views: EntityViews;
  private readonly extraViews: { update(dt: number): void };
  private readonly scenery: Scenery;
  private nextFirefly = 0;

  constructor(deps: GameDeps) {
    const { world, castle, hud, sfx, launch } = deps;
    const role = (this.role = launch.role === 'captain' ? 'captain' : 'shinobi');
    const shell = (this.shell = new Shell({
      world,
      sfx,
      launch,
      players: ShinobiDef,
      company: role === 'captain' ? 'nobody' : 'shinobi',
      announce: (text) => hud.message(text),
      showLock: (locked, platform) => hud.setLocked(locked, platform),
    }));
    const { rig, scene } = shell.stage;
    this.scenery = new Scenery(castle, scene);
    this.scenery.setView(role);
    let keeper: RoundKeeper | null = null;
    const ctx = (this.ctx = {
      world,
      castle,
      paths: new Paths(castle),
      sfx,
      hud,
      settings: shell.settings,
      fx: new Effects(scene),
      me: null,
      captain: null,
      round: () => keeper?.round ?? null,
      playerName: launch.playerName,
      now: performance.now(),
    } as unknown as ShinobiContext);
    ctx.flights = new Flights(ctx);
    keeper = this.keeper = new RoundKeeper(ctx);
    this.views = new EntityViews(world);
    hud.setRole(role);

    if (role === 'captain') {
      const captain = (this.captain = new CaptainRole(ctx));
      registerActions(ctx, keeper, { captain });
      this.extraViews = registerViews(ctx, this.views, scene, rig, this.scenery, { showSelf: () => false }, captain);
      captain.spawn();
      this.seat = shell.seat<CaptainIntent, CaptainFrontend>(captain, {
        desktop: (input) => new DesktopCaptain(ctx, captain, input, rig, scene),
        vr: (poses) => new VrCaptain(ctx, captain, rig, poses, scene),
        touch: (chips) => new TouchCaptain(ctx, captain, rig, chips, scene),
      });
      hud.message(`Captain ${launch.playerName}, the watch is yours tonight.`);
      hud.message('You only know what your guards see and hear. Keep the lord alive until dawn.');
    } else {
      const shinobi = (this.shinobi = new ShinobiRole(ctx));
      registerActions(ctx, keeper, { shinobi });
      this.extraViews = registerViews(ctx, this.views, scene, rig, this.scenery, { showSelf: () => (this.seat as Seat<ShinobiIntent, ShinobiFrontend>).frontend.showSelf }, null);
      shinobi.spawn();
      this.seat = shell.seat<ShinobiIntent, ShinobiFrontend>(shinobi, {
        desktop: (input) => new DesktopShinobi(ctx, shinobi, input, rig),
        vr: (poses) => new VrShinobi(ctx, shinobi, rig, poses),
        touch: (chips) => new TouchShinobi(ctx, shinobi, rig, chips),
      });
      hud.message(`The forest is quiet, ${launch.playerName}. The castle's lanterns burn ahead.`);
      hud.message('When night falls, find the lord inside the walls, kill him, and get out.');
    }
    world.on('peerJoined', () => hud.message('Someone else has come to the castle'));

    hud.show();
    shell.run({
      simulate: (dt, now) => {
        ctx.now = now;
        shell.receive(now);
        (this.seat as Seat<unknown, Frontend<unknown>>).step(dt);
        stepRules(ctx, this.keeper, dt, now);
      },
      present: (dt, now) => {
        hud.tick(now);
        this.news(hud.night(ctx));
        this.views.update(dt);
        this.extraViews.update(dt);
        (this.seat as Seat<unknown, Frontend<unknown>>).present(dt);
        rig.update(dt);
        ctx.fx.update(dt);
        this.scenery.update(dt);
        this.fireflies(now);
      },
    });
  }

  /** Fireflies over the gardens near a shinobi, now and then. */
  private fireflies(now: number): void {
    const me = this.ctx.me;
    if (!me || now < this.nextFirefly) return;
    this.nextFirefly = now + 400;
    const a = Math.random() * Math.PI * 2;
    const d = 4 + Math.random() * 14;
    this.ctx.fx.firefly(me.x + Math.cos(a) * d, me.y + Math.sin(a) * d, 0.6 + Math.random() * 1.5);
  }

  /** Make a fuss about how the night's going, from each side. */
  private news(news: NightNews): void {
    const { hud, sfx } = this.ctx;
    const captain = this.role === 'captain';
    switch (news) {
      case 'night':
        sfx.play('gong', undefined, 0.5);
        hud.showBanner(captain ? 'THE WATCH BEGINS' : 'NIGHT FALLS', captain ? '#6ad0ff' : '#c8d4ff', 3000);
        break;
      case 'slain':
        hud.showBanner('THE LORD IS DEAD', captain ? '#ff5a4a' : '#ffd35a', 3000);
        break;
      case 'assassinated':
        sfx.play(captain ? 'defeat' : 'escape');
        hud.showBanner('ASSASSINATED', captain ? '#ff5a4a' : '#9fe0a8', 4000);
        break;
      case 'avenged':
        sfx.play(captain ? 'escape' : 'defeat');
        hud.showBanner('THE BAND IS TAKEN', captain ? '#9fe0a8' : '#ff8a6a', 4000);
        break;
      case 'defended':
        sfx.play(captain ? 'dawn' : 'defeat');
        hud.showBanner('DAWN · THE LORD LIVES', captain ? '#9fe0a8' : '#ff8a6a', 4000);
        break;
    }
  }

  dispose(): void {
    this.shell.dispose();
  }
}
