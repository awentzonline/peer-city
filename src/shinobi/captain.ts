import { Platform } from '../crossplay/platform';
import type { Frontend, Role } from '../crossplay/role';
import type { CaptainEntity, GuardEntity, ShinobiContext } from './context';
import { Beacon, Captain as CaptainDef, Guard, GuardKind, GuardMode, Noise, Order, OrderKind, Phase, Sound } from './defs';
import { reinforce, takesOrders } from './guards';
import { Intel } from './intel';
import { Call, type CaptainIntent } from './intent';

/** How the captain's rules reach back to the device playing it. */
export interface CaptainBody {
  readonly platform: Platform;
  /** A call was made at (x, y). */
  used(call: Call, x: number, y: number): void;
  /** It couldn't be: why. */
  refused(reason: string): void;
  /** Guards were sent to (x, y). */
  ordered(x: number, y: number, kind: OrderKind): void;
}

export type CaptainFrontend = Frontend<CaptainIntent> & CaptainBody;

export interface CallSpec {
  name: string;
  /** Seconds before it can be made again. */
  cooldown: number;
  blurb: string;
}

export const CALLS: Record<Call, CallSpec> = {
  [Call.Braziers]: { name: 'Braziers', cooldown: 35, blurb: 'Light up where you point for a minute. Nobody hides in that light.' },
  [Call.Bell]: { name: 'Alarm bell', cooldown: 90, blurb: 'Every guard on the alert for 25 s: sharper eyes, quicker feet.' },
  [Call.Reinforce]: { name: 'Reinforce', cooldown: 60, blurb: 'Two more guards from the barracks, to search where you point.' },
  [Call.MoveLord]: { name: 'Move the lord', cooldown: 20, blurb: 'Send the lord and his samurai to the spot nearest where you point.' },
};

export const CALL_ORDER: readonly Call[] = [Call.Braziers, Call.Bell, Call.Reinforce, Call.MoveLord];

/** How long braziers burn, and the bell rings, s. */
export const BRAZIER_SECONDS = 60;
export const BELL_SECONDS = 25;
/** Most spearmen there can be at once. */
export const MAX_SPEARS = 18;
/** Gathering picks out guards this near the pointer. */
export const GATHER_RADIUS = 10;

const NO_BODY: CaptainBody = { platform: Platform.Desktop, used() {}, refused() {}, ordered() {} };

/**
 * The player as the Captain of the Watch: no body, a map of the castle, and only what the guards can tell them (`intel`).
 * Pick out guards and send them to search somewhere, or to stand watch there, or back to their rounds; light braziers,
 * ring the alarm bell, turn out reinforcements and move the lord somewhere safer. Every call takes a while to come round
 * again, so it's what to do and when.
 */
export class CaptainRole implements Role<CaptainIntent, CaptainFrontend> {
  body: CaptainBody = NO_BODY;
  armed: Call | null = null;
  /** Guards picked out, by id. */
  readonly selected = new Set<number>();
  readonly intel: Intel;
  /** When each call's ready again, ms. */
  private readonly ready: Record<Call, number> = { [Call.Braziers]: 0, [Call.Bell]: 0, [Call.Reinforce]: 0, [Call.MoveLord]: 0 };
  private night = 0;

  constructor(readonly ctx: ShinobiContext) {
    this.intel = new Intel(ctx);
  }

  get me(): CaptainEntity | null {
    return this.ctx.captain;
  }

  attach(body: CaptainBody): void {
    this.body = body;
  }

  spawn(): void {
    const { ctx } = this;
    ctx.captain = ctx.world.spawn(CaptainDef, { x: 48, y: 48, name: ctx.playerName }) as CaptainEntity;
    ctx.world.setFocus(48, 48, 150);
  }

  /** Seconds until a call's ready, 0 if it is. */
  cooling(call: Call): number {
    return Math.max(0, (this.ready[call] - this.ctx.now) / 1000);
  }

  /** The guards that take orders and that the captain believes are at their duty. */
  guards(): GuardEntity[] {
    const out: GuardEntity[] = [];
    const round = this.ctx.round()?.state.round;
    for (const g of this.ctx.world.all(Guard) as ReadonlySet<GuardEntity>) {
      if (g.render.round === round && g.render.kind !== GuardKind.Lord && this.intel.standing(g) && g.render.mode !== GuardMode.Dead) out.push(g);
    }
    return out;
  }

  update(_dt: number, intent: CaptainIntent): void {
    const { ctx } = this;
    const me = this.me;
    if (!me) return;
    const s = me.state;
    s.platform = this.body.platform;
    s.x = intent.focus.x;
    s.y = intent.focus.y;
    s.pointing = !!intent.pointer;
    if (intent.pointer) {
      s.px = intent.pointer.x;
      s.py = intent.pointer.y;
    }
    ctx.world.setFocus(s.x, s.y, 150);
    this.nightly();
    this.intel.update();
    for (const id of this.selected) if (!this.orderable(id)) this.selected.delete(id);

    if (intent.arm !== null) this.armed = intent.arm === 'none' || intent.arm === this.armed ? null : intent.arm;
    if (intent.selectAll) this.selectAll();
    if (intent.select) {
      if (!intent.select.add) this.selected.clear();
      for (const id of intent.select.ids) if (this.orderable(id)) this.selected.add(id);
    }
    const p = intent.pointer;
    if (p && intent.gather) this.gather(p.x, p.y);
    if (p && intent.primary) this.primary(p.x, p.y, intent.reach);
    if (p && intent.secondary) {
      if (this.armed !== null) this.armed = null;
      else this.order(OrderKind.Search, p.x, p.y);
    }
    if (p && intent.post) this.order(OrderKind.Post, p.x, p.y);
    if (intent.dismiss) this.order(OrderKind.Return, s.px, s.py);
  }

  /** A new night: calls ready, nothing picked out. */
  private nightly(): void {
    const round = this.ctx.round()?.state;
    if (!round || round.round === this.night) return;
    this.night = round.round;
    this.selected.clear();
    this.armed = null;
    for (const c of CALL_ORDER) this.ready[c] = 0;
  }

  private orderable(id: number): boolean {
    const g = this.ctx.world.getAs(Guard, id) as GuardEntity | undefined;
    return !!g && takesOrders(g.render) && this.intel.standing(g);
  }

  private selectAll(): void {
    const all = this.guards();
    if (all.length && all.every((g) => this.selected.has(g.id))) {
      this.selected.clear();
      return;
    }
    for (const g of all) this.selected.add(g.id);
  }

  private gather(x: number, y: number): void {
    this.selected.clear();
    for (const g of this.guards()) if (Math.hypot(g.x - x, g.y - y) < GATHER_RADIUS) this.selected.add(g.id);
    if (!this.selected.size) this.body.refused('No guards near there');
  }

  /** Make the armed call, or pick out a guard, or send the picked-out ones. */
  private primary(x: number, y: number, reach: number): void {
    if (this.armed !== null) {
      this.use(this.armed, x, y);
      return;
    }
    let pick: GuardEntity | null = null;
    let best = Math.max(reach, 1.2);
    for (const g of this.guards()) {
      const d = Math.hypot(g.x - x, g.y - y);
      if (d < best) {
        best = d;
        pick = g;
      }
    }
    if (pick) {
      if (this.selected.has(pick.id)) this.selected.delete(pick.id);
      else this.selected.add(pick.id);
      return;
    }
    if (this.selected.size) this.order(OrderKind.Search, x, y);
    else this.body.refused('Pick out a guard first');
  }

  private use(call: Call, x: number, y: number): void {
    const { ctx } = this;
    const { world, castle } = ctx;
    const round = ctx.round()?.state;
    const spec = CALLS[call];
    if (!round || (round.phase !== Phase.Night && round.phase !== Phase.Escape)) return this.body.refused(round?.phase === Phase.Over ? 'The night is over' : "The night hasn't begun");
    const wait = this.cooling(call);
    if (wait > 0) return this.body.refused(`${spec.name} in ${Math.ceil(wait)}s`);
    switch (call) {
      case Call.Braziers:
        if (!castle.inside(x, y)) return this.body.refused('Only inside the walls');
        world.spawn(Beacon, { x, y, left: BRAZIER_SECONDS, round: round.round });
        world.send(Noise, { kind: Sound.Kindle, x, y, z: 1, a: 0 }, { to: 'all' });
        break;
      case Call.Bell:
        world.send(Noise, { kind: Sound.Bell, x: castle.stations[0].x, y: castle.stations[0].y, z: 10, a: 0 }, { to: 'all' });
        break;
      case Call.Reinforce: {
        let spears = 0;
        for (const g of world.all(Guard)) if (g.render.round === round.round && g.render.kind === GuardKind.Spear && g.render.mode !== GuardMode.Dead) spears++;
        if (spears >= MAX_SPEARS) return this.body.refused('The barracks are empty');
        if (!castle.inside(x, y)) return this.body.refused('Only inside the walls');
        for (const g of reinforce(ctx, round.round, x, y)) this.selected.add(g.id);
        break;
      }
      case Call.MoveLord: {
        const lord = world.getAs(Guard, round.lord);
        if (!lord || lord.render.mode === GuardMode.Dead) return this.body.refused('The lord is dead');
        world.command(Order, { target: lord.id, kind: OrderKind.Station, x, y });
        break;
      }
    }
    this.ready[call] = ctx.now + spec.cooldown * 1000;
    this.armed = null;
    this.body.used(call, x, y);
  }

  /** Send the picked-out guards. */
  private order(kind: OrderKind, x: number, y: number): void {
    if (!this.selected.size) {
      if (kind !== OrderKind.Return) this.body.refused('Pick out a guard first');
      return;
    }
    for (const id of this.selected) this.ctx.world.command(Order, { target: id, kind, x, y });
    this.body.ordered(x, y, kind);
  }
}
