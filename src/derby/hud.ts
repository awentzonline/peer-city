import { Platform } from '../crossplay/platform';
import type { Builder } from './builder';
import type { DerbyContext, RacerEntity } from './context';
import { FINISH } from './course';
import { Builder as BuilderDef, Phase, Racer, RacerMode } from './defs';
import { PART_GUN, WRENCH, problemText } from './kit';
import { MAX_PARTS, PARTS, PLACEABLE } from './parts';
import { FUEL_SECONDS } from './physics';
import { ordinal, raceTime, standings } from './race';

export interface StandingLine {
  place: string;
  name: string;
  detail: string;
  me: boolean;
}

/**
 * Status and announcements. On desktop it drives DOM elements; a headset paints the same state onto panels in
 * the scene (see wrist.ts), because the DOM isn't visible inside one. Frontends call `showBuilder` every frame
 * with how the device names its controls.
 */
export class Hud {
  phase = '';
  build = '';
  buildDetail = '';
  stats = '';
  drive = '';
  hint = '';
  /** Starts unset, so the first frame decides whether the rockets bar shows at all. */
  fuel = -1;
  progress = 0;
  lines: StandingLine[] = [];
  readonly banner = { text: '', color: '#fff', until: 0 };
  readonly feed: { text: string; until: number }[] = [];
  /** Bumped whenever something the VR panels show changes. */
  version = 0;

  private readonly root = document.getElementById('hud')!;
  private readonly phaseEl = document.getElementById('phase')!;
  private readonly buildEl = document.getElementById('build')!;
  private readonly buildDetailEl = document.getElementById('build-detail')!;
  private readonly statsEl = document.getElementById('stats')!;
  private readonly partsEl = document.getElementById('parts')!;
  private readonly driveEl = document.getElementById('drive')!;
  private readonly speedEl = document.getElementById('speed')!;
  private readonly fuelEl = document.getElementById('fuel-fill')!;
  private readonly progressEl = document.getElementById('progress-fill')!;
  private readonly standingsEl = document.getElementById('standings')!;
  private readonly feedEl = document.getElementById('feed')!;
  private readonly bannerEl = document.getElementById('banner')!;
  private readonly hintEl = document.getElementById('hint')!;
  private readonly crosshair = document.getElementById('crosshair')!;
  private readonly lockEl = document.getElementById('lock')!;
  private readonly helpEl = document.getElementById('help')!;
  private bannerTimer = 0;
  private partsDrawn = '';
  private standingsDrawn = '';
  private locked = false;
  private platform = Platform.Desktop;
  private seated = false;

  show(): void {
    this.root.hidden = false;
  }

  /** Whether the "click to play" prompt shows: only the mouse has to be captured. */
  setLocked(locked: boolean, platform: Platform): void {
    this.locked = locked;
    this.platform = platform;
    this.lockEl.hidden = locked || platform !== Platform.Desktop;
    this.crosshair.hidden = platform === Platform.Vr || this.seated;
  }

  /**
   * The builder's state, worded for the platform: `keys` names the controls ("F" or "the X button").
   */
  showBuilder(ctx: DerbyContext, b: Builder, keys: { ready: string; parts: string; help: string }): void {
    const racer = ctx.racer;
    const race = ctx.race();
    if (!racer) return;
    const r = racer.state;
    const seated = b.seated;
    if (seated !== this.seated) {
      this.seated = seated;
      this.driveEl.hidden = !seated;
      this.buildEl.parentElement!.hidden = seated;
      this.setLocked(this.locked, this.platform);
    }

    // the race, top middle
    let phase = '';
    if (race) {
      const t = race.state.timer;
      const waiting = [...ctx.world.all(Racer)].filter((x) => x.state.mode === RacerMode.Parked);
      const ready = waiting.filter((x) => x.state.ready).length;
      switch (race.state.phase) {
        case Phase.Building:
          phase = ready ? `BUILDING · ${ready} of ${waiting.length} ready · race in ${Math.ceil(t)}s` : 'BUILDING';
          break;
        case Phase.Countdown:
          phase = r.round === race.state.round ? `ON THE GRID · ${Math.ceil(t)}` : 'RACE STARTING';
          break;
        case Phase.Racing:
          phase = r.round === race.state.round ? 'RACING' : `RACE ON · ${Math.ceil(t)}s left · build for the next one`;
          break;
        case Phase.Results:
          phase = `RESULTS · back to the garage in ${Math.ceil(t)}s`;
          break;
      }
    } else {
      phase = 'LOOKING FOR THE RACE…';
    }
    this.set('phase', phase, () => (this.phaseEl.textContent = phase));

    // standings, while there's a race to show
    const round = race?.state.round ?? 0;
    const order = race && race.state.phase !== Phase.Building ? standings(ctx.world, round) : [];
    const lines = order.map((x, i) => this.line(ctx, x, i, racer));
    const key = lines.map((l) => `${l.place}${l.name}${l.detail}`).join('|');
    if (key !== this.standingsDrawn) {
      this.standingsDrawn = key;
      this.lines = lines;
      this.standingsEl.textContent = '';
      for (const l of lines) {
        const row = document.createElement('div');
        row.className = l.me ? 'me' : '';
        row.innerHTML = '<b></b><span></span><small></small>';
        row.children[0].textContent = l.place;
        row.children[1].textContent = l.name;
        row.children[2].textContent = l.detail;
        this.standingsEl.appendChild(row);
      }
      this.version++;
    }

    if (seated) {
      const kmh = Math.round(Math.abs(r.speed) * 3.6);
      const place = order.indexOf(racer);
      const drive = r.mode === RacerMode.Finished ? `FINISHED ${ordinal(place + 1)} · ${raceTime(r.finish)}` : `${kmh} km/h${place >= 0 && order.length > 1 ? ` · ${ordinal(place + 1)} of ${order.length}` : ''}`;
      this.set('drive', drive, () => (this.speedEl.textContent = drive));
      const fuel = Math.round((r.fuel / FUEL_SECONDS) * 50) / 50;
      this.set('fuel', b.stats().rockets ? fuel : 0, () => {
        this.fuelEl.style.width = `${this.fuel * 100}%`;
        this.fuelEl.parentElement!.parentElement!.hidden = !b.stats().rockets;
      });
      const progress = Math.round((Math.min(r.progress, FINISH) / FINISH) * 100) / 100;
      this.set('progress', progress, () => (this.progressEl.style.width = `${this.progress * 100}%`));
      this.set('hint', '', () => (this.hintEl.textContent = ''));
      this.set('build', '', () => {});
    } else {
      const tool = b.tool;
      const aim = b.aims[0];
      const stats = b.stats();
      const spec = PARTS[b.part];
      const build = tool === WRENCH ? 'Wrench' : `Part gun: ${spec.name}`;
      const detail = tool === WRENCH ? 'Take off the part you point at, and anything only held on by it' : spec.blurb;
      this.set('build', build, () => (this.buildEl.textContent = build));
      this.set('buildDetail', detail, () => (this.buildDetailEl.textContent = detail));
      const partsKey = `${b.part}:${tool?.id}`;
      if (partsKey !== this.partsDrawn) {
        this.partsDrawn = partsKey;
        this.partsEl.textContent = '';
        PLACEABLE.forEach((kind, i) => {
          const el = document.createElement('div');
          el.className = kind === b.part && tool === PART_GUN ? 'on' : '';
          el.style.borderColor = `#${PARTS[kind].color.toString(16).padStart(6, '0')}`;
          el.textContent = `${i + 1} ${PARTS[kind].name}`;
          this.partsEl.appendChild(el);
        });
        const wrench = document.createElement('div');
        wrench.className = tool === WRENCH ? 'on' : '';
        wrench.textContent = 'X Wrench';
        this.partsEl.appendChild(wrench);
      }
      const readyText = r.ready ? `READY · ${keys.ready} to keep building` : `${keys.ready} when you're ready to race`;
      let hint = aim.problem ? problemText(aim.problem) : '';
      if (!hint && r.mode === RacerMode.Parked && (!race || race.state.phase === Phase.Building)) hint = readyText;
      if (!hint && race && race.state.phase !== Phase.Building) hint = 'A race is on: keep building for the next one';
      this.set('hint', hint, () => (this.hintEl.textContent = hint));
      const buildStats = `${stats.parts}/${MAX_PARTS} parts · ${Math.round(stats.mass)} kg · ${stats.wheels} wheels${stats.rockets ? ` · ${stats.rockets} rockets` : ''}`;
      this.set('stats', buildStats, () => (this.statsEl.textContent = buildStats));
    }
    this.helpEl.innerHTML = keys.help;
  }

  private line(ctx: DerbyContext, racer: RacerEntity, i: number, mine: RacerEntity): StandingLine {
    const s = racer.state;
    const builder = ctx.world.getAs(BuilderDef, s.builder);
    const name = builder?.state.name ?? '?';
    const detail = s.finish ? raceTime(s.finish) : s.quit ? 'gave up' : s.mode === RacerMode.Gridded ? 'on the grid' : `${Math.round((Math.min(s.progress, FINISH) / FINISH) * 100)}%`;
    return { place: !s.quit && (s.finish || s.progress > 0) ? ordinal(i + 1) : '–', name, detail, me: racer === mine };
  }

  private set<K extends 'phase' | 'build' | 'buildDetail' | 'stats' | 'drive' | 'hint' | 'fuel' | 'progress'>(key: K, value: this[K], apply: () => void): void {
    if (this[key] === value) return;
    this[key] = value;
    apply();
    this.version++;
  }

  message(text: string): void {
    const div = document.createElement('div');
    div.textContent = text;
    this.feedEl.appendChild(div);
    while (this.feedEl.children.length > 6) this.feedEl.firstChild!.remove();
    setTimeout(() => div.remove(), 6200);
    this.feed.push({ text, until: performance.now() + 6000 });
    while (this.feed.length > 4) this.feed.shift();
    this.version++;
  }

  showBanner(text: string, color: string, ms = 2500): void {
    this.bannerEl.textContent = text;
    this.bannerEl.style.color = color;
    this.bannerEl.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.bannerEl.classList.remove('show'), ms);
    Object.assign(this.banner, { text, color, until: performance.now() + ms });
    this.version++;
  }
}
