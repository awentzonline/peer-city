import { HudBase } from '../crossplay/hud';
import { CALLS, CALL_ORDER, type CaptainRole } from './captain';
import type { ShinobiContext, ShinobiEntity } from './context';
import { Guard, GuardKind, GuardMode, Phase, Result, Shinobi, ShinobiMode } from './defs';
import { guardName } from './intel';
import type { Call } from './intent';
import { KUNAI, SHURIKEN } from './kit';
import { cssColor, shinobiColor } from './models';
import { tally } from './round';
import { MAX_HP, REVIVE_SECONDS, type ShinobiRole } from './shinobi';

/** How a platform names a shinobi's controls, for the hints. */
export interface ShinobiKeys {
  /** Climbing: "Hold Space". */
  climb: string;
  /** Using what's in hand: "Click". */
  use: string;
  /** Helping someone up: "Hold E". */
  help: string;
  /** The row of controls along the bottom, as HTML, or ''. */
  bar: string;
}

/** How a platform names the captain's controls. */
export interface CaptainKeys {
  /** Making a call: "Click where". */
  place: string;
  /** Picking out a guard: "Click a guard". */
  pick: string;
  /** Sending them to search: "Right-click". */
  send: string;
  bar: string;
}

/** A shinobi in the party list. */
export interface PartyLine {
  name: string;
  status: string;
  color: string;
  me: boolean;
}

/** What changed about the night since last frame, for a frontend to make a fuss about. */
export type NightNews = 'night' | 'slain' | 'assassinated' | 'avenged' | 'defended' | null;

/**
 * Status and announcements (see crossplay/hud.ts) for both roles. A shinobi sees their health, what they carry and how
 * visible they are; the captain sees their calls as cards, how many guards are standing and what they've been told. Both
 * see the night's clock and the band of shinobi. A headset paints the same state onto its watch.
 */
export class Hud extends HudBase {
  phase = '';
  hp = -1;
  kunai = -1;
  shuriken = -1;
  /** 0..100, rounded to fives so the watch isn't redrawn every frame. */
  exposure = -1;
  hidden = false;
  tool = '';
  /** The captain's calls, as "name|seconds left" per call. */
  calls = '';
  armed: Call | null = null;
  roster = '';
  party: PartyLine[] = [];
  /** A card was clicked or tapped. */
  onCall: ((call: Call) => void) | null = null;

  private readonly phaseEl = document.getElementById('phase')!;
  private readonly partyEl = document.getElementById('party')!;
  private readonly heartsEl = document.getElementById('hearts')!;
  private readonly eyeEl = document.getElementById('eye')!;
  private readonly kitEl = document.getElementById('kit')!;
  private readonly callsEl = document.getElementById('calls')!;
  private readonly rosterEl = document.getElementById('roster')!;
  private readonly helpEl = document.getElementById('help')!;
  private readonly cards = new Map<Call, { el: HTMLButtonElement; wait: HTMLElement }>();
  private partyDrawn = '';
  private cursorHidden = false;
  private lastPhase = -1;
  private lastRound = -1;

  setRole(role: 'shinobi' | 'captain'): void {
    document.body.dataset.role = role;
    if (role === 'captain' && !this.cards.size) this.buildCards();
  }

  hideCursor(hidden: boolean): void {
    if (hidden === this.cursorHidden) return;
    this.cursorHidden = hidden;
    this.showCursor();
  }

  protected override showCursor(): void {
    super.showCursor();
    if (this.cursorHidden && this.crosshairEl) this.crosshairEl.hidden = true;
  }

  /** The night's clock at the top, and what's changed since last frame. */
  night(ctx: ShinobiContext): NightNews {
    const round = ctx.round()?.state;
    let text = 'APPROACHING THE CASTLE…';
    let news: NightNews = null;
    if (round) {
      const band = ctx.world.all(Shinobi).size;
      switch (round.phase) {
        case Phase.Waiting:
          text = band ? `NIGHT ${round.round} · FALLS IN ${Math.ceil(round.timer)}` : `NIGHT ${round.round} · WAITING FOR SHINOBI`;
          break;
        case Phase.Night:
          text = `THE LORD LIVES · DAWN IN ${clock(round.timer)}${round.alarm > 0 ? ' · 🔔 ALARM' : ''}`;
          break;
        case Phase.Escape:
          text = `THE LORD IS DEAD · ESCAPE ${clock(round.timer)}`;
          break;
        case Phase.Over:
          text = `${resultText(round.result)} · ${round.escaped} ESCAPED · ${round.taken} TAKEN · NEXT NIGHT IN ${Math.ceil(round.timer)}`;
          break;
      }
      if (this.lastRound === round.round && this.lastPhase !== round.phase) {
        if (round.phase === Phase.Night) news = 'night';
        else if (round.phase === Phase.Escape) news = 'slain';
        else if (round.phase === Phase.Over) news = round.result === Result.Assassinated ? 'assassinated' : round.result === Result.Avenged ? 'avenged' : 'defended';
      }
      this.lastRound = round.round;
      this.lastPhase = round.phase;
    }
    this.set('phase', text, () => (this.phaseEl.textContent = text));
    return news;
  }

  /** A shinobi's status, worded for the platform. */
  showShinobi(ctx: ShinobiContext, sim: ShinobiRole, keys: ShinobiKeys): void {
    const me = ctx.me;
    if (!me) return;
    const s = me.state;
    this.set('hp', s.hp, () => (this.heartsEl.innerHTML = '♥'.repeat(s.hp) + '<i>' + '♥'.repeat(Math.max(0, MAX_HP - s.hp)) + '</i>'));
    const inv = sim.inventory;
    const kunai = inv.charges(KUNAI);
    const shuriken = inv.charges(SHURIKEN);
    const tool = inv.current?.name ?? '';
    if (kunai !== this.kunai || shuriken !== this.shuriken || tool !== this.tool) {
      this.kunai = kunai;
      this.shuriken = shuriken;
      this.tool = tool;
      this.kitEl.innerHTML = ['Tanto', `Kunai ×${kunai}`, `Shuriken ×${shuriken}`].map((t, i) => `<span class="${['Tanto', 'Kunai', 'Shuriken'][i] === tool ? 'on' : ''}"><small>${i + 1}</small>${t}</span>`).join('');
      this.version++;
    }
    const exposure = Math.round(sim.exposure * 20) * 5;
    this.set('exposure', exposure, () => {
      this.eyeEl.style.setProperty('--seen', String(exposure / 100));
    });
    this.set('hidden', sim.hidden, () => this.eyeEl.classList.toggle('hidden', sim.hidden));
    this.hideCursor(s.mode === ShinobiMode.Dead || s.mode === ShinobiMode.Escaped);
    this.showParty(ctx);
    this.setHint(shinobiHint(ctx, sim, keys));
    if (this.helpEl.innerHTML !== keys.bar) this.helpEl.innerHTML = keys.bar;
  }

  /** The captain's status, worded for the platform. */
  showCaptain(ctx: ShinobiContext, role: CaptainRole, keys: CaptainKeys, refusal: string): void {
    const calls = CALL_ORDER.map((c) => `${Math.ceil(role.cooling(c))}`).join('|');
    if (calls !== this.calls || role.armed !== this.armed) {
      this.calls = calls;
      this.armed = role.armed;
      for (const c of CALL_ORDER) {
        const card = this.cards.get(c);
        if (!card) continue;
        const wait = Math.ceil(role.cooling(c));
        card.el.classList.toggle('armed', c === role.armed);
        card.el.classList.toggle('short', wait > 0);
        card.wait.textContent = wait > 0 ? `${wait}s` : 'ready';
      }
      this.version++;
    }
    const round = ctx.round()?.state;
    const standing = role.guards().length;
    let lost = 0;
    for (const g of ctx.world.all(Guard)) if (g.render.round === round?.round && g.render.kind !== GuardKind.Lord && g.render.mode === GuardMode.Dead && role.intel.dead.has(g.id)) lost++;
    const roster = `${standing} guards standing${lost ? ` · ${lost} lost` : ''}${role.selected.size ? ` · ${role.selected.size} picked out` : ''}`;
    this.set('roster', roster, () => (this.rosterEl.textContent = roster));
    for (const text of role.intel.takeNews()) this.message(text);
    this.hideCursor(true);
    this.showParty(ctx);
    this.setHint(refusal || captainHint(ctx, role, keys));
    if (this.helpEl.innerHTML !== keys.bar) this.helpEl.innerHTML = keys.bar;
  }

  private buildCards(): void {
    CALL_ORDER.forEach((c, i) => {
      const spec = CALLS[c];
      const el = document.createElement('button');
      el.className = 'card';
      el.innerHTML = `<small>${i + 1}</small><b></b><em></em><span></span>`;
      el.children[1].textContent = spec.name;
      el.children[3].textContent = spec.blurb;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onCall?.(c);
      });
      this.callsEl.appendChild(el);
      this.cards.set(c, { el, wait: el.children[2] as HTMLElement });
    });
  }

  /** Who's in the band, and how they're doing. The captain only knows how many there are. */
  private showParty(ctx: ShinobiContext): void {
    const round = ctx.round()?.state;
    const lines: PartyLine[] = [];
    for (const sv of ctx.world.all(Shinobi) as ReadonlySet<ShinobiEntity>) {
      const s = sv.render;
      if (round && s.round && s.round !== round.round) continue;
      lines.push({ name: s.name, status: statusOf(s), color: cssColor(shinobiColor(s.skin)), me: sv === ctx.me });
    }
    if (ctx.captain && round) {
      const t = tally(ctx.world, round.round);
      lines.length = 0;
      lines.push({ name: `${t.inside + t.escaped + t.taken} shinobi tonight`, status: `${t.taken} taken`, color: '#ff5a4a', me: false });
    }
    const key = lines.map((l) => `${l.name}${l.status}`).join('|');
    if (key === this.partyDrawn) return;
    this.partyDrawn = key;
    this.party = lines;
    this.partyEl.textContent = '';
    for (const l of lines) {
      const row = document.createElement('div');
      row.className = l.me ? 'me' : '';
      row.innerHTML = '<i></i><b></b><span></span>';
      (row.children[0] as HTMLElement).style.background = l.color;
      row.children[1].textContent = l.name;
      row.children[2].textContent = l.status;
      this.partyEl.appendChild(row);
    }
    this.version++;
  }
}

function resultText(result: Result): string {
  return result === Result.Assassinated ? 'ASSASSINATED' : result === Result.Avenged ? 'LORD SLAIN, BAND TAKEN' : 'THE LORD SAW DAWN';
}

function statusOf(s: { mode: ShinobiMode; bleed: number; kills: number }): string {
  switch (s.mode) {
    case ShinobiMode.Downed:
      return `down · ${s.bleed}s`;
    case ShinobiMode.Dead:
      return 'taken';
    case ShinobiMode.Escaped:
      return 'away';
    default:
      return s.kills ? `${s.kills} down` : 'in the shadows';
  }
}

function shinobiHint(ctx: ShinobiContext, sim: ShinobiRole, keys: ShinobiKeys): string {
  const s = ctx.me!.state;
  const round = ctx.round()?.state;
  switch (s.mode) {
    case ShinobiMode.Dead:
      return 'The watch has you. Watch the others, and wait for the next night';
    case ShinobiMode.Escaped:
      return round?.phase === Phase.Escape ? 'You got away. The others are still inside…' : '';
    case ShinobiMode.Downed:
      return s.revive > 0.01 ? `Being helped up… ${Math.round(s.revive * 100)}%` : `You're down. Crawl to cover and hold on for help: ${s.bleed}s`;
  }
  if (sim.helping) return `Helping ${sim.helping.render.name} up… ${Math.round(sim.helping.render.revive * 100)}% (keep holding for ${REVIVE_SECONDS}s)`;
  for (const sv of ctx.world.query(s.x, s.y, 3, Shinobi) as ShinobiEntity[]) if (sv !== ctx.me && sv.render.mode === ShinobiMode.Downed) return `${keys.help} to help ${sv.render.name} up`;
  if (!round) return '';
  if (round.phase === Phase.Waiting) return 'Wait in the forest. When night falls, find the lord ◆ inside the walls';
  if (round.phase === Phase.Escape) return ctx.castle.inside(s.x, s.y) || !ctx.castle.outside(s.x, s.y) ? 'Get out over the wall!' : '';
  if (round.phase !== Phase.Night) return '';
  if (sim.climbing) return 'Climb up, or drop off with crouch';
  if (sim.wallAhead && keys.climb) return `${keys.climb} to climb`;
  if (sim.hidden) return 'Hidden in the bushes';
  const lord = ctx.world.getAs(Guard, round.lord);
  if (lord && Math.hypot(lord.x - s.x, lord.y - s.y) < 4 && lord.render.mode !== GuardMode.Dead) return `${keys.use} with the tanto: strike the lord from behind`;
  return '';
}

function captainHint(ctx: ShinobiContext, role: CaptainRole, keys: CaptainKeys): string {
  const round = ctx.round()?.state;
  if (!round || round.phase === Phase.Waiting) return 'The night has not fallen. When it does, the watch is yours: keep the lord alive until dawn';
  if (round.phase === Phase.Over) return '';
  if (role.armed !== null) return `${keys.place} (${CALLS[role.armed].name})`;
  if (role.selected.size) {
    const names = [...role.selected].slice(0, 3).map((id) => {
      const g = ctx.world.getAs(Guard, id);
      return g ? guardName(g) : '';
    });
    return `${names.join(', ')}${role.selected.size > 3 ? '…' : ''}: ${keys.send} to send them searching`;
  }
  if (round.phase === Phase.Escape) return 'The lord is dead. Take them before they get over the wall';
  return `${keys.pick}. You only know what your guards see and hear`;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
