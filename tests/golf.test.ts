import { beforeAll, describe, expect, it } from 'vitest';
import type { NetWorld } from '../src/engine/net/world';
import { handIntent, type HandIntent } from '../src/crossplay/intent';
import { Platform } from '../src/crossplay/platform';
import { initPhysics } from '../src/crossplay/rigid';
import { registerActions } from '../src/golf/actions';
import { Club, Flight, ballAt, carry, stepBall, strike } from '../src/golf/ball';
import { CartWorld, seatOf } from '../src/golf/carts';
import type { GolfContext } from '../src/golf/context';
import { Course, HOLES, Lie } from '../src/golf/course';
import { ACTIONS, BallMode, Cart, ENTITIES, Match } from '../src/golf/defs';
import { stepRules } from '../src/golf/frame';
import { Golfer, type GolferBody } from '../src/golf/golfer';
import { idleGolfIntent, type GolfIntent } from '../src/golf/intent';
import { IRON, METER_FALL, METER_RISE, meter as meterFor } from '../src/golf/kit';
import { MatchKeeper, maxStrokes, standings, toPar, unfinishedScore } from '../src/golf/match';
import { Sim } from './harness';

const course = new Course(20260917);
const stub = () => new Proxy({}, { get: () => () => {} });

beforeAll(async () => {
  await initPhysics();
});

class TestBody implements GolferBody {
  platform = Platform.Desktop;
  seatedNow = false;
  knocks = 0;
  holedIn = 0;
  moved(): void {}
  placed(): void {}
  hurt(): void {}
  used(): void {}
  died(): void {}
  seated(on: boolean): void {
    this.seatedNow = on;
  }
  knocked(): void {
    this.knocks++;
  }
  struck(): void {}
  holed(strokes: number): void {
    this.holedIn = strokes;
  }
}

interface Player {
  ctx: GolfContext;
  world: NetWorld;
  golfer: Golfer;
  body: TestBody;
  keeper: MatchKeeper;
  intent: GolfIntent;
  messages: string[];
}

function player(net: Sim, id: string, name: string): Player {
  const world = net.add(id, { worldId: 'golf-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 4096, cellSize: 1024, interestRadius: 1000, spatialCellSize: 24 });
  const messages: string[] = [];
  const hud = { ...stub(), message: (text: string) => messages.push(text) };
  const keeper = new MatchKeeper(world, course);
  const ctx: GolfContext = {
    world,
    course,
    carts: new CartWorld(world, course),
    sfx: stub() as never,
    hud: hud as never,
    settings: { open: false } as never,
    fx: stub() as never,
    me: null,
    ball: null,
    match: () => keeper.match,
    playerName: name,
    now: net.now,
  };
  const golfer = new Golfer(ctx);
  const body = new TestBody();
  golfer.attach(body);
  registerActions(ctx, golfer);
  golfer.spawn();
  return { ctx, world, golfer, body, keeper, intent: idleGolfIntent(), messages };
}

/** One frame of a player: their intent, then the rest of the rules. */
function frame(p: Player, now: number, dt = 1 / 60): void {
  p.ctx.now = now;
  p.golfer.update(dt, p.intent);
  stepRules(p.ctx, { golfer: p.golfer, keeper: p.keeper }, dt, now);
}

function run(net: Sim, players: Player[], ms: number, each?: (now: number) => void): void {
  net.run(
    ms,
    (now) => {
      each?.(now);
      for (const p of players) frame(p, now);
    },
    1000 / 60,
  );
}

function clear(intent: GolfIntent): void {
  Object.assign(intent, idleGolfIntent());
}

/** Walk a virtual head toward a point: turn to face it and push forward. */
function walkTo(p: Player, x: number, y: number): number {
  const s = p.ctx.me!.state;
  const d = Math.hypot(x - s.x, y - s.y);
  const want = Math.atan2(y - s.y, x - s.x);
  let turn = want - p.golfer.heading;
  while (turn > Math.PI) turn -= Math.PI * 2;
  while (turn < -Math.PI) turn += Math.PI * 2;
  p.intent.turn = turn;
  p.intent.forward = d > 0.4 ? 1 : 0;
  p.intent.run = d > 4;
  return d;
}

describe('The course', () => {
  it('is the same from the same seed, with each hole teed, greened and in bounds', () => {
    const again = new Course(20260917);
    expect(again.heights).toEqual(course.heights);
    expect(course.holes).toHaveLength(HOLES);
    for (const h of course.holes) {
      expect(course.lieAt(h.tee.x, h.tee.y)).toBe(Lie.Tee);
      expect(course.lieAt(h.pin.x, h.pin.y)).toBe(Lie.Green);
      expect(course.outOfBounds(h.tee.x, h.tee.y)).toBe(false);
      expect(course.heightAt(h.pin.x, h.pin.y)).toBeCloseTo(h.pin.z);
      for (const p of h.ponds) expect(course.lieAt(p.x, p.y)).toBe(Lie.Water);
    }
    // the last green is a short walk from the first tee
    const last = course.holes[HOLES - 1].green;
    expect(Math.hypot(last.x - course.holes[0].tee.x, last.y - course.holes[0].tee.y)).toBeLessThan(80);
  });

  it('has a ground normal that points up and downhill', () => {
    const n = course.normalAt(200, 200);
    expect(n.z).toBeGreaterThan(0.5);
    const e = 0.3;
    const uphillX = course.heightAt(200 + e, 200) > course.heightAt(200 - e, 200);
    if (Math.abs(n.x) > 0.01) expect(n.x < 0).toBe(uphillX);
  });
});

describe('A ball', () => {
  it('goes further with longer clubs, and the guide says about where it lands', () => {
    const tee = course.holes[0].tee;
    const total = (club: Club) => {
      const b = ballAt(tee.x, tee.y, tee.z + 0.01);
      strike(b, club, 1, tee.heading, Lie.Tee);
      for (let i = 0; i < 60 * 30 && b.flight !== Flight.Rest && b.flight !== Flight.Holed; i++) stepBall(b, course, { x: -1e5, y: -1e5, z: 0 }, 1 / 60);
      return Math.hypot(b.x - tee.x, b.y - tee.y);
    };
    const d = [Club.Driver, Club.Iron, Club.Wedge].map(total);
    expect(d[0]).toBeGreaterThan(d[1]);
    expect(d[1]).toBeGreaterThan(d[2]);
    expect(d[2]).toBeGreaterThan(40);
    const guide = carry(tee, Club.Iron, 1, tee.heading, Lie.Tee, course);
    expect(Math.hypot(guide.x - tee.x, guide.y - tee.y)).toBeGreaterThan(80);
  });

  it('drops into the cup at putting pace, and lips out when struck too hard', () => {
    const hole = course.holes[0];
    const pin = hole.pin;
    const putt = (power: number) => {
      const from = { x: pin.x - 3, y: pin.y };
      const b = ballAt(from.x, from.y, course.heightAt(from.x, from.y) + 0.01);
      // aim a little up the green's slope, so it breaks toward the hole
      strike(b, Club.Putter, power, 0, Lie.Green);
      let holed = false;
      for (let i = 0; i < 60 * 20 && b.flight !== Flight.Rest; i++) {
        if (stepBall(b, course, pin, 1 / 60) === 'holed') {
          holed = true;
          break;
        }
      }
      return holed;
    };
    const powers = Array.from({ length: 40 }, (_, i) => 0.1 + i * 0.02);
    expect(powers.some((p) => putt(p))).toBe(true);
    expect(putt(1)).toBe(false);
  });

  it('comes back with a penalty from water', () => {
    const pond = course.holes.flatMap((h) => h.ponds)[0];
    const b = ballAt(pond.x - 30, pond.y, course.heightAt(pond.x - 30, pond.y) + 0.01);
    strike(b, Club.Putter, 1, 0, Lie.Fairway);
    b.vx = 25;
    let event = null;
    for (let i = 0; i < 600 && !event; i++) {
      const e = stepBall(b, course, { x: -1e5, y: 0, z: 0 }, 1 / 60);
      if (e === 'water' || e === 'rest') event = e;
    }
    expect(event).toBe('water');
  });
});

describe('Scoring', () => {
  it('scores an unfinished hole at least a triple bogey, and never more than a pick-up', () => {
    expect(unfinishedScore(4, 1)).toBe(7);
    expect(unfinishedScore(4, 7)).toBe(9);
    expect(unfinishedScore(4, 20)).toBe(maxStrokes(4));
    const card = new Uint8Array(HOLES);
    card[0] = 3;
    card[1] = 4;
    expect(toPar(card, course)).toBe(3 - course.holes[0].par + 4 - course.holes[1].par);
  });

  it('meters power up and back down', () => {
    expect(meterFor(0)).toBe(0);
    expect(meterFor(METER_RISE / 2)).toBeCloseTo(0.5);
    expect(meterFor(METER_RISE)).toBeCloseTo(1);
    expect(meterFor(METER_RISE + METER_FALL / 2)).toBeCloseTo(0.5);
    expect(meterFor(METER_RISE + METER_FALL)).toBe(0);
  });
});

describe('Playing a hole together', () => {
  it('tees everyone up on the same hole, plays it out with bots, scores it and moves on', () => {
    const net = new Sim({ latencyMs: 20, connectDelayMs: 50 });
    const a = player(net, 'a', 'Ada');
    const b = player(net, 'b', 'Bob');
    run(net, [a, b], 5000);
    const match = a.keeper.match!;
    expect(match).toBe(a.world.all(Match).values().next().value);
    expect(a.world.all(Match).size).toBe(1);
    expect(b.world.all(Match).size).toBe(1);
    expect(match.state.hole).toBe(0);
    for (const p of [a, b]) {
      expect(p.ctx.ball!.state.hole).toBe(0);
      expect(p.ctx.ball!.state.mode).toBe(BallMode.Rest);
    }

    // a crude bot: walk to the ball, stand over it (automatic), aim is at the pin, and swing with a power for the distance
    const bots = [a, b].map((p) => ({ p, holding: 0, power: 0 }));
    const drive = (now: number) => {
      for (const bot of bots) {
        const { p } = bot;
        clear(p.intent);
        const g = p.golfer;
        const ball = p.ctx.ball!.state;
        if (ball.mode !== BallMode.Rest) continue;
        if (!g.addressing) {
          walkTo(p, g.sim.x, g.sim.y);
          continue;
        }
        const pin = g.hole.pin;
        const d = Math.hypot(pin.x - g.sim.x, pin.y - g.sim.y);
        const club = g.club;
        const full = Math.hypot(...(() => {
          const c = carry(g.sim, club, 1, g.aimHeading, g.lie, course);
          return [c.x - g.sim.x, c.y - g.sim.y];
        })());
        const want = club === Club.Putter ? Math.min(1, (d * 1.15 + 0.4) / 30) : Math.min(1, d / Math.max(1, full));
        if (bot.holding === 0) {
          bot.power = want;
          bot.holding = 1;
        }
        p.intent.trigger = true;
        p.intent.power = bot.power;
        if (g.charging && Math.abs(g.charge - bot.power) < 1e-6) {
          p.intent.trigger = false;
          p.intent.power = null;
          bot.holding = 0;
        }
        void now;
      }
    };
    run(net, [a, b], 240_000, drive);
    for (const p of [a, b]) expect(p.ctx.me!.state.card[0]).toBeGreaterThan(0);
    expect(a.world.getAs(Match, match.id)!.state.hole).toBeGreaterThanOrEqual(1);
    const board = standings(a.world, match.state.round, course);
    expect(board).toHaveLength(2);
    // the loser of the first hole isn't ahead
    expect(toPar(board[0].state.card, course)).toBeLessThanOrEqual(toPar(board[1].state.card, course));
  }, 60_000);
});

describe('A headset', () => {
  it('plays the ball by swinging a tracked club through it, the way it was swung', () => {
    const net = new Sim({ latencyMs: 20, connectDelayMs: 50 });
    const a = player(net, 'a', 'Ada');
    run(net, [a], 5000);
    const ball = a.ctx.ball!.state;
    expect(ball.mode).toBe(BallMode.Rest);
    const { sim } = a.golfer;
    const ground = course.heightAt(sim.x, sim.y);
    const head = { x: sim.x, y: sim.y - 0.7, z: ground + 1.65, heading: Math.PI / 2, pitch: -0.6 };
    // standing where the headset is: this body has no play space to move
    a.ctx.me!.state.x = head.x;
    a.ctx.me!.state.y = head.y;
    const hand = handIntent();
    hand.tracked = true;
    hand.tool = IRON;
    const hands: [HandIntent, HandIntent] = [hand, handIntent()];
    // the club head comes along the ground from behind the ball at 9 m/s, heading +x
    let t = -0.5;
    run(net, [a], 400, () => {
      clear(a.intent);
      a.intent.head = head;
      a.intent.hands = hands;
      t += 9 / 60;
      const tip = { x: sim.x + Math.min(t, 0.8), y: sim.y + 0.01, z: ground + 0.03 };
      hand.tip = tip;
      hand.grip = { x: tip.x - 0.3, y: tip.y - 0.4, z: tip.z + 0.9 };
      hand.aim = { x: 1, y: 0, z: 0 };
      hand.pointing = { x: 0, y: 0, z: -1 };
    });
    expect(ball.strokes).toBe(1);
    expect(ball.mode).toBe(BallMode.Moving);
    // off along the swing, not wherever the headset faced
    expect(Math.abs(Math.atan2(sim.vy, sim.vx))).toBeLessThan(0.2);
  });
});

describe('Battle', () => {
  it('knocks down whoever a club swings at, and they get up again', () => {
    const net = new Sim({ latencyMs: 20, connectDelayMs: 50 });
    const a = player(net, 'a', 'Ada');
    const b = player(net, 'b', 'Bob');
    run(net, [a, b], 2500);
    const bs = b.ctx.me!.state;
    // stand Ada a meter in front of Bob, facing him, away from any ball
    const at = { x: bs.x + 1.2, y: bs.y };
    a.ctx.me!.state.x = at.x;
    a.ctx.me!.state.y = at.y;
    a.golfer.heading = Math.PI;
    run(net, [a, b], 400);
    a.intent.trigger = true;
    run(net, [a, b], 200);
    a.intent.trigger = false;
    run(net, [a, b], 300);
    expect(b.body.knocks).toBe(1);
    expect(b.ctx.me!.state.down).toBe(true);
    expect(b.ctx.me!.state.x).toBeLessThan(bs.x + 0.01);
    run(net, [a, b], 3000);
    expect(b.ctx.me!.state.down).toBe(false);
  });

  it('shares carts: one golfer drives one away, gets out, and another can take it', () => {
    const net = new Sim({ latencyMs: 20, connectDelayMs: 50 });
    const a = player(net, 'a', 'Ada');
    const b = player(net, 'b', 'Bob');
    run(net, [a, b], 6000);
    // one each
    const carts = [...a.world.all(Cart)].sort((p, q) => p.state.slot - q.state.slot);
    expect(carts.length).toBe(2);
    expect(b.world.all(Cart).size).toBe(2);
    const cart = carts[0];
    const start = { x: cart.state.x, y: cart.state.y };

    // Ada walks up and gets in
    run(net, [a, b], 8000, () => {
      clear(a.intent);
      const seat = seatOf(cart, { x: 0, y: 0, z: 0 });
      if (walkTo(a, seat.x, seat.y) < 1.5) a.intent.interact = true;
      if (a.golfer.seated) clear(a.intent);
    });
    expect(a.golfer.seated).toBe(true);
    expect(a.body.seatedNow).toBe(true);
    expect(a.world.getAs(Cart, cart.id)!.mine).toBe(true);

    // drive forward a few seconds
    run(net, [a, b], 4000, () => {
      clear(a.intent);
      a.intent.throttle = 1;
    });
    const ac = a.world.getAs(Cart, cart.id)!;
    expect(Math.hypot(ac.state.x - start.x, ac.state.y - start.y)).toBeGreaterThan(8);
    // Bob's copy follows it
    const bc = b.world.getAs(Cart, cart.id)!;
    expect(Math.hypot(bc.x - ac.state.x, bc.y - ac.state.y)).toBeLessThan(3);

    // stop and get out
    run(net, [a, b], 3000, () => {
      clear(a.intent);
      a.intent.brake = true;
    });
    clear(a.intent);
    a.intent.interact = true;
    run(net, [a, b], 50);
    clear(a.intent);
    run(net, [a, b], 1500);
    expect(a.golfer.seated).toBe(false);
    expect(ac.state.driver).toBe(0);

    // now Bob takes it
    run(net, [a, b], 25_000, () => {
      clear(b.intent);
      const seat = seatOf(bc, { x: 0, y: 0, z: 0 });
      if (walkTo(b, seat.x, seat.y) < 1.5) b.intent.interact = true;
      if (b.golfer.seated) clear(b.intent);
    });
    expect(b.golfer.seated).toBe(true);
    expect(b.world.getAs(Cart, cart.id)!.mine).toBe(true);
  }, 60_000);
});
