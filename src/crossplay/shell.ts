import { NetDebugPanel, type EntityDef, type NetWorld } from '@engine/index';
import type { SpatialAudio } from './audio';
import type { DesktopInput } from './input';
import type { Launch } from './lobby';
import type { Vec3 } from './math';
import { Platform } from './platform';
import { WebXrPoses, type XrPoseSource } from './rig';
import { Seat, type Frontend, type Role } from './role';
import { Settings } from './settings';
import { SettingsMenu } from './settingsMenu';
import { Stage, errorText } from './stage';
import { Voice, bodySpeakers, type Speaker } from './voice';
import { SimulatedXr } from './xrsim';

/** What a touch frontend can't reach with keys, so it calls back through chips on the screen. */
export interface TouchChips {
  menu(): void;
  mic(): void;
}

/** How to build a role's frontend for each platform. Rigs, scenes and the rest come from the game's own closure. */
export interface Frontends<F> {
  desktop(input: DesktopInput): F;
  /** A headset: a real one's poses, or `?xrsim`'s simulated ones. */
  vr(poses: XrPoseSource): F;
  /** Leave it out if there's no touch frontend yet: phones then get the desktop one. */
  touch?(chips: TouchChips): F;
}

export interface ShellOptions {
  world: NetWorld;
  /** The game's sound, which voices play through too. */
  sfx: SpatialAudio;
  launch: Pick<Launch<unknown>, 'netLabel' | 'touch' | 'sim' | 'session' | 'params'>;
  /** The entity each player is (with `BODY_FIELDS` and a `name`), whose voices can be heard from where they stand. */
  players: EntityDef<any>;
  /** Where voices come from instead, for a game with players who aren't all bodies (an overseer speaking through a presence). */
  speakers?: () => Iterable<Speaker>;
  /** Where the local player's voice comes from, when it isn't where they listen from (that overseer's presence). */
  mouth?: () => Vec3;
  /** Tell the local player something, e.g. that the microphone's on. */
  announce(text: string): void;
  /** Who can hear you, in those messages: "players near you can hear you". Default 'players'. */
  company?: string;
  /**
   * Show or hide the page's "click to play" prompt and crosshair: only the mouse is captured, and a headset has no
   * crosshair. `locked` is true while the mouse needs no capturing: it's captured, or the frontend uses a free pointer.
   */
  showLock(locked: boolean, platform: Platform): void;
  /** Whether V is the microphone key right now (Peer City's car camera takes it). Default always. */
  talkKey?: () => boolean;
  container?: HTMLElement;
}

/** A game's frame. Order within each is the game's own. */
export interface ShellLoop {
  /** Every simulation step, background tab included. Start it with `shell.receive(now)`. */
  simulate(dt: number, now: number): void;
  /** Rendered frames only, after `simulate`. Draw and present the seat here. */
  present(dt: number, now: number): void;
}

/**
 * What every crossplay game's page has around its own world and rules: the stage, proximity voice and the
 * settings menu, the network debug panel, the ENTER VR button, a seat whose frontend follows the platform
 * the page is played on, and the keys that are the same in every game (`` ` `` stats, N sound, Esc settings,
 * V microphone).
 *
 * It holds no rules and doesn't order the frame beyond receiving first and the menus last, so a game builds
 * its context and systems however it likes. Each piece is public, and a game that wants something different
 * can use `Stage`, `Voice` and the rest directly instead.
 */
export class Shell {
  readonly world: NetWorld;
  readonly stage: Stage;
  readonly voice: Voice;
  readonly settings: Settings;
  readonly menu: SettingsMenu;
  readonly debug: NetDebugPanel;
  private seated: Seat<unknown, Frontend<unknown>> | null = null;
  private frontends: Frontends<Frontend<unknown>> | null = null;
  private readonly vrButton = document.getElementById('vr-enter') as HTMLButtonElement | null;

  constructor(private readonly opts: ShellOptions) {
    const { world, sfx, launch } = opts;
    this.world = world;
    this.stage = new Stage(opts.container ?? document.getElementById('game')!);
    // Voice shares the world's own zone rooms rather than parallel ones: same peers either way, and
    // every extra room is another signalling announce on every relay, which is what gets a peer
    // rate-limited off the relays it needs to find anyone.
    this.voice = new Voice({
      transport: world.transport,
      prefix: `${world.worldId}/`,
      audio: sfx,
      zones: () => world.zoneKeys(),
      speakers: opts.speakers ?? bodySpeakers(world, opts.players),
      mouth: opts.mouth,
    });
    this.settings = new Settings({ voice: this.voice, sfx });
    this.menu = new SettingsMenu(this.settings, this.stage.input);
    this.debug = new NetDebugPanel(world, document.body, launch.netLabel);
    this.debug.visible = launch.params.has('debug');
    this.stage.input.onLockChange = () => this.showLock();
    // A phone has no console to look in: say what broke, once per message, so a frozen screen can be traced.
    const seen = new Set<string>();
    const report = (text: string): void => {
      if (seen.has(text)) return;
      seen.add(text);
      opts.announce(`⚠ Error: ${text}`);
    };
    window.addEventListener('error', (e) => report(`${e.message} (${e.filename?.split('/').pop()}:${e.lineno})`));
    window.addEventListener('unhandledrejection', (e) => report(errorText(e.reason)));
  }

  get input(): DesktopInput {
    return this.stage.input;
  }

  /** The platform the page is played on, as far as the mouse and the crosshair care: a simulated headset still uses both. */
  get platform(): Platform {
    return this.stage.presenting ? Platform.Vr : this.touch ? Platform.Touch : Platform.Desktop;
  }

  private get touch(): boolean {
    return this.opts.launch.touch && !!this.frontends?.touch;
  }

  /**
   * Seat the local player's role, with a frontend for each platform. The one for now is built at once. Name the
   * intent and frontend types (`shell.seat<WallsIntent, PainterFrontend>(...)`): a role's `attach` takes its body
   * callbacks, which TypeScript can't infer a frontend from.
   */
  seat<I, F extends Frontend<I>>(role: Role<I, F>, frontends: Frontends<F>): Seat<I, F> {
    this.frontends = frontends as Frontends<Frontend<unknown>>;
    const seat = new Seat<I, F>(role, () => this.frontend() as F);
    this.seated = seat as unknown as Seat<unknown, Frontend<unknown>>;
    this.showLock();
    return seat;
  }

  /** A frontend for how the page is being played right now, with the mouse captured or free as it wants. */
  private frontend(): Frontend<unknown> {
    const frontend = this.build();
    this.stage.input.setCapture(!frontend.cursor);
    return frontend;
  }

  private build(): Frontend<unknown> {
    const { stage, frontends } = this;
    if (stage.presenting) return frontends!.vr(new WebXrPoses(stage.renderer.xr));
    if (this.opts.launch.sim) return frontends!.vr(new SimulatedXr(stage.input));
    // Touch has no keyboard to reach the menu or the microphone with, so its chips call them directly.
    if (this.touch) return frontends!.touch!({ menu: () => this.menu.toggle(), mic: () => void this.talk() });
    return frontends!.desktop(stage.input);
  }

  /** Bring the network and voice up to date. The first thing a loop's `simulate` does. */
  receive(now: number): void {
    this.world.update(now);
    this.voice.update();
  }

  /** Start simulating and drawing, and go into the headset if the lobby asked for one (or take the mouse if not). */
  run(loop: ShellLoop): void {
    const { stage, opts } = this;
    if (this.vrButton) {
      void Stage.vrSupported().then((ok) => (this.vrButton!.hidden = !ok));
      this.vrButton.addEventListener('click', () => {
        stage.enterVR().catch((err: unknown) => opts.announce(`Couldn't start VR: ${errorText(err)}`));
      });
    }

    stage.run({
      step: (dt, visible) => {
        const now = performance.now();
        loop.simulate(dt, now);
        if (!visible) return;
        loop.present(dt, now);
        this.menu.update(now);
        this.debug.update(now);
        this.keys();
      },
      platformChanged: (presenting) => {
        if (this.vrButton) this.vrButton.hidden = presenting;
        // The menu belongs to whichever frontend is playing; the next one opens its own.
        this.menu.setOpen(false);
        this.seated?.use(() => this.frontend());
        this.showLock();
      },
    });

    const { session } = opts.launch;
    if (session) session.then((s) => stage.startSession(s)).catch((err: unknown) => opts.announce(`Couldn't start VR: ${errorText(err)}`));
    else if (!this.touch) stage.input.requestLock();
  }

  /** Global keys, whatever the platform; a headset has its own settings panel and its own way in. */
  private keys(): void {
    const { input } = this.stage;
    const { sfx, announce, talkKey } = this.opts;
    if (input.pressed('Backquote')) this.debug.visible = !this.debug.visible;
    if (input.pressed('KeyN')) {
      sfx.muted = !sfx.muted;
      announce(sfx.muted ? 'Sound off' : 'Sound on');
    }
    if (this.seated?.frontend.platform !== Platform.Desktop) return;
    if (input.pressed('Escape')) this.menu.toggle();
    if (input.pressed('KeyV') && (talkKey?.() ?? true)) void this.talk();
  }

  /** Open or close the microphone, and say what happened: it asks the browser the first time. */
  async talk(): Promise<void> {
    const on = await this.voice.toggleTalking();
    const { announce, company = 'players' } = this.opts;
    if (this.voice.error) announce(this.voice.error);
    else announce(on ? `Microphone on: ${company} near you can hear you` : 'Microphone off');
  }

  /** A free pointer never needs capturing, so as far as the prompt's concerned it's as good as locked. */
  private showLock(): void {
    this.opts.showLock(this.stage.input.ready, this.platform);
  }

  dispose(): void {
    this.voice.dispose();
    this.menu.dispose();
    this.world.dispose();
  }
}
