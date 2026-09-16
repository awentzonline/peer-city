import { HudBase } from '../crossplay/hud';
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
 * Status and announcements (see crossplay/hud.ts). A headset paints the same state onto panels in the scene
 * (wrist.ts). Frontends call `showBuilder` every frame with how the device names its controls.
 */
export class Hud extends HudBase {
  phase = '';
  build = '';
  buildDetail = '';
  stats = '';
  drive = '';
  /** Starts unset, so the first frame decides whether the rockets bar shows at all. */
  fuel = -1;
  progress = 0;
  lines: StandingLine[] = [];

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
  private readonly helpEl = document.getElementById('help')!;
  private partsDrawn = '';
  private standingsDrawn = '';
  private seated = false;

  /** No crosshair while driving. */
  protected override showCursor(): void {
    super.showCursor();
    if (this.seated && this.crosshairEl) this.crosshairEl.hidden = true;
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
      this.showCursor();
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
      this.setHint('');
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
      const shelf = b.aims.find((x) => x.shelf)?.shelf;
      let hint = shelf ? b.shelfText(shelf) : aim.problem ? problemText(aim.problem) : '';
      if (!hint && r.mode === RacerMode.Parked && (!race || race.state.phase === Phase.Building)) hint = readyText;
      if (!hint && race && race.state.phase !== Phase.Building) hint = 'A race is on: keep building for the next one';
      this.setHint(hint);
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
}
