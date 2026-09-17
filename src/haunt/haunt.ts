import { Platform } from '../crossplay/platform';
import type { Frontend, Role } from '../crossplay/role';
import type { HauntContext, HauntEntity, MonsterEntity, SurvivorEntity } from './context';
import { Feed, Haunt as HauntDef, Monster, MonsterKind, MonsterMode, Noise, Order, OrderKind, Phase, Sound, Survivor, SurvivorMode } from './defs';
import { Power, type HauntIntent } from './intent';
import { MONSTERS, monsterCap, summon, summonRefusal } from './monsters';
import { tally } from './round';

/** How the Haunt's rules reach back to the device playing it. */
export interface HauntBody {
  readonly platform: Platform;
  /** A power was used at (x, y). */
  used(power: Power, x: number, y: number): void;
  /** It couldn't be: why. */
  refused(reason: string): void;
  /** Monsters were sent to (x, y), after a survivor if `attack`. */
  ordered(x: number, y: number, attack: boolean): void;
  /** A survivor's flashlight drove the Haunt's presence back. */
  glared(by: string): void;
}

export type HauntFrontend = Frontend<HauntIntent> & HauntBody;

export interface PowerSpec {
  name: string;
  cost: number;
  /** What it does, for the cards. */
  blurb: string;
}

export const POWERS: Record<Power, PowerSpec> = {
  [Power.Shade]: { name: 'Shade', cost: MONSTERS[MonsterKind.Shade].cost, blurb: 'Drifts after anyone it sees. Burns fast in light.' },
  [Power.Crawler]: { name: 'Crawler', cost: MONSTERS[MonsterKind.Crawler].cost, blurb: 'Quick and weak. Runs from light, then comes back.' },
  [Power.Brute]: { name: 'Brute', cost: MONSTERS[MonsterKind.Brute].cost, blurb: 'Slow and hard to burn. Hits twice as hard.' },
  [Power.Whisper]: { name: 'Whisper', cost: 8, blurb: 'Unsettles survivors near it: you see where they are.' },
};

export const POWER_ORDER: readonly Power[] = [Power.Shade, Power.Crawler, Power.Brute, Power.Whisper];

/** Dread you start a night with, and the most you can have. */
export const START_DREAD = 60;
export const MAX_DREAD = 200;
/** Dread a second, and more for each survivor inside. Shared between everyone playing the Haunt. */
const DREAD_RATE = 1.6;
const DREAD_PER_SURVIVOR = 0.9;
/** How far a whisper carries, and how long it gives survivors away, ms. */
export const WHISPER_RADIUS = 12;
export const WHISPER_MS = 5000;
/** Gathering picks out monsters this near the pointer. */
export const GATHER_RADIUS = 9;
/** A glare: dread lost, and how long the presence is gone and nothing can be summoned, ms. */
const GLARE_DREAD = 25;
const GLARE_MS = 2500;
/** A presence fades this long after the pointer last moved, ms. */
const LINGER_MS = 4000;

const NO_BODY: HauntBody = { platform: Platform.Desktop, used() {}, refused() {}, ordered() {}, glared() {} };

/**
 * The player as the Haunt: no body, just attention. It watches the house from above, summons monsters where nobody's
 * looking with the dread that builds through the night, picks them out and sends them after survivors, and whispers
 * to give them away. It only sees survivors who show themselves (`ctx.sightings`). Where it points, survivors feel a
 * presence, and a flashlight on that drives it back.
 */
export class HauntRole implements Role<HauntIntent, HauntFrontend> {
  body: HauntBody = NO_BODY;
  armed: Power | null = null;
  /** The monsters picked out, by id. */
  readonly selected = new Set<number>();
  dread = START_DREAD;
  private night = 0;
  private hiddenUntil = 0;
  private pointedAt = -1e9;
  private readonly lastPointer = { x: 0, y: 0 };

  constructor(readonly ctx: HauntContext) {}

  get me(): HauntEntity | null {
    return this.ctx.haunt;
  }

  /** Recovering from a glare: nothing can be done. */
  get dazed(): boolean {
    return this.ctx.now < this.hiddenUntil;
  }

  attach(body: HauntBody): void {
    this.body = body;
  }

  spawn(): void {
    const { ctx } = this;
    ctx.haunt = ctx.world.spawn(HauntDef, { x: 40, y: 40, name: ctx.playerName, dread: START_DREAD });
    ctx.world.setFocus(40, 40, 140);
  }

  /** Your monsters, still about. */
  mine(): MonsterEntity[] {
    const me = this.me;
    if (!me) return [];
    const out: MonsterEntity[] = [];
    for (const m of this.ctx.world.all(Monster)) if (m.render.haunt === me.id && m.render.mode !== MonsterMode.Dead) out.push(m);
    return out;
  }

  update(dt: number, intent: HauntIntent): void {
    const { ctx } = this;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    s.platform = this.body.platform;
    s.x = intent.focus.x;
    s.y = intent.focus.y;
    ctx.world.setFocus(s.x, s.y, 140);
    this.nightly(dt);
    this.point(intent);
    this.prune();

    if (intent.arm !== null) this.armed = intent.arm === 'none' || intent.arm === this.armed ? null : intent.arm;
    if (intent.selectAll) this.selectAll();
    if (intent.select) {
      if (!intent.select.add) this.selected.clear();
      for (const id of intent.select.ids) if (this.isMine(id)) this.selected.add(id);
    }
    const p = intent.pointer;
    if (p && intent.gather) this.gather(p.x, p.y);
    if (p && intent.primary) this.primary(p.x, p.y, intent.reach);
    if (p && intent.secondary) {
      if (this.armed !== null) this.armed = null;
      else this.order(p.x, p.y, intent.reach);
    }
    s.dread = Math.floor(this.dread);
  }

  /** Dread builds through the night, faster with more survivors to frighten, and a new night starts afresh. */
  private nightly(dt: number): void {
    const { world } = this.ctx;
    const round = this.ctx.round()?.state;
    if (!round) return;
    if (round.round !== this.night) {
      this.night = round.round;
      this.dread = START_DREAD;
      this.selected.clear();
      this.armed = null;
    }
    if (round.phase !== Phase.Hunt) return;
    const haunts = Math.max(1, world.all(HauntDef).size);
    const inside = tally(world, round.round).inside;
    this.dread = Math.min(MAX_DREAD, this.dread + ((DREAD_RATE + DREAD_PER_SURVIVOR * inside) / haunts) * dt);
  }

  /** Where the device points is where survivors feel the presence, for a while after it stops moving. */
  private point(intent: HauntIntent): void {
    const s = this.me!.state;
    const p = intent.pointer;
    if (p && (Math.hypot(p.x - this.lastPointer.x, p.y - this.lastPointer.y) > 0.05 || intent.primary || intent.secondary)) {
      this.pointedAt = this.ctx.now;
      this.lastPointer.x = p.x;
      this.lastPointer.y = p.y;
    }
    s.px = this.lastPointer.x;
    s.py = this.lastPointer.y;
    s.present = !this.dazed && this.ctx.now - this.pointedAt < LINGER_MS;
  }

  /** Forget monsters that are gone. */
  private prune(): void {
    for (const id of this.selected) if (!this.isMine(id)) this.selected.delete(id);
  }

  private isMine(id: number): boolean {
    const m = this.ctx.world.getAs(Monster, id);
    return !!m && m.render.haunt === this.me?.id && m.render.mode !== MonsterMode.Dead;
  }

  private selectAll(): void {
    const mine = this.mine();
    if (mine.length && mine.every((m) => this.selected.has(m.id))) {
      this.selected.clear();
      return;
    }
    for (const m of mine) this.selected.add(m.id);
  }

  private gather(x: number, y: number): void {
    this.selected.clear();
    for (const m of this.mine()) if (Math.hypot(m.x - x, m.y - y) < GATHER_RADIUS) this.selected.add(m.id);
    if (!this.selected.size) this.body.refused('None of your monsters are near there');
  }

  /** Use the armed power, or pick out a monster, or send the picked-out ones. */
  private primary(x: number, y: number, reach: number): void {
    if (this.armed !== null) {
      this.use(this.armed, x, y);
      return;
    }
    let pick: MonsterEntity | null = null;
    let best = Math.max(reach, 1.2);
    for (const m of this.mine()) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < best) {
        best = d;
        pick = m;
      }
    }
    if (pick) {
      if (this.selected.has(pick.id)) this.selected.delete(pick.id);
      else this.selected.add(pick.id);
      return;
    }
    if (this.selected.size) this.order(x, y, reach);
    else if (this.mine().length) this.body.refused('Pick out a monster first');
    else this.body.refused('Summon something first');
  }

  private use(power: Power, x: number, y: number): void {
    const { ctx } = this;
    const round = ctx.round()?.state;
    const spec = POWERS[power];
    if (!round || round.phase !== Phase.Hunt) return this.body.refused(round?.phase === Phase.Over ? 'The night is over' : "The night hasn't begun");
    if (this.dazed) return this.body.refused('The light still burns');
    if (this.dread < spec.cost) return this.body.refused(`${spec.name} needs ${spec.cost} dread`);
    if (power === Power.Whisper) {
      this.dread -= spec.cost;
      this.whisper(x, y);
      this.body.used(power, x, y);
      return;
    }
    const kind = power as number as MonsterKind;
    const refusal = summonRefusal(ctx, x, y, MONSTERS[kind].radius);
    if (refusal) return this.body.refused(refusal);
    let count = 0;
    for (const m of ctx.world.all(Monster)) if (m.render.round === round.round && m.render.mode !== MonsterMode.Dead) count++;
    const cap = monsterCap(Math.max(1, tally(ctx.world, round.round).inside));
    if (count >= cap) return this.body.refused(`The house can hold no more (${cap})`);
    this.dread -= spec.cost;
    const m = summon(ctx, kind, x, y, this.me!.id, round.round);
    this.body.used(power, m.state.x, m.state.y);
  }

  /** A whisper: heard near it, and every survivor it reaches gives themselves away. */
  private whisper(x: number, y: number): void {
    const { ctx } = this;
    ctx.world.send(Noise, { kind: Sound.Whisper, x, y, z: 1.5, a: 0 }, { to: 'all' });
    revealNear(ctx, x, y);
  }

  /** Send the picked-out monsters to (x, y), or after the survivor there if the Haunt can see one. */
  private order(x: number, y: number, reach: number): void {
    const { ctx } = this;
    if (!this.selected.size) return;
    let victim: SurvivorEntity | null = null;
    let best = Math.max(reach, 1.5);
    for (const sv of ctx.world.all(Survivor) as ReadonlySet<SurvivorEntity>) {
      if (sv.render.mode !== SurvivorMode.Alive || !ctx.sightings.shows(sv)) continue;
      const d = Math.hypot(sv.x - x, sv.y - y);
      if (d < best) {
        best = d;
        victim = sv;
      }
    }
    for (const id of this.selected) {
      ctx.world.command(Order, { target: id, kind: victim ? OrderKind.Attack : OrderKind.Move, x: victim?.x ?? x, y: victim?.y ?? y, victim: victim?.id ?? 0 });
    }
    this.body.ordered(victim?.x ?? x, victim?.y ?? y, !!victim);
  }

  /** A flashlight caught the presence. */
  glare(by: SurvivorEntity | undefined): void {
    const { ctx } = this;
    if (this.dazed) return;
    this.hiddenUntil = ctx.now + GLARE_MS;
    this.dread = Math.max(0, this.dread - GLARE_DREAD);
    this.armed = null;
    const name = by?.render.name ?? 'Someone';
    ctx.world.send(Feed, { text: `${name} drove the Haunt back with their light` }, { to: 'all' });
    this.body.glared(name);
  }
}

/** A whisper at (x, y) gives away every survivor it reaches, to this peer's Haunt. */
export function revealNear(ctx: HauntContext, x: number, y: number): void {
  for (const sv of ctx.world.query(x, y, WHISPER_RADIUS, Survivor)) ctx.sightings.reveal(sv.id, WHISPER_MS, ctx.now);
}
