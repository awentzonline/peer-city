import { HudBase } from '../crossplay/hud';
import type { HauntContext, SurvivorEntity } from './context';
import { Monster, MonsterMode, Phase, Result, Survivor, SurvivorMode } from './defs';
import { MAX_DREAD, POWERS, POWER_ORDER, type HauntRole } from './haunt';
import type { Power } from './intent';
import { cssColor, survivorColor } from './models';
import { monsterCap } from './monsters';
import { tally } from './round';
import { LOW_BATTERY, MAX_HP, REVIVE_SECONDS, type SurvivorRole } from './survivor';

/** How a platform names a survivor's controls, for the hints. */
export interface SurvivorKeys {
  /** Switching the flashlight: "Click". */
  light: string;
  /** Helping someone up: "Hold E". */
  help: string;
  /** The row of controls along the bottom, as HTML, or ''. */
  bar: string;
}

/** How a platform names the Haunt's controls. */
export interface HauntKeys {
  /** Using a power: "Click where it should come through". */
  place: string;
  /** Picking out a monster: "Click one of your monsters". */
  pick: string;
  /** Sending them: "Right-click". */
  send: string;
  bar: string;
}

/** A survivor in the party list. */
export interface PartyLine {
  name: string;
  status: string;
  color: string;
  me: boolean;
  /** For the Haunt: whether it can see where they are. */
  seen: boolean;
}

/** What changed about the night since last frame, for a frontend to make a fuss about. */
export type NightNews = 'hunt' | 'gate' | 'escaped' | 'claimed' | null;

/**
 * Status and announcements (see crossplay/hud.ts) for both roles. A survivor sees their health, battery and whether
 * they carry a key; the Haunt sees its dread, its powers as cards to tap or click, and its monsters. Both see the
 * night's clock and who's in the house. A headset paints the same state onto its watch.
 */
export class Hud extends HudBase {
  phase = '';
  /** -1 until first shown, so the first frame draws them. */
  hp = -1;
  battery = -1;
  carrying = false;
  dread = 0;
  armed: Power | null = null;
  army = '';
  party: PartyLine[] = [];
  /** A card was clicked or tapped. */
  onPower: ((power: Power) => void) | null = null;

  private readonly phaseEl = document.getElementById('phase')!;
  private readonly partyEl = document.getElementById('party')!;
  private readonly heartsEl = document.getElementById('hearts')!;
  private readonly batteryEl = document.getElementById('battery-fill')!;
  private readonly carryEl = document.getElementById('carry')!;
  private readonly dreadEl = document.getElementById('dread-fill')!;
  private readonly dreadValueEl = document.getElementById('dread-value')!;
  private readonly powersEl = document.getElementById('powers')!;
  private readonly armyEl = document.getElementById('army')!;
  private readonly helpEl = document.getElementById('help')!;
  private readonly cards = new Map<Power, HTMLButtonElement>();
  private partyDrawn = '';
  private cardsDrawn = '';
  private cursorHidden = false;
  private lastPhase = -1;
  private lastRound = -1;
  private lastOpen = false;

  /** Which role's HUD the page shows. */
  setRole(role: 'survivor' | 'haunt'): void {
    document.body.dataset.role = role;
    if (role === 'haunt' && !this.cards.size) this.buildCards();
  }

  /** Hide the crosshair (the Haunt has a pointer, the dead have nothing to aim). */
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
  night(ctx: HauntContext): NightNews {
    const round = ctx.round()?.state;
    let text = 'LOOKING FOR THE HOUSE…';
    let news: NightNews = null;
    if (round) {
      const survivors = ctx.world.all(Survivor).size;
      switch (round.phase) {
        case Phase.Waiting:
          text = survivors ? `NIGHT ${round.round} · THE HUNT BEGINS IN ${Math.ceil(round.timer)}` : `NIGHT ${round.round} · WAITING FOR SURVIVORS`;
          break;
        case Phase.Hunt:
          text = ctx.manor.gateOpen ? `THE GATE IS OPEN · ${clock(round.timer)}` : `KEYS ${round.placed}/${round.needed} · ${clock(round.timer)}`;
          break;
        case Phase.Over:
          text = `${round.escaped} ESCAPED · ${round.claimed} CLAIMED · NEXT NIGHT IN ${Math.ceil(round.timer)}`;
          break;
      }
      if (this.lastRound === round.round && this.lastPhase !== round.phase) {
        if (round.phase === Phase.Hunt) news = 'hunt';
        else if (round.phase === Phase.Over) news = round.result === Result.Escaped ? 'escaped' : 'claimed';
      }
      if (round.phase === Phase.Hunt && ctx.manor.gateOpen && !this.lastOpen && this.lastPhase === Phase.Hunt) news = 'gate';
      this.lastRound = round.round;
      this.lastPhase = round.phase;
      this.lastOpen = ctx.manor.gateOpen;
    }
    this.set('phase', text, () => (this.phaseEl.textContent = text));
    return news;
  }

  /** A survivor's status, worded for the platform. */
  showSurvivor(ctx: HauntContext, sim: SurvivorRole, keys: SurvivorKeys): void {
    const me = ctx.me;
    if (!me) return;
    const s = me.state;
    this.set('hp', s.hp, () => (this.heartsEl.innerHTML = '♥'.repeat(s.hp) + '<i>' + '♥'.repeat(Math.max(0, MAX_HP - s.hp)) + '</i>'));
    const battery = Math.round(sim.battery);
    this.set('battery', battery, () => {
      this.batteryEl.style.width = `${battery}%`;
      this.batteryEl.classList.toggle('low', battery < 25);
    });
    const carrying = !!s.key;
    this.set('carrying', carrying, () => (this.carryEl.textContent = carrying ? '🗝 You have a key' : ''));
    this.hideCursor(s.mode === SurvivorMode.Dead);
    this.showParty(ctx, null);
    this.setHint(survivorHint(ctx, sim, keys));
    if (this.helpEl.innerHTML !== keys.bar) this.helpEl.innerHTML = keys.bar;
  }

  /** The Haunt's status, worded for the platform. */
  showHaunt(ctx: HauntContext, role: HauntRole, keys: HauntKeys, refusal: string): void {
    const dread = Math.floor(role.dread);
    this.set('dread', dread, () => {
      this.dreadEl.style.width = `${(dread / MAX_DREAD) * 100}%`;
      this.dreadValueEl.textContent = String(dread);
    });
    this.set('armed', role.armed, () => {});
    const round = ctx.round()?.state;
    const mine = role.mine().length;
    let all = 0;
    for (const m of ctx.world.all(Monster)) if (m.render.mode !== MonsterMode.Dead && m.render.round === round?.round) all++;
    const cap = monsterCap(Math.max(1, round ? tally(ctx.world, round.round).inside : 1));
    const army = `${mine} yours${all > mine ? ` · ${all} in all` : ''} of ${cap}${role.selected.size ? ` · ${role.selected.size} picked out` : ''}`;
    this.set('army', army, () => (this.armyEl.textContent = army));
    const cards = POWER_ORDER.map((p) => `${p === role.armed ? 1 : 0}${POWERS[p].cost <= dread && !role.dazed ? 1 : 0}`).join('');
    if (cards !== this.cardsDrawn) {
      this.cardsDrawn = cards;
      for (const p of POWER_ORDER) {
        const card = this.cards.get(p);
        card?.classList.toggle('armed', p === role.armed);
        card?.classList.toggle('short', POWERS[p].cost > dread || role.dazed);
      }
    }
    this.hideCursor(true);
    this.showParty(ctx, role);
    this.setHint(refusal || hauntHint(ctx, role, keys));
    if (this.helpEl.innerHTML !== keys.bar) this.helpEl.innerHTML = keys.bar;
  }

  private buildCards(): void {
    POWER_ORDER.forEach((p, i) => {
      const spec = POWERS[p];
      const card = document.createElement('button');
      card.className = 'card';
      card.innerHTML = `<small>${i + 1}</small><b></b><em></em><span></span>`;
      card.children[1].textContent = spec.name;
      card.children[2].textContent = String(spec.cost);
      card.children[3].textContent = spec.blurb;
      card.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.onPower?.(p);
      });
      this.powersEl.appendChild(card);
      this.cards.set(p, card);
    });
  }

  /** Who's in the house, and how they're doing. The Haunt sees whether it knows where each is. */
  private showParty(ctx: HauntContext, role: HauntRole | null): void {
    const round = ctx.round()?.state;
    const lines: PartyLine[] = [];
    for (const sv of ctx.world.all(Survivor) as ReadonlySet<SurvivorEntity>) {
      const s = sv.render;
      if (round && s.round && s.round !== round.round) continue;
      lines.push({ name: s.name, status: statusOf(s), color: cssColor(survivorColor(s.skin)), me: sv === ctx.me, seen: !role || ctx.sightings.shows(sv) });
    }
    const key = lines.map((l) => `${l.name}${l.status}${l.seen}`).join('|');
    if (key === this.partyDrawn) return;
    this.partyDrawn = key;
    this.party = lines;
    this.partyEl.textContent = '';
    for (const l of lines) {
      const row = document.createElement('div');
      row.className = `${l.me ? 'me' : ''}${l.seen ? '' : ' unseen'}`;
      row.innerHTML = '<i></i><b></b><span></span>';
      (row.children[0] as HTMLElement).style.background = l.color;
      row.children[1].textContent = l.name;
      row.children[2].textContent = role && !l.seen && l.status === 'in the house' ? 'hiding' : l.status;
      this.partyEl.appendChild(row);
    }
    this.version++;
  }
}

function statusOf(s: { mode: SurvivorMode; hp: number; bleed: number; key: number }): string {
  switch (s.mode) {
    case SurvivorMode.Downed:
      return `down · ${s.bleed}s`;
    case SurvivorMode.Dead:
      return 'claimed';
    case SurvivorMode.Escaped:
      return 'escaped';
    default:
      return s.key ? 'has a key' : 'in the house';
  }
}

function survivorHint(ctx: HauntContext, sim: SurvivorRole, keys: SurvivorKeys): string {
  const s = ctx.me!.state;
  const round = ctx.round()?.state;
  switch (s.mode) {
    case SurvivorMode.Dead:
      return 'The house has you. Watch the others, and wait for the next night';
    case SurvivorMode.Escaped:
      return round?.phase === Phase.Hunt ? 'You got out. The others are still inside…' : '';
    case SurvivorMode.Downed:
      return s.revive > 0.01 ? `Being helped up… ${Math.round(s.revive * 100)}%` : `You're down. Crawl to the others, or hold on for help: ${s.bleed}s`;
  }
  if (sim.helping) return `Helping ${sim.helping.render.name} up… ${Math.round(sim.helping.render.revive * 100)}% (keep holding for ${REVIVE_SECONDS}s)`;
  if (!round) return '';
  if (round.phase === Phase.Waiting) return 'Wait by the gate. When the hunt begins, find the keys in the house';
  if (round.phase !== Phase.Hunt) return '';
  for (const sv of ctx.world.query(s.x, s.y, 3, Survivor) as SurvivorEntity[]) if (sv !== ctx.me && sv.render.mode === SurvivorMode.Downed) return `${keys.help} to help ${sv.render.name} up`;
  if (ctx.manor.gateOpen) return 'The gate is open. Get out!';
  if (s.key) return 'Take the key to the pedestal by the gate';
  if (s.light && sim.battery < 20) return 'Your battery is running low';
  if (!s.light && sim.battery < LOW_BATTERY) return 'Your flashlight is flat. Let it rest';
  if (!s.light) return `${keys.light} to switch your flashlight on. It gives you away`;
  return '';
}

function hauntHint(ctx: HauntContext, role: HauntRole, keys: HauntKeys): string {
  const round = ctx.round()?.state;
  if (role.dazed) return 'The light burns! You recoil…';
  if (!round || round.phase === Phase.Waiting) return 'Survivors gather at the gate. When the night begins, summon where none of them can see';
  if (round.phase !== Phase.Hunt) return '';
  if (role.armed !== null) return `${keys.place} (${POWERS[role.armed].name}, ${POWERS[role.armed].cost} dread)`;
  if (role.selected.size) return `${keys.send} to send them, or after a survivor you can see`;
  if (role.mine().length) return `${keys.pick}, or pick a power`;
  return 'Pick a power, then summon it somewhere no survivor can see';
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
