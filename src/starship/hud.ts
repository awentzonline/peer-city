import { HudBase } from '../crossplay/hud';
import type { CrewEntity, StarshipContext } from './context';
import { selfBeam, type CrewRole } from './crew';
import { PAD } from './deck';
import { Carry, Crew, CrewMode, Fault, FaultKind, Phase, Raider, Relic, Result, Screen, Station } from './defs';
import { EXTINGUISHER, PHASER, SPANNER } from './kit';
import { STATION_COLORS, css } from './models';
import { manning } from './officer';
import { bitCount } from './sector';
import { SHIELD_MAX, SYSTEM_NAMES } from './ship';
import { clock, phaseLine } from './scopes';
import { STATION_NAMES } from './stations';

/** How a platform names a crew member's controls, for the hints. */
export interface CrewKeys {
  /** Take, load, pick up, sit: "E". */
  use: string;
  /** Use the tool in hand: "Click". */
  fire: string;
  /** Switch tools: "1 2 3". */
  tools: string;
  bar: string;
  /** False where consoles aren't sat at (a headset points at them instead). */
  sit?: boolean;
}

/** What changed about the voyage since last frame, for a frontend to make a fuss about. */
export type VoyageNews = 'underway' | 'alert' | 'relic' | 'victory' | 'lost' | 'briefing' | null;

export const SHIP_NAME = 'WAYFARER';

const SCREEN_LABELS: Record<Screen, string> = {
  [Screen.Forward]: 'FORWARD VIEW',
  [Screen.Aft]: 'AFT VIEW',
  [Screen.Tactical]: 'TACTICAL',
  [Screen.Target]: 'TARGET',
  [Screen.Away]: 'AWAY TEAM',
};

/**
 * Status and announcements (see crossplay/hud.ts) for the viewscreen and the crew; stations draw their own panel and
 * only borrow the feed. Everyone sees how the voyage stands, the hull and shields and red alert, and who's where. A crew
 * member also sees their health, what they're carrying and holding, and where they are. A headset paints it on a watch.
 */
export class Hud extends HudBase {
  phase = '';
  hull = -1;
  shields = -1;
  alert = false;
  hp = -1;
  tool = '';
  place = '';
  carry = Carry.Nothing;
  roster: { name: string; where: string; color: string }[] = [];
  private lastPhase = -1;
  private lastVoyage = -1;
  private lastAlert = false;
  private lastRelics = 0;
  private rosterDrawn = '';

  private readonly phaseEl = document.getElementById('phase');
  private readonly hullEl = document.querySelector<HTMLElement>('#shipstat .hull i');
  private readonly shieldsEl = document.querySelector<HTMLElement>('#shipstat .shields i');
  private readonly alertEl = document.getElementById('alert');
  private readonly rosterEl = document.getElementById('roster');
  private readonly hpEl = document.querySelector<HTMLElement>('#vitals .hp i');
  private readonly carryEl = document.getElementById('carry');
  private readonly toolEl = document.getElementById('tools');
  private readonly placeEl = document.getElementById('place');
  private readonly screenEl = document.getElementById('screen-mode');
  private readonly helpEl = document.getElementById('help');

  setRole(role: 'station' | 'viewer' | 'crew'): void {
    document.body.dataset.role = role;
  }

  /** The ship's status, for everyone, and what's changed since last frame. */
  ship(ctx: StarshipContext): VoyageNews {
    const ship = ctx.ship()?.render;
    if (!ship) {
      this.set('phase', 'LOOKING FOR THE SHIP…', () => this.phaseEl && (this.phaseEl.textContent = 'LOOKING FOR THE SHIP…'));
      return null;
    }
    const text = `${SHIP_NAME} · ${phaseLine(ctx, ship)}`;
    this.set('phase', text, () => this.phaseEl && (this.phaseEl.textContent = text));
    const hull = Math.round(ship.hull);
    this.set('hull', hull, () => this.hullEl && (this.hullEl.style.width = `${hull}%`));
    const shields = Math.round((ship.shields / SHIELD_MAX) * 100);
    this.set('shields', shields, () => {
      if (!this.shieldsEl) return;
      this.shieldsEl.style.width = `${shields}%`;
      this.shieldsEl.classList.toggle('down', !ship.shieldsUp);
    });
    this.set('alert', ship.alert, () => this.alertEl?.classList.toggle('on', ship.alert));
    this.showRoster(ctx);

    let news: VoyageNews = null;
    if (this.lastVoyage === ship.voyage) {
      if (this.lastPhase !== ship.phase) news = ship.phase === Phase.Underway ? 'underway' : ship.phase === Phase.Briefing ? 'briefing' : ship.result === Result.Victory ? 'victory' : 'lost';
      else if (ship.alert && !this.lastAlert) news = 'alert';
      else if (bitCount(ship.relics) > bitCount(this.lastRelics)) news = 'relic';
    } else if (this.lastVoyage !== -1) news = 'briefing';
    this.lastVoyage = ship.voyage;
    this.lastPhase = ship.phase;
    this.lastAlert = ship.alert;
    this.lastRelics = ship.relics;
    return news;
  }

  /** The viewscreen's mode, in its corner. */
  viewer(mode: Screen, awayName: string): void {
    const text = mode === Screen.Away ? (awayName ? `AWAY TEAM · ${awayName.toUpperCase()}` : 'AWAY TEAM · NOBODY IS DOWN THERE') : SCREEN_LABELS[mode];
    if (this.screenEl && this.screenEl.textContent !== text) this.screenEl.textContent = text;
    this.hideCursor();
  }

  /** A crew member's status and hint, worded for the platform. */
  crew(ctx: StarshipContext, role: CrewRole, keys: CrewKeys): void {
    const me = ctx.me;
    if (!me) return;
    const s = me.state;
    const hp = Math.round(s.hp);
    this.set('hp', hp, () => this.hpEl && (this.hpEl.style.width = `${hp}%`));
    const tool = role.sitting !== null || s.carry !== Carry.Nothing ? '' : (role.inventory.current?.name ?? '');
    if (tool !== this.tool) {
      this.tool = tool;
      if (this.toolEl) this.toolEl.innerHTML = [PHASER, SPANNER, EXTINGUISHER].map((t, i) => `<span class="${t.name === tool ? 'on' : ''}"><small>${i + 1}</small>${t.name}</span>`).join('');
      this.version++;
    }
    const carry = s.carry;
    this.set('carry', carry, () => this.carryEl && (this.carryEl.textContent = carry === Carry.Torpedo ? 'Carrying a torpedo' : carry === Carry.Relic ? 'Carrying the relic' : ''));
    const place = ctx.deck.placeName(me.x, me.y, (i) => ctx.sector.planets[i].name);
    this.set('place', place, () => this.placeEl && (this.placeEl.textContent = place));
    this.setHint(crewHint(ctx, role, keys));
    if (this.helpEl && this.helpEl.innerHTML !== keys.bar) this.helpEl.innerHTML = keys.bar;
  }

  private hideCursor(): void {
    if (this.crosshairEl && !this.crosshairEl.hidden) this.crosshairEl.hidden = true;
  }

  protected override showCursor(): void {
    super.showCursor();
    if (document.body.dataset.role !== 'crew' && this.crosshairEl) this.crosshairEl.hidden = true;
  }

  /** Who's at which station, and where the crew are. */
  private showRoster(ctx: StarshipContext): void {
    const lines: { name: string; where: string; color: string }[] = [];
    for (const [station, names] of manning(ctx)) {
      for (const name of names) lines.push({ name, where: station === Station.Viewer ? 'viewscreen' : STATION_NAMES[station].toLowerCase(), color: css(STATION_COLORS[station]) });
    }
    for (const c of ctx.world.all(Crew) as ReadonlySet<CrewEntity>) {
      const r = c.render;
      const where = r.mode === CrewMode.Down ? 'hurt' : r.seat ? `${STATION_NAMES[(r.seat - 1) as Station].toLowerCase()} console` : ctx.deck.placeName(c.x, c.y, (i) => ctx.sector.planets[i].name).toLowerCase();
      lines.push({ name: r.name, where, color: c === ctx.me ? '#ffd35a' : '#e8ecf4' });
    }
    const key = lines.map((l) => `${l.name}|${l.where}`).join(',');
    if (key === this.rosterDrawn) return;
    this.rosterDrawn = key;
    this.roster = lines;
    if (this.rosterEl) {
      this.rosterEl.textContent = '';
      for (const l of lines) {
        const row = document.createElement('div');
        row.innerHTML = '<i></i><b></b><span></span>';
        (row.children[0] as HTMLElement).style.background = l.color;
        row.children[1].textContent = l.name;
        row.children[2].textContent = l.where;
        this.rosterEl.appendChild(row);
      }
    }
    this.version++;
  }
}

function crewHint(ctx: StarshipContext, role: CrewRole, keys: CrewKeys): string {
  const me = ctx.me!;
  const s = me.state;
  const ship = ctx.ship()?.render;
  if (s.mode === CrewMode.Down) return "You're hurt. The medics will have you back on your feet in sickbay in a moment";
  if (role.sitting !== null) return `At the ${STATION_NAMES[role.sitting].toLowerCase()} console. ${keys.use} to stand up`;
  const n = role.nearby;
  if (s.carry === Carry.Torpedo) {
    if (n?.kind === 'tube') return n.loaded ? 'That tube is loaded' : `${keys.use} to load the torpedo`;
    if (n?.kind === 'rack') return `${keys.use} to put it back`;
    return 'Carry the torpedo to an empty tube at the end of the torpedo room';
  }
  const self = selfBeam(ctx);
  if (s.carry === Carry.Relic && self) return `Got it! Get clear of the drones, then ${keys.use} to beam up with it`;
  if (s.carry === Carry.Relic) return `Got it! Get clear of the drones and ask science to beam you up. ${keys.use} to put it down`;
  if (n?.kind === 'relic') return `${keys.use} to take the relic`;
  // a headset works a console by pointing at it: the console lighting up says as much as a hint could
  if (n?.kind === 'console') return keys.sit === false ? '' : `${keys.use} to sit at the ${STATION_NAMES[n.console.station].toLowerCase()} console`;
  if (n?.kind === 'rack') return ship && ship.torps > 0 ? `${keys.use} to take a torpedo (${ship.torps} in the rack)` : 'The rack is empty. The starbase can restock it';
  if (n?.kind === 'tube') return n.loaded ? 'Tube loaded' : 'Tube empty: bring a torpedo from the rack';

  const tool = role.inventory.current;
  const near = ctx.world.query(s.x, s.y, 5, Fault);
  if (near.length) {
    const aimed = role.lookingAtFault();
    if (aimed) return aimed.render.kind === FaultKind.Fire ? `Hold ${keys.fire} to put the fire out` : `Hold ${keys.fire} to fix the conduit`;
    const fire = near.some((f) => f.render.kind === FaultKind.Fire);
    const sparks = near.some((f) => f.render.kind === FaultKind.Sparks);
    if (fire && tool !== EXTINGUISHER) return `Fire! Take the extinguisher (${keys.tools.split(' ')[2] ?? '3'})`;
    if (sparks && !fire && tool !== SPANNER) return `Sparking conduits: take the spanner (${keys.tools.split(' ')[1] ?? '2'})`;
    return fire ? 'Get close to the fire and spray it' : 'Get close to the sparks with the spanner';
  }
  if (!ship) return '';
  if (!ctx.deck.onShip(s.x)) {
    const relic = [...ctx.world.all(Relic)].some((r) => r.render.site === ctx.deck.siteAt(s.x) + 1);
    const home = ship.relics & (1 << ctx.deck.siteAt(s.x));
    if (self) return home ? `The relic from here is aboard. ${keys.use} to beam up` : relic ? `The relic is on a plinth in the ruins. ${keys.use} to beam up` : `Nothing here. ${keys.use} to beam up`;
    if (home) return 'The relic from here is aboard. Ask science to beam you up';
    if (relic) return `The relic is on a plinth in the ruins. Mind the drones: ${tool === PHASER ? `${keys.fire} to shoot` : `take your phaser (${keys.tools.split(' ')[0] ?? '1'})`}`;
    return 'Nothing here. Ask science to beam you up';
  }
  if (Math.hypot(s.x - PAD.x, s.y - PAD.y) <= PAD.radius) {
    if (self) return `On the pad. ${keys.use} to beam down`;
    return ship.orbit ? 'On the pad. Science can beam you down once the shields are down' : 'On the transporter pad: when the ship is in orbit, science can beam you down';
  }
  if (ship.phase === Phase.Briefing) return `Docked at the starbase. Casting off in ${clock(ship.timer)}: take a console on the bridge, or get ready by the transporter`;
  const faults = [...ctx.world.all(Fault)];
  if (faults.length) {
    const f = faults[0];
    return `${f.render.kind === FaultKind.Fire ? 'Fire' : 'Damage'} in the ${ctx.deck.roomAt(f.x, f.y)?.name.toLowerCase() ?? 'ship'}: it's hurting the ${SYSTEM_NAMES[f.render.system].toLowerCase()}`;
  }
  if (ctx.world.all(Raider).size && ship.tubes !== 3 && ship.torps > 0) return 'Raiders! The torpedo tubes need loading';
  if (ship.orbit && ctx.sector.hasRelic(ship.voyage, ship.orbit - 1) && !(ship.relics & (1 << (ship.orbit - 1)))) return 'In orbit of a relic world: get on the transporter pad';
  return '';
}
