import { HudBase } from '../crossplay/hud';
import { waterLevel, type LordEntity, type SewerContext } from './context';
import { Lord, LordMode, Phase, Result, VALVE_FIELDS } from './defs';
import { HOSE } from './kit';
import { SACK_MAX } from './loot';
import { MAX_HP, type LordRole } from './lord';
import { cssColor, lordColor } from './models';
import { WATER_MAX, tally } from './round';

/** How a platform names a Lord's controls, for the hints. */
export interface LordKeys {
  /** Doing whatever's at hand (helping up, climbing, a valve, digging): "Hold E". */
  interact: string;
  /** Pumping the hose: "Tap R". */
  pump: string;
  /** Grabbing a goblin: "E". */
  grab: string;
  /** With a goblin in hand: what throws it and what tears it. */
  hold: string;
  /** The row of controls along the bottom, as HTML, or ''. */
  bar: string;
}

export interface PartyLine {
  name: string;
  status: string;
  color: string;
  me: boolean;
}

/** What changed about the dive since last frame, for a frontend to make a fuss about. */
export type DiveNews = 'dive' | 'rich' | 'lost' | 'surge' | 'breach' | null;

const ACTIONS: Record<string, string> = { revive: 'HAULING UP', climb: 'CLIMBING OUT', valve: 'OPENING THE VALVE', dig: 'DIGGING', tear: 'PULLING APART' };

/**
 * Status and announcements (see crossplay/hud.ts): the dive and the water at the top, who's down here, and your own
 * health, air, hose pressure, detector and sack. A headset paints the same state onto its watch.
 */
export class Hud extends HudBase {
  phase = '';
  hp = -1;
  air = -1;
  charge = -1;
  signal = 0;
  sweeping = false;
  sack = -1;
  worth = -1;
  /** The water, 0 (low) to 1 (at the top), and whether it's surging. */
  water = 0;
  surge = false;
  action = '';
  progress = 0;
  hose = false;
  party: PartyLine[] = [];

  private readonly phaseEl = document.getElementById('phase')!;
  private readonly partyEl = document.getElementById('party')!;
  private readonly heartsEl = document.getElementById('hearts')!;
  private readonly airEl = document.getElementById('air')!;
  private readonly airFill = document.getElementById('air-fill')!;
  private readonly chargeEl = document.getElementById('charge')!;
  private readonly chargeFill = document.getElementById('charge-fill')!;
  private readonly detectEl = document.getElementById('detector')!;
  private readonly needleEl = document.getElementById('needle')!;
  private readonly sackEl = document.getElementById('sack')!;
  private readonly waterFill = document.getElementById('water-fill')!;
  private readonly waterEl = document.getElementById('water')!;
  private readonly actionEl = document.getElementById('action')!;
  private readonly actionLabel = document.getElementById('action-label')!;
  private readonly actionFill = document.getElementById('action-fill')!;
  private readonly helpEl = document.getElementById('help')!;
  private partyDrawn = '';
  private lastPhase = -1;
  private lastDive = -1;
  private lastSurge = false;
  private lastBreach = false;

  /** The dive's clock and the water at the top, and what's changed since last frame. */
  dive(ctx: SewerContext): DiveNews {
    const e = ctx.sewer()?.render;
    let text = 'FINDING THE SEWER…';
    let news: DiveNews = null;
    if (e) {
      switch (e.phase) {
        case Phase.Gather:
          text = ctx.world.all(Lord).size ? `DIVE ${e.dive} · DOWN WE GO IN ${Math.ceil(e.timer)}` : `DIVE ${e.dive} · WAITING FOR LORDZ`;
          break;
        case Phase.Dive:
          text = `DIVE ${e.dive} · BANKED £${e.worth}${e.breached ? ' · VAULT OPEN' : ''}`;
          break;
        case Phase.Over:
          text = e.result === Result.Rich ? `OUT WITH £${e.worth} · NEXT DIVE IN ${Math.ceil(e.timer)}` : `THE SEWER KEEPS IT ALL · NEXT DIVE IN ${Math.ceil(e.timer)}`;
          break;
      }
      if (this.lastDive === e.dive && this.lastPhase !== e.phase) {
        if (e.phase === Phase.Dive) news = 'dive';
        else if (e.phase === Phase.Over) news = e.result === Result.Rich ? 'rich' : 'lost';
      }
      if (e.phase === Phase.Dive && e.surge && !this.lastSurge) news = 'surge';
      if (e.phase === Phase.Dive && e.breached && !this.lastBreach && this.lastPhase === Phase.Dive) news = 'breach';
      this.lastDive = e.dive;
      this.lastPhase = e.phase;
      this.lastSurge = e.surge;
      this.lastBreach = e.breached;
      const level = Math.max(0, Math.min(1, (waterLevel(ctx) - 0.3) / (WATER_MAX - 0.3)));
      this.set('water', Math.round(level * 50) / 50, () => (this.waterFill.style.height = `${level * 100}%`));
      this.set('surge', e.surge, () => this.waterEl.classList.toggle('surge', e.surge));
    }
    this.set('phase', text, () => (this.phaseEl.textContent = text));
    return news;
  }

  /** A Lord's status, worded for the platform. */
  showLord(ctx: SewerContext, lord: LordRole, keys: LordKeys): void {
    const me = ctx.me;
    if (!me) return;
    const s = me.state;
    this.set('hp', s.hp, () => (this.heartsEl.innerHTML = '♥'.repeat(s.hp) + '<i>' + '♥'.repeat(Math.max(0, MAX_HP - s.hp)) + '</i>'));
    const air = Math.round(s.air * 20) / 20;
    this.set('air', air, () => {
      this.airEl.hidden = air >= 1;
      this.airFill.style.width = `${air * 100}%`;
    });
    const hose = lord.inventory.current === HOSE || s.tool === HOSE.id || s.ltool === HOSE.id;
    this.set('hose', hose, () => (this.chargeEl.hidden = !hose));
    const charge = Math.round(lord.charge);
    this.set('charge', charge, () => {
      this.chargeFill.style.width = `${charge}%`;
      this.chargeFill.classList.toggle('low', charge < 15);
    });
    this.set('sweeping', lord.sweeping, () => (this.detectEl.hidden = !lord.sweeping));
    const signal = Math.round(lord.signal * 20) / 20;
    this.set('signal', signal, () => (this.needleEl.style.transform = `rotate(${-60 + signal * 120}deg)`));
    this.set('sack', s.sack, () => (this.sackEl.textContent = s.sack ? `💰 ${s.sack}/${SACK_MAX} in your sack: get it to the ladder` : ''));
    const act = lord.action;
    const label = act ? ACTIONS[act.kind] : '';
    this.set('action', label, () => {
      this.actionEl.hidden = !label;
      this.actionLabel.textContent = label;
    });
    const progress = Math.round((act?.progress ?? 0) * 50) / 50;
    this.set('progress', progress, () => (this.actionFill.style.width = `${progress * 100}%`));
    this.setHint(hint(ctx, lord, keys));
    if (this.helpEl.innerHTML !== keys.bar) this.helpEl.innerHTML = keys.bar;
    this.showParty(ctx);
  }

  private showParty(ctx: SewerContext): void {
    const e = ctx.sewer()?.render;
    const lines: PartyLine[] = [];
    for (const l of ctx.world.all(Lord) as ReadonlySet<LordEntity>) {
      const s = l.render;
      const status = s.mode === LordMode.Downed ? `DOWN · ${s.bleed}s` : s.mode === LordMode.Dead ? 'lost' : s.mode === LordMode.Surfaced ? 'out' : s.sack ? `💰${s.sack}` : `${'♥'.repeat(s.hp)}`;
      lines.push({ name: s.name, status, color: cssColor(lordColor(s.skin)), me: l === ctx.me });
    }
    lines.sort((a, b) => a.name.localeCompare(b.name));
    const valves = e ? VALVE_FIELDS.map((f) => (e[f] > 0.05 ? '◉' : '○')).join(' ') : '';
    const sig = JSON.stringify(lines) + valves;
    if (sig === this.partyDrawn) return;
    this.partyDrawn = sig;
    this.party = lines;
    this.version++;
    const t = e ? tally(ctx.world, e.dive) : null;
    this.partyEl.innerHTML =
      lines.map((l) => `<div class="${l.me ? 'me' : ''}"><i style="background:${l.color}"></i><b>${escape(l.name)}</b><span>${l.status}</span></div>`).join('') +
      (e?.phase === Phase.Dive ? `<div class="valves"><b>VALVES</b><span>${valves}</span></div>` : '') +
      (t && t.surfaced ? `<div><b>Up top</b><span>${t.surfaced}</span></div>` : '');
  }
}

/** What to tell the player they could do right now. */
function hint(ctx: SewerContext, lord: LordRole, keys: LordKeys): string {
  const me = ctx.me;
  if (!me) return '';
  const s = me.state;
  const e = ctx.sewer()?.render;
  if (s.mode === LordMode.Downed) return lord.action ? '' : `You’re down! Crawl to the others to be hauled up, or ${keys.interact} to drag yourself up if nobody's coming`;
  if (s.mode === LordMode.Dead || s.mode === LordMode.Surfaced) return '';
  if (lord.action) return '';
  if (s.holding) return keys.hold;
  if (s.air < 0.6) return 'Get your head out of the sewage! Up on a walkway';
  if (lord.helping === null && lord.downedNear()) return `${keys.interact} to haul them up`;
  if (e?.phase === Phase.Dive && lord.atLadder()) return `${keys.interact} to climb out${s.sack ? '' : ' (your haul’s banked)'}`;
  if (lord.valveNear() >= 0 && keys.interact) return `${keys.interact} to open the relief valve`;
  if (lord.goblinInFront(1.8) && keys.grab) return `Punch it! Or ${keys.grab} to grab it`;
  if ((lord.inventory.current === HOSE || s.tool === HOSE.id || s.ltool === HOSE.id) && lord.charge < 10) return `${keys.pump} to pump up the pressure`;
  if (lord.sweeping && lord.signal > 0.6 && keys.interact) return `Something’s right here: ${keys.interact} to dig`;
  if (e?.phase === Phase.Dive && e.water > 1.3) return 'The water’s getting deep: open the relief valves!';
  return '';
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
