import { EntityViews, type NetWorld } from '@engine/index';
import type { Launch } from '../crossplay/lobby';
import { Platform } from '../crossplay/platform';
import type { Frontend, Seat } from '../crossplay/role';
import { Shell } from '../crossplay/shell';
import { bodySpeakers, type Speaker } from '../crossplay/voice';
import { registerActions } from './actions';
import type { HauntContext } from './context';
import { Haunt as HauntDef, Survivor as SurvivorDef } from './defs';
import { DesktopSurvivor } from './desktop';
import { Effects } from './effects';
import { stepRules } from './frame';
import { HauntRole, type HauntFrontend } from './haunt';
import { DesktopHaunt } from './hauntDesktop';
import { TouchHaunt } from './hauntTouch';
import { VrHaunt } from './hauntVr';
import type { Hud, NightNews } from './hud';
import type { HauntIntent, SurvivorIntent } from './intent';
import { GATE, Paths, type Manor } from './manor';
import { RoundKeeper } from './round';
import { Scenery } from './scenery';
import type { Sfx } from './sfx';
import { SurvivorRole, type SurvivorFrontend } from './survivor';
import { TouchSurvivor } from './touch';
import { registerViews } from './views';
import { VrSurvivor } from './vr';

export type RoleName = 'survivor' | 'haunt';

export interface GameDeps {
  world: NetWorld;
  manor: Manor;
  hud: Hud;
  sfx: Sfx;
  launch: Launch<unknown>;
}

export class Game {
  readonly shell: Shell;
  readonly ctx: HauntContext;
  readonly role: RoleName;
  readonly survivor: SurvivorRole | null = null;
  readonly haunt: HauntRole | null = null;
  /** The local player: their role, and the frontend for whichever platform is playing it. */
  readonly seat: Seat<SurvivorIntent, SurvivorFrontend> | Seat<HauntIntent, HauntFrontend>;
  private readonly keeper: RoundKeeper;
  private readonly views: EntityViews;
  private readonly extraViews: { update(dt: number): void };
  private readonly scenery: Scenery;

  constructor(deps: GameDeps) {
    const { world, manor, hud, sfx, launch } = deps;
    const role = (this.role = launch.role === 'haunt' ? 'haunt' : 'survivor');
    const shell = (this.shell = new Shell({
      world,
      sfx,
      launch,
      players: SurvivorDef,
      speakers: voices(world),
      company: role === 'haunt' ? 'survivors' : 'players',
      announce: (text) => hud.message(text),
      showLock: (locked, platform) => hud.setLocked(locked, platform),
    }));
    const { rig, scene } = shell.stage;
    this.scenery = new Scenery(manor, scene);
    this.scenery.setView(role);
    let keeper: RoundKeeper | null = null;
    const ctx: HauntContext = (this.ctx = {
      world,
      manor,
      paths: new Paths(manor),
      sfx,
      hud,
      settings: shell.settings,
      fx: new Effects(scene),
      me: null,
      haunt: null,
      round: () => keeper?.round ?? null,
      playerName: launch.playerName,
      now: performance.now(),
    });
    keeper = this.keeper = new RoundKeeper(ctx);
    this.views = new EntityViews(world);
    hud.setRole(role);

    if (role === 'haunt') {
      const haunt = (this.haunt = new HauntRole(ctx));
      registerActions(ctx, { haunt });
      this.extraViews = registerViews(ctx, this.views, scene, rig, { showSelf: () => false, showOwnBeam: () => false }, haunt);
      haunt.spawn();
      this.seat = shell.seat<HauntIntent, HauntFrontend>(haunt, {
        desktop: (input) => new DesktopHaunt(ctx, haunt, input, rig, scene),
        vr: (poses) => new VrHaunt(ctx, haunt, rig, poses, scene),
        touch: (chips) => new TouchHaunt(ctx, haunt, rig, chips, scene),
      });
      hud.message(`Welcome, ${launch.playerName}. Tonight, you are the house.`);
      hud.message('Summon where no survivor can see.');
    } else {
      const survivor = (this.survivor = new SurvivorRole(ctx));
      registerActions(ctx, { survivor });
      this.extraViews = registerViews(
        ctx,
        this.views,
        scene,
        rig,
        { showSelf: () => (this.seat as Seat<SurvivorIntent, SurvivorFrontend>).frontend.showSelf, showOwnBeam: () => (this.seat as Seat<SurvivorIntent, SurvivorFrontend>).frontend.platform === Platform.Vr },
        null,
      );
      survivor.spawn();
      this.seat = shell.seat<SurvivorIntent, SurvivorFrontend>(survivor, {
        desktop: (input) => new DesktopSurvivor(ctx, survivor, input, rig),
        vr: (poses) => new VrSurvivor(ctx, survivor, rig, poses),
        touch: (chips) => new TouchSurvivor(ctx, survivor, rig, chips),
      });
      hud.message(`Welcome to the manor, ${launch.playerName}. The gate shuts behind you.`);
      hud.message('Find the keys inside, put them in the pedestal by the gate, and get out.');
    }
    world.on('peerJoined', () => hud.message('Someone else has come to the manor'));

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
        this.scenery.update(dt, manor.gateOpen, ctx.round()?.state.placed ?? 0);
      },
    });
  }

  /** Make a fuss about how the night's going, from each side. */
  private news(news: NightNews): void {
    const { hud, sfx } = this.ctx;
    const haunt = this.role === 'haunt';
    switch (news) {
      case 'hunt':
        sfx.play('bell');
        hud.showBanner(haunt ? 'THE NIGHT IS YOURS' : 'THE HUNT BEGINS', haunt ? '#c79bff' : '#ff6a5a', 3000);
        break;
      case 'gate':
        sfx.play('gate', { x: (GATE.x0 + GATE.x1 + 1) / 2, y: GATE.y + 0.5, z: 1.5 });
        hud.showBanner('THE GATE IS OPEN', haunt ? '#ff8a6a' : '#9fe0a8', 3000);
        break;
      case 'escaped':
        sfx.play(haunt ? 'claimed' : 'escape');
        hud.showBanner(haunt ? 'THEY GOT AWAY' : 'SURVIVORS ESCAPED', '#9fe0a8', 4000);
        break;
      case 'claimed':
        sfx.play(haunt ? 'escape' : 'claimed');
        hud.showBanner('THE HOUSE WINS', '#c79bff', 4000);
        break;
    }
  }

  dispose(): void {
    this.shell.dispose();
  }
}

/** Voices come from survivors' mouths, and the Haunt's from its presence while it lingers somewhere. */
function voices(world: NetWorld): () => Iterable<Speaker> {
  const bodies = bodySpeakers(world, SurvivorDef);
  return function* speakers(): Iterable<Speaker> {
    yield* bodies();
    for (const h of world.remote(HauntDef)) {
      const s = h.render;
      if (s.present) yield { peer: h.owner, name: s.name, at: { x: s.px, y: s.py, z: 1.7 } };
    }
  };
}
