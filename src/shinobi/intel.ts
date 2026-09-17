import type { GuardEntity, ShinobiContext, ShinobiEntity } from './context';
import { Alert, Guard, GuardKind, GuardMode, ReportKind, Shinobi, ShinobiMode, Sound } from './defs';
import { CHECKIN_SECONDS, EARSHOT, spotting } from './guards';

/** How often what the guards see is worked out again, ms. */
const EVERY_MS = 150;
/** How long a shinobi's last sighting stays on the map, and a ping, ms. */
export const SIGHTING_MS = 7000;
export const PING_MS = 5000;
/** A guard that hasn't checked in for this much longer than it should have has gone quiet, ms. */
const LATE_MS = 3500;

export interface Sighting {
  x: number;
  y: number;
  z: number;
  at: number;
  /** A guard sees them right now. */
  seen: boolean;
}

export type PingKind = 'steps' | 'land' | 'clatter' | 'fall' | 'shout' | 'fight' | 'cry' | 'body' | 'quiet';

export interface Ping {
  kind: PingKind;
  x: number;
  y: number;
  at: number;
  text: string;
}

const HEARD: Partial<Record<Sound, [PingKind, string]>> = {
  [Sound.Steps]: ['steps', 'Footsteps'],
  [Sound.Land]: ['land', 'A thud'],
  [Sound.Clatter]: ['clatter', 'Steel on stone'],
  [Sound.Fall]: ['fall', 'Something fell'],
  [Sound.Shout]: ['shout', 'A shout'],
  [Sound.Attack]: ['fight', 'Fighting'],
  [Sound.Stab]: ['fight', 'A cry, cut short'],
  [Sound.Cry]: ['cry', 'Someone hurt'],
};

const NAMES = ['Taro', 'Jiro', 'Saburo', 'Kenji', 'Hiro', 'Goro', 'Daisuke', 'Ichiro', 'Masa', 'Shiro', 'Yoshi', 'Tetsu', 'Kazu', 'Nobu', 'Hachi', 'Rokuro'];

/** A guard's name, the same on every peer. */
export function guardName(g: { id: number; render: { kind: GuardKind } }): string {
  if (g.render.kind === GuardKind.Lord) return 'the lord';
  return NAMES[g.id % NAMES.length];
}

/**
 * What the Captain of the Watch knows, which isn't everything. Shinobi show on the map only while a guard sees them (and
 * where they were last seen, fading); sounds show as pings only if a guard was near enough to hear them; a guard who's
 * been killed only shows as dead once another finds the body or he misses his check-in. Worked out on the captain's peer
 * from what it receives, the same way the guards themselves decide what they see: it's a view, not a secret kept by the
 * network.
 */
export class Intel {
  readonly sightings = new Map<number, Sighting>();
  readonly pings: Ping[] = [];
  /** Guards the captain knows are dead. */
  readonly dead = new Set<number>();
  private readonly checkins = new Map<number, { value: number; at: number }>();
  private next = 0;
  /** A new message for the captain, if anything's happened since it was last read. */
  private readonly news: string[] = [];

  constructor(private readonly ctx: ShinobiContext) {}

  /** Whether a guard sees this shinobi right now. */
  sees(id: number): boolean {
    return this.sightings.get(id)?.seen ?? false;
  }

  /** Whether the captain believes a guard's still at his duty (he may already be dead). */
  standing(g: GuardEntity): boolean {
    return g.render.mode !== GuardMode.Dead || !this.dead.has(g.id);
  }

  /** What's happened that the captain should be told, since the last time. */
  takeNews(): string[] {
    return this.news.splice(0);
  }

  update(): void {
    const { ctx } = this;
    const { world, castle, now } = ctx;
    if (now < this.next) return;
    this.next = now + EVERY_MS;
    const round = ctx.round()?.state;
    const alarm = (round?.alarm ?? 0) > 0;
    const guards = [...world.all(Guard)] as GuardEntity[];

    for (const sv of world.all(Shinobi) as ReadonlySet<ShinobiEntity>) {
      const s = sv.render;
      if (s.round !== round?.round || s.mode === ShinobiMode.Dead || s.mode === ShinobiMode.Escaped) {
        this.sightings.delete(sv.id);
        continue;
      }
      let seen = false;
      for (const g of guards) {
        const gs = g.render;
        if (gs.mode === GuardMode.Dead) continue;
        if ((gs.mode === GuardMode.Chase && gs.target === sv.id && gs.alert === Alert.Alarmed && Math.hypot(g.x - sv.x, g.y - sv.y) < 25) || spotting(castle, { ...gs, x: g.x, y: g.y }, { ...s, x: sv.x, y: sv.y }, alarm) > 0) {
          seen = true;
          break;
        }
      }
      const was = this.sightings.get(sv.id);
      if (seen) this.sightings.set(sv.id, { x: sv.x, y: sv.y, z: s.z, at: now, seen: true });
      else if (was) was.seen = false;
      if (was && !seen && now - was.at > SIGHTING_MS) this.sightings.delete(sv.id);
    }

    for (const g of guards) {
      const gs = g.render;
      const c = this.checkins.get(g.id);
      if (!c || c.value !== gs.checkin) {
        this.checkins.set(g.id, { value: gs.checkin, at: now });
        continue;
      }
      if (gs.mode === GuardMode.Dead && !this.dead.has(g.id) && now - c.at > CHECKIN_SECONDS * 1000 + LATE_MS) {
        this.dead.add(g.id);
        this.ping('quiet', g.x, g.y, `${guardName(g)} has gone quiet`);
      }
    }
    for (const id of this.checkins.keys()) if (!world.get(id)) this.checkins.delete(id);
    while (this.pings.length && now - this.pings[0].at > PING_MS) this.pings.shift();
  }

  /** A sound somewhere: if a guard was close enough to hear it, the captain hears of it. */
  heard(kind: Sound, x: number, y: number, z: number): void {
    const what = HEARD[kind];
    if (!what) return;
    const reach = EARSHOT[kind];
    for (const g of this.ctx.world.query(x, y, reach, Guard) as GuardEntity[]) {
      if (g.render.mode === GuardMode.Dead || Math.hypot(g.x - x, g.y - y, g.render.z - z) > reach) continue;
      // a guard can't place a sound exactly
      const fuzz = kind === Sound.Shout || kind === Sound.Cry ? 0 : 1.5;
      this.ping(what[0], x + (Math.random() - 0.5) * fuzz * 2, y + (Math.random() - 0.5) * fuzz * 2, what[1]);
      return;
    }
  }

  /** A guard's report. */
  reported(kind: ReportKind, guard: number, about: number, x: number, y: number): void {
    const { world, now } = this.ctx;
    const g = world.getAs(Guard, guard) as GuardEntity | undefined;
    const who = g ? guardName(g) : 'A guard';
    if (kind === ReportKind.Body) {
      if (this.dead.has(about)) return;
      this.dead.add(about);
      const body = world.getAs(Guard, about) as GuardEntity | undefined;
      this.ping('body', x, y, body ? `${who} found ${guardName(body)} dead` : `${who} found a body`);
      return;
    }
    const was = this.sightings.get(about);
    this.sightings.set(about, { x, y, z: was?.z ?? 0, at: now, seen: was?.seen ?? false });
    this.ping('shout', x, y, `${who}: intruder!`);
  }

  private ping(kind: PingKind, x: number, y: number, text: string): void {
    this.pings.push({ kind, x, y, at: this.ctx.now, text });
    if (kind === 'body' || kind === 'quiet' || kind === 'shout') this.news.push(text);
  }
}
