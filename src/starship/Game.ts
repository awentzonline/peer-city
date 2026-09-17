import * as THREE from 'three';
import { EntityViews, type NetWorld, type PayloadOf } from '@engine/index';
import type { Launch } from '../crossplay/lobby';
import { Platform } from '../crossplay/platform';
import type { Frontend, Seat } from '../crossplay/role';
import { Shell } from '../crossplay/shell';
import { registerActions, type Presenter } from './actions';
import type { StarshipContext } from './context';
import { CrewRole, type CrewFrontend } from './crew';
import { DesktopCrew, TouchCrew } from './crewScreens';
import { VrCrew } from './crewVr';
import type { Deck } from './deck';
import { DeckView } from './decks';
import { Crew, Officer as OfficerDef, Screen, Shot, Sound, Station, STATIONS, type Beam3, type Boom, type Jolt, type Noise } from './defs';
import { Torpedoes } from './flights';
import { stepRules } from './frame';
import type { Hud, VoyageNews } from './hud';
import type { OfficerIntent } from './intent';
import { OfficerRole, type OfficerFrontend } from './officer';
import { StationScreen, StationVr, ViewerScreen, ViewerVr, freeStation } from './officers';
import type { Sector } from './sector';
import type { Sfx } from './sfx';
import { ShipKeeper } from './ship';
import { SpaceView } from './space';
import { STATION_NAMES } from './stations';
import { AwayCamera, type Draws } from './view';

export type RoleName = 'station' | 'crew' | 'viewer';

export interface GameDeps {
  world: NetWorld;
  sector: Sector;
  deck: Deck;
  hud: Hud;
  sfx: Sfx;
  launch: Launch<unknown>;
}

const STATION_KEY = 'peer-starship:station';

/** The bridge viewscreen's shape, for framing what's drawn into it. */
const SCREEN_ASPECT = 1024 / 436;

export class Game {
  readonly shell: Shell;
  readonly ctx: StarshipContext;
  readonly role: RoleName;
  readonly crew: CrewRole | null = null;
  readonly officer: OfficerRole | null = null;
  readonly seat: Seat<unknown, Frontend<unknown>>;
  readonly space: SpaceView;
  readonly decks: DeckView;
  readonly keeper: ShipKeeper;
  readonly torpedoes: Torpedoes;
  private readonly views: EntityViews;
  private readonly away: AwayCamera;
  private screenFrame = 0;
  private dt = 1 / 60;

  constructor(deps: GameDeps) {
    const { world, sector, deck, hud, sfx, launch } = deps;
    const role = (this.role = launch.role === 'crew' ? 'crew' : launch.role === 'viewer' ? 'viewer' : 'station');
    const shell = (this.shell = new Shell({
      world,
      sfx,
      launch,
      players: Crew,
      company: 'crew',
      announce: (text) => hud.message(text),
      showLock: (locked, platform) => hud.setLocked(locked, platform),
    }));
    const { rig, scene } = shell.stage;
    let keeper: ShipKeeper | null = null;
    const ctx = (this.ctx = {
      world,
      sector,
      deck,
      sfx,
      hud,
      settings: shell.settings,
      fx: {
        torpedo: (_id: number, x: number, y: number) => sfx.play('torpedo', undefined, this.spaceVolume(x, y)),
        torpedoGone: () => {},
      },
      ship: () => keeper?.ship ?? null,
      me: null,
      officer: null,
      playerName: launch.playerName,
      now: performance.now(),
    } as unknown as StarshipContext);
    const torpedoes = (this.torpedoes = ctx.torpedoes = new Torpedoes(ctx));
    keeper = this.keeper = new ShipKeeper(ctx, torpedoes);
    this.views = new EntityViews(world);
    this.space = new SpaceView(ctx, this.views, torpedoes);
    this.decks = new DeckView(ctx, scene, this.views, { showSelf: () => (this.seat?.frontend as { showSelf?: boolean } | undefined)?.showSelf ?? false });
    this.away = new AwayCamera(ctx);
    hud.setRole(role);

    if (role === 'crew') {
      const crew = (this.crew = new CrewRole(ctx));
      registerActions(ctx, keeper, torpedoes, crew, this.presenter());
      crew.spawn();
      this.seat = shell.seat<unknown, CrewFrontend>(crew as never, {
        desktop: (input) => new DesktopCrew(ctx, crew, input, rig),
        vr: (poses) => new VrCrew(ctx, crew, rig, poses, this.decks),
        touch: (chips) => new TouchCrew(ctx, crew, rig, chips),
      }) as Seat<unknown, Frontend<unknown>>;
      hud.message(`Welcome aboard the Wayfarer, ${launch.playerName}. The bridge is forward; the transporter room is aft of it.`);
    } else {
      const officer = (this.officer = new OfficerRole(ctx));
      registerActions(ctx, keeper, torpedoes, null, this.presenter());
      if (role === 'viewer') {
        officer.spawn(Station.Viewer);
        const aim = (mode: Screen, aspect: number) => this.space.aim(mode, aspect, this.dt);
        this.seat = shell.seat<OfficerIntent, OfficerFrontend>(officer, {
          desktop: (input) => new ViewerScreen(ctx, Platform.Desktop, input, aim),
          vr: (poses) => new ViewerVr(ctx, rig, poses),
          touch: () => new ViewerScreen(ctx, Platform.Touch, null, aim),
        }) as Seat<unknown, Frontend<unknown>>;
      } else {
        const station = pickStation(launch.params);
        officer.spawn(station);
        const remember = (s: Station) => {
          try {
            localStorage.setItem(STATION_KEY, String(s));
          } catch {
            /* storage unavailable */
          }
        };
        this.seat = shell.seat<OfficerIntent, OfficerFrontend>(officer, {
          desktop: () => new StationScreen(ctx, Platform.Desktop, station, null, remember),
          vr: (poses) => new StationVr(ctx, rig, poses, this.decks, station, remember),
          touch: (chips) => new StationScreen(ctx, Platform.Touch, station, chips, remember),
        }) as Seat<unknown, Frontend<unknown>>;
        // someone else already at your station: move over, once you can see who's where
        window.setTimeout(() => {
          const me = ctx.officer?.render.station;
          const others = [...world.all(OfficerDef)].filter((o) => o !== ctx.officer && o.render.station === me);
          if (others.length && !launch.params.has('station')) hud.message(`${others.map((o) => o.render.name).join(', ')} is already at ${STATION_NAMES[me!].toLowerCase()}. Try ${STATION_NAMES[freeStation(ctx)].toLowerCase()}.`);
        }, 4000);
      }
    }
    world.on('peerJoined', () => hud.message('Someone else has come aboard'));

    shell.stage.render = (renderer) => this.render(renderer);
    hud.show();
    shell.run({
      simulate: (dt, now) => {
        ctx.now = now;
        shell.receive(now);
        this.seat.step(dt);
        stepRules(ctx, keeper!, torpedoes, dt, now);
      },
      present: (dt, now) => {
        this.dt = dt;
        hud.tick(now);
        this.news(hud.ship(ctx));
        this.views.update(dt);
        this.seat.present(dt);
        rig.update(dt);
        this.space.update(dt);
        this.decks.update(dt);
      },
    });
  }

  /** How loud something happening in space is from here: the viewscreen's the bridge's speakers, the decks are muffled. */
  private spaceVolume(x: number, y: number): number {
    const ship = this.ctx.ship();
    const d = ship ? Math.hypot(ship.x - x, ship.y - y) : 0;
    const k = Math.max(0.15, 1 - d / 3000);
    return this.role === 'viewer' ? k : this.role === 'crew' ? k * 0.5 : k * 0.3;
  }

  private presenter(): Presenter {
    const { ctx } = this;
    const { sfx } = ctx;
    return {
      beam: (p: PayloadOf<typeof Beam3>) => {
        this.space.beam(p);
        this.decks.beam(p);
        if (p.kind === Shot.Phaser) sfx.play('phaser', undefined, this.spaceVolume(p.x, p.y));
        else if (p.kind === Shot.Disruptor) sfx.play('disruptor', undefined, this.spaceVolume(p.x, p.y) * 0.8);
        else if (p.kind === Shot.Bolt) sfx.play('bolt', { x: p.x, y: p.y, z: p.z });
        else if (!ctx.me || Math.hypot(ctx.me.x - p.x, ctx.me.y - p.y) > 1) sfx.play('handPhaser', { x: p.x, y: p.y, z: p.z });
      },
      boom: (p: PayloadOf<typeof Boom>) => {
        this.space.boom(p);
        sfx.play(p.size >= 2 ? 'bigBoom' : 'boom', undefined, this.spaceVolume(p.x, p.y));
      },
      jolt: (p: PayloadOf<typeof Jolt>) => {
        this.space.jolt(p);
        (this.seat.frontend as Frontend<unknown> & Draws).jolt?.(p.amount, p.shielded);
        const v = this.role === 'station' ? 0.4 : 1;
        sfx.play(p.shielded ? 'shieldHit' : 'hullHit', undefined, v * Math.min(1, 0.4 + p.amount / 20));
      },
      noise: (p: PayloadOf<typeof Noise>) => {
        this.decks.noise(p);
        const at = { x: p.x, y: p.y, z: p.z };
        const quiet = this.role === 'crew' ? 1 : 0.4;
        switch (p.kind) {
          case Sound.Warp:
            sfx.play('warp', undefined, quiet);
            break;
          case Sound.Dock:
          case Sound.Undock:
            sfx.play('dock', undefined, quiet);
            break;
          case Sound.Scan:
            sfx.play('scan', undefined, this.role === 'station' ? 0.6 : 0.3);
            break;
          case Sound.Beam:
            if (this.role === 'crew') sfx.play('beam', at);
            else sfx.play('beam', undefined, 0.4);
            break;
          case Sound.Load:
            sfx.play('load', at);
            break;
          case Sound.Relic:
            sfx.play('relic', at);
            break;
          case Sound.Repair:
            sfx.play('repair', at);
            break;
          case Sound.Wreck:
            sfx.play('wreck', at);
            break;
        }
      },
    };
  }

  /** Make a fuss about how the voyage is going. */
  private news(news: VoyageNews): void {
    const { hud, sfx } = this.ctx;
    const loud = this.role === 'station' ? 0.35 : 1;
    switch (news) {
      case 'underway':
        hud.showBanner('UNDERWAY', '#9ad8ff', 2500);
        sfx.play('dock', undefined, loud);
        break;
      case 'alert':
        hud.showBanner('RED ALERT', '#ff5a4a', 2500);
        sfx.play('alert', undefined, loud);
        break;
      case 'relic':
        hud.showBanner('RELIC RECOVERED', '#ffd35a', 3000);
        sfx.play('relic', undefined, loud);
        break;
      case 'victory':
        hud.showBanner('VOYAGE COMPLETE', '#9fe0a8', 5000);
        sfx.play('victory');
        break;
      case 'lost':
        hud.showBanner('SHIP LOST', '#ff5a4a', 5000);
        sfx.play('lost');
        break;
      case 'briefing':
        hud.message('A new voyage: the ship is docked at the starbase, repaired and restocked.');
        break;
    }
  }

  /** Each frame: the bridge's viewscreen if anyone here can see it, then whatever this frontend puts on the page. */
  private render(renderer: THREE.WebGLRenderer): void {
    const drawn = (this.seat.frontend as Frontend<unknown> & Draws).drawn();
    const { ctx, decks, space } = this;
    const scene = this.shell.stage.scene;
    switch (drawn.place) {
      case 'none':
        return;
      case 'space':
        if (drawn.camera) {
          // a headset's camera lives on the rig in the decks' scene: bring it up to date by hand
          this.shell.stage.rig.root.updateMatrixWorld(true);
          renderer.render(space.scene, drawn.camera);
        } else space.render(renderer, null);
        return;
      case 'deck': {
        const ship = ctx.ship()?.render;
        if (ship && ctx.deck.onShip(drawn.x) && this.screenFrame++ % 2 === 0) {
          const mode = ship.screen;
          if (mode === Screen.Away && this.away.aim(SCREEN_ASPECT, this.dt * 2)) {
            decks.viewscreen.visible = false;
            decks.ambience(this.away.subject()!.x);
            this.intoScreen(renderer, () => renderer.render(scene, this.away.camera));
            decks.viewscreen.visible = true;
          } else {
            space.aim(mode === Screen.Away ? Screen.Tactical : mode, SCREEN_ASPECT, this.dt * 2);
            space.render(renderer, decks.screen);
          }
        }
        decks.ambience(drawn.x);
        renderer.render(scene, drawn.camera);
        return;
      }
    }
  }

  /** Draw into the bridge's viewscreen, even from inside a headset session. */
  private intoScreen(renderer: THREE.WebGLRenderer, draw: () => void): void {
    const xr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    const was = renderer.getRenderTarget();
    renderer.setRenderTarget(this.decks.screen);
    draw();
    renderer.setRenderTarget(was);
    renderer.xr.enabled = xr;
  }

  dispose(): void {
    this.shell.dispose();
  }
}

function pickStation(params: URLSearchParams): Station {
  const asked = params.get('station');
  const named = STATIONS.find((s) => STATION_NAMES[s].toLowerCase() === asked);
  if (named !== undefined) return named;
  try {
    const kept = Number(localStorage.getItem(STATION_KEY));
    if ((STATIONS as readonly Station[]).includes(kept)) return kept as Station;
  } catch {
    /* storage unavailable */
  }
  return Station.Helm;
}
