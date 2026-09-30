import { afterEach, describe, expect, it, vi } from 'vitest';
import { handIntent, type HandIntent } from '../src/crossplay/intent';
import { Platform } from '../src/crossplay/platform';
import { registerActions, type FiveEvent, type SlapEvent } from '../src/hifive/actions';
import { TeamKeeper } from '../src/hifive/buddies';
import type { HiContext, PalEntity } from '../src/hifive/context';
import { ACTIONS, Buddy, BuddyKind, BuddyMode, ENTITIES } from '../src/hifive/defs';
import { BENCHES, FIELD, Grounds, LOCKER, collide, inRooms } from '../src/hifive/field';
import { stepRules } from '../src/hifive/frame';
import { idlePalIntent, stillPal, type PalIntent } from '../src/hifive/intent';
import {
  COMBO_MS,
  DENY_POINTS,
  Grade,
  Move,
  Pairs,
  RING_HIT,
  RING_MS,
  SLAP_POINTS,
  classifyHands,
  comboMultiplier,
  nextStreak,
  offerPose,
  posePoint,
  ringError,
  scoreFor,
  speedGrade,
  timingGrade,
  type TrackedHand,
} from '../src/hifive/moves';
import { PalRole, SLAP_MS } from '../src/hifive/pal';
import { swipeMove } from '../src/hifive/swipe';
import { Sim } from './harness';

const stub = () => new Proxy({}, { get: () => () => {} });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Moves and scoring', () => {
  it('grades a press by how near the ring was to its target, whichever turn it was nearest', () => {
    expect(ringError(RING_HIT)).toBe(0);
    expect(ringError(RING_HIT + 0.03)).toBeCloseTo(30);
    // just after the ring starts again is near the end of the last turn's target, not a whole turn off
    expect(ringError(0.02)).toBeCloseTo((1 - RING_HIT + 0.02) * RING_MS);
    expect(timingGrade(20)).toBe(Grade.Perfect);
    expect(timingGrade(100)).toBe(Grade.Great);
    expect(timingGrade(180)).toBe(Grade.Good);
    expect(timingGrade(260)).toBe(Grade.Whiff);
  });

  it('grades a tracked hand by how fast it swung', () => {
    expect(speedGrade(4)).toBe(Grade.Perfect);
    expect(speedGrade(2.5)).toBe(Grade.Great);
    expect(speedGrade(1.5)).toBe(Grade.Good);
    expect(speedGrade(1)).toBe(Grade.Limp);
  });

  it('pays more for combos, doubles and fives in the air, and a too-slow only its base', () => {
    expect(scoreFor(Grade.Perfect, Move.High, 1, false)).toBe(100);
    expect(scoreFor(Grade.Perfect, Move.High, 3, false)).toBe(150);
    expect(scoreFor(Grade.Perfect, Move.Double, 1, false)).toBe(150);
    expect(scoreFor(Grade.Perfect, Move.High, 1, true)).toBe(150);
    expect(scoreFor(Grade.TooSlow, Move.High, 5, false)).toBe(50);
    expect(scoreFor(Grade.Whiff, Move.High, 5, false)).toBe(0);
    expect(comboMultiplier(20)).toBe(3);
  });

  it('builds a combo by mixing up the moves, holds it for the same one, and drops it for a miss or a lapse', () => {
    expect(nextStreak(undefined, 0, Move.High, Grade.Good)).toBe(1);
    const prev = { streak: 2, at: 1000, move: Move.High };
    expect(nextStreak(prev, 2000, Move.Low, Grade.Great)).toBe(3);
    expect(nextStreak(prev, 2000, Move.High, Grade.Great)).toBe(2);
    expect(nextStreak(prev, 2000, Move.Low, Grade.TooSlow)).toBe(0);
    expect(nextStreak(prev, 1000 + COMBO_MS + 1, Move.Low, Grade.Great)).toBe(1);
  });

  it("reads a headset player's hands as an offer", () => {
    const hand = (x: number, z: number, fist = false, speed = 0): TrackedHand => ({ tracked: true, x, y: 0, z, fist, speed });
    const down = hand(0.05, 0.85);
    // facing +x: forward is x
    expect(classifyHands(1.65, 0, [hand(0.25, 1.95), down]).move).toBe(Move.High);
    expect(classifyHands(1.65, 0, [hand(0.25, 1.95), hand(0.25, 1.95)]).move).toBe(Move.Double);
    expect(classifyHands(1.65, 0, [hand(0.45, 0.9), down]).move).toBe(Move.Low);
    expect(classifyHands(1.65, 0, [hand(0.45, 1.25, true), down]).move).toBe(Move.Fist);
    const left = classifyHands(1.65, 0, [down, hand(0.25, 1.95)]);
    expect(left).toEqual({ move: Move.High, left: true });
    // a hand on its way somewhere is a swing, not an offer; a hand by your side is nothing
    expect(classifyHands(1.65, 0, [hand(0.25, 1.95, false, 3), down]).move).toBe(Move.None);
    expect(classifyHands(1.65, 0, [down, down]).move).toBe(Move.None);
  });

  it('reads a swipe on the pad as a move', () => {
    expect(swipeMove(0, -60, 150)).toBe(Move.High);
    expect(swipeMove(5, 70, 150)).toBe(Move.Low);
    expect(swipeMove(-80, 10, 150)).toBe(Move.Double);
    expect(swipeMove(3, 2, 120)).toBe(Move.Fist);
    expect(swipeMove(3, 2, 900)).toBe(Move.None);
  });
});

describe('The grounds', () => {
  it('keeps people in the rooms and out of the benches, with the tunnel open at both ends', () => {
    const out = { x: 10, y: 10 };
    collide(out, 0.35);
    expect(inRooms(out.x, out.y, 0.34)).toBe(true);
    const b = BENCHES[0];
    const on = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 + 0.05 };
    collide(on, 0.35);
    expect(on.y).toBeGreaterThanOrEqual(b.y1 + 0.35 - 1e-9);
    // walking straight up the tunnel from the locker room onto the field never gets pushed back
    const walker = { x: 30, y: LOCKER.y1 - 1 };
    while (walker.y < FIELD.y0 + 2) {
      const y = walker.y + 0.1;
      walker.y = y;
      collide(walker, 0.35);
      expect(walker.y).toBeCloseTo(y);
    }
  });

  it('finds the way from the locker room out onto the field', () => {
    const grounds = new Grounds();
    const step = grounds.paths.next(24, 8, 40, 50, 0.35, 0);
    expect(step).not.toBeNull();
    // the way out is through the tunnel, north
    expect(step!.y).toBeGreaterThan(8);
  });
});

interface Peer {
  id: string;
  ctx: HiContext;
  role: PalRole;
  intent: PalIntent;
  fives: FiveEvent[];
  slaps: SlapEvent[];
  smacks: number[];
  me: PalEntity;
}

function peer(net: Sim, id: string, platform = Platform.Desktop): Peer {
  const world = net.add(id, { worldId: 'hifive-test', entities: ENTITIES, actions: ACTIONS, zoneSize: 4096, cellSize: 1024, interestRadius: 150, spatialCellSize: 12 });
  const ctx = { world, grounds: new Grounds(), pairs: new Pairs(), sfx: stub(), hud: stub(), settings: stub(), fx: stub(), me: null, playerName: id, now: net.now } as unknown as HiContext;
  const role = new PalRole(ctx);
  const smacks: number[] = [];
  role.attach({ platform, moved() {}, placed() {}, hurt() {}, used() {}, died() {}, smacked: (_side, k) => smacks.push(k) });
  const fives: FiveEvent[] = [];
  const slaps: SlapEvent[] = [];
  registerActions(ctx, role, { five: (e) => fives.push(e), slap: (e) => slaps.push(e) });
  role.spawn();
  return { id, ctx, role, intent: idlePalIntent(), fives, slaps, smacks, me: ctx.me! };
}

/** Run everyone's frames for `ms`: each plays its intent, and one-frame presses are let go after. */
function run(net: Sim, peers: Peer[], ms: number, each?: () => void): void {
  net.run(ms, (now) => {
    each?.();
    for (const p of peers) {
      p.ctx.now = now;
      p.role.update(0.016, p.intent);
      stillPal(p.intent);
    }
  });
}

/** Stand someone at (x, y) facing `heading`. */
function place(p: Peer, x: number, y: number, heading: number): void {
  const s = p.me.state;
  s.x = x;
  s.y = y;
  s.yaw = heading;
  p.role.heading = heading;
  p.role.pitch = 0;
}

/** Two players out on the field, face to face. */
function facing(): { net: Sim; ann: Peer; bob: Peer } {
  const net = new Sim();
  const ann = peer(net, 'ann');
  const bob = peer(net, 'bob');
  place(ann, 30, 40, Math.PI / 2);
  place(bob, 30, 41.2, -Math.PI / 2);
  run(net, [ann, bob], 600);
  return { net, ann, bob };
}

/** Wait for the ring to come round to its target, then press `move`. */
function swingOnTime(net: Sim, peers: Peer[], p: Peer, move: Move, offMs = 0): void {
  let pressed = false;
  for (let i = 0; i < 200 && !pressed; i++) {
    run(net, peers, 16, () => {
      if (pressed) return;
      const err = ((p.role.ringPhase() - RING_HIT) * RING_MS - offMs) / RING_MS;
      if (Math.abs(err) < 0.009) {
        p.intent.move = move;
        pressed = true;
      }
    });
  }
  expect(pressed).toBe(true);
}

describe('Giving five with keys and fingers', () => {
  it('lands a perfectly timed five on an offer, scores it for both, and takes the offer down', () => {
    const { net, ann, bob } = facing();
    bob.intent.move = Move.High;
    run(net, [ann, bob], 400);
    expect(bob.me.state.offer).toBe(Move.High);
    expect(ann.role.engaged?.id).toBe(bob.me.id);
    swingOnTime(net, [ann, bob], ann, Move.High);
    run(net, [ann, bob], 600);
    expect(ann.fives).toHaveLength(1);
    expect(bob.fives).toHaveLength(1);
    const e = ann.fives[0];
    expect(e).toMatchObject({ a: ann.me.id, b: bob.me.id, move: Move.High, grade: Grade.Perfect, streak: 1, points: 100 });
    expect(ann.me.state.score).toBe(100);
    expect(bob.me.state.score).toBe(100);
    expect(bob.me.state.offer).toBe(Move.None);
    // the swinging hand reached out to the offer, where everyone can see it
    expect(ann.smacks.length).toBeGreaterThan(0);
  });

  it('grades a late press lower, and a wrong move as awkward', () => {
    const { net, ann, bob } = facing();
    bob.intent.move = Move.Low;
    run(net, [ann, bob], 400);
    swingOnTime(net, [ann, bob], ann, Move.Low, 90);
    run(net, [ann, bob], 600);
    expect(ann.fives[0].grade).toBe(Grade.Great);
    bob.intent.move = Move.Fist;
    run(net, [ann, bob], 400);
    swingOnTime(net, [ann, bob], ann, Move.High);
    run(net, [ann, bob], 600);
    expect(ann.fives[1].grade).toBe(Grade.Awkward);
    expect(ann.fives[1].streak).toBe(0);
  });

  it('keeps a combo going with a different move, and pays it', () => {
    const { net, ann, bob } = facing();
    bob.intent.move = Move.High;
    run(net, [ann, bob], 400);
    swingOnTime(net, [ann, bob], ann, Move.High);
    run(net, [ann, bob], 600);
    bob.intent.move = Move.Double;
    run(net, [ann, bob], 400);
    swingOnTime(net, [ann, bob], ann, Move.Double);
    run(net, [ann, bob], 600);
    const second = ann.fives[1];
    expect(second.streak).toBe(2);
    expect(second.points).toBe(scoreFor(Grade.Perfect, Move.Double, 2, false));
    expect(bob.me.state.best).toBe(2);
  });

  it('pays the one who pulled it away when the other swings anyway: too slow', () => {
    const { net, ann, bob } = facing();
    bob.intent.move = Move.Low;
    run(net, [ann, bob], 400);
    bob.intent.yank = true;
    run(net, [ann, bob], 300);
    expect(bob.me.state.offer).toBe(Move.None);
    expect(bob.me.state.yank).toBe(Move.Low);
    ann.intent.move = Move.Low;
    run(net, [ann, bob], 600);
    expect(ann.fives[0].grade).toBe(Grade.TooSlow);
    expect(bob.me.state.score).toBe(50);
    expect(ann.me.state.score).toBe(0);
  });

  it('holds one out when there is nobody to swing at, and pressing it again pulls it away', () => {
    const net = new Sim();
    const ann = peer(net, 'ann');
    place(ann, 30, 40, 0);
    ann.intent.move = Move.Fist;
    run(net, [ann], 100);
    expect(ann.me.state.offer).toBe(Move.Fist);
    expect(ann.me.state.reach & 1).toBe(1);
    expect(ann.me.state.fists & 1).toBe(1);
    ann.intent.move = Move.Fist;
    run(net, [ann], 100);
    expect(ann.me.state.offer).toBe(Move.None);
    expect(ann.me.state.yank).toBe(Move.Fist);
  });
});

describe('Giving five with tracked hands', () => {
  /** Ann in a headset facing Bob, both hands down, her head where her body is. */
  function headset(): { net: Sim; ann: Peer; bob: Peer; right: HandIntent; left: HandIntent } {
    const net = new Sim();
    const ann = peer(net, 'ann', Platform.Vr);
    const bob = peer(net, 'bob');
    place(ann, 30, 40, Math.PI / 2);
    place(bob, 30, 41.2, -Math.PI / 2);
    const right = handIntent();
    const left = handIntent();
    ann.intent.head = { x: 30, y: 40, z: 1.65, heading: Math.PI / 2, pitch: 0 };
    ann.intent.hands = [right, left];
    // facing north, your right hand is to the west
    for (const [h, x] of [
      [right, 29.7],
      [left, 30.3],
    ] as const) {
      h.tracked = true;
      h.grip = { x, y: 40.05, z: 0.85 };
      h.tip = { ...h.grip };
    }
    run(net, [ann, bob], 600);
    return { net, ann, bob, right, left };
  }

  /** Move a tracked hand in a straight line from `from` to `to` at `speed` m/s. */
  function swing(net: Sim, peers: Peer[], hand: HandIntent, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, speed: number): void {
    const d = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const frames = Math.ceil(d / (speed * 0.016));
    for (let i = 0; i <= frames; i++) {
      const t = i / frames;
      hand.grip = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
      hand.tip = { ...hand.grip };
      run(net, peers, 16);
    }
  }

  it('lands a five by swinging a hand into an offer, graded by how fast it went', () => {
    const { net, ann, bob, right } = headset();
    bob.intent.move = Move.High;
    run(net, [ann, bob], 400);
    const target = posePoint(bob.me.x, bob.me.y, 0, bob.me.state.yaw, offerPose(Move.High, bob.me.state.head), false, { x: 0, y: 0, z: 0 });
    swing(net, [ann, bob], right, { x: target.x, y: target.y - 0.6, z: target.z - 0.2 }, { x: target.x, y: target.y + 0.1, z: target.z }, 3.8);
    run(net, [ann, bob], 400);
    expect(ann.fives).toHaveLength(1);
    expect(ann.fives[0]).toMatchObject({ a: ann.me.id, b: bob.me.id, move: Move.High, grade: Grade.Perfect });
    expect(bob.me.state.score).toBe(100);
    // and the next one straight after is too soon: it's the same five
    expect(bob.fives).toHaveLength(1);
  });

  it('holds a hand still over your head to offer, and pulls it away fast for a too-slow', () => {
    const { net, ann, right } = headset();
    right.grip = { x: 30.2, y: 40.25, z: 1.95 };
    right.tip = { ...right.grip };
    run(net, [ann], 400);
    expect(ann.me.state.offer).toBe(Move.High);
    swing(net, [ann], right, { x: 30.2, y: 40.25, z: 1.95 }, { x: 30.3, y: 39.9, z: 0.9 }, 4);
    expect(ann.me.state.offer).toBe(Move.None);
    expect(ann.me.state.yank).toBe(Move.High);
  });

  it('needs both hands on a double, and a fist for a fist bump', () => {
    const { net, ann, bob, right, left } = headset();
    bob.intent.move = Move.Double;
    run(net, [ann, bob], 400);
    const pose = offerPose(Move.Double, bob.me.state.head);
    const theirLeft = posePoint(bob.me.x, bob.me.y, 0, bob.me.state.yaw, pose, true, { x: 0, y: 0, z: 0 });
    const theirRight = posePoint(bob.me.x, bob.me.y, 0, bob.me.state.yaw, pose, false, { x: 0, y: 0, z: 0 });
    const frames = 14;
    for (let i = 0; i <= frames; i++) {
      const t = i / frames;
      for (const [h, p] of [
        [right, theirLeft],
        [left, theirRight],
      ] as const) {
        h.grip = { x: 30 + (p.x - 30) * (0.4 + 0.65 * t), y: 40 + (p.y - 40) * (0.4 + 0.65 * t), z: 1.2 + (p.z - 1.2) * t };
        h.tip = { ...h.grip };
      }
      run(net, [ann, bob], 16);
    }
    run(net, [ann, bob], 500);
    expect(ann.fives[0]?.move).toBe(Move.Double);

    bob.intent.move = Move.Fist;
    run(net, [ann, bob], 1000);
    const fist = posePoint(bob.me.x, bob.me.y, 0, bob.me.state.yaw, offerPose(Move.Fist, bob.me.state.head), false, { x: 0, y: 0, z: 0 });
    right.grab = false;
    swing(net, [ann, bob], right, { x: fist.x, y: fist.y - 0.6, z: fist.z }, { x: fist.x, y: fist.y + 0.1, z: fist.z }, 3);
    run(net, [ann, bob], 400);
    expect(ann.fives[1]?.grade).toBe(Grade.Awkward);
  });
});

describe('Butt slaps', () => {
  /** Ann behind Bob, both facing north. */
  function behind(): { net: Sim; ann: Peer; bob: Peer } {
    const net = new Sim();
    const ann = peer(net, 'ann');
    const bob = peer(net, 'bob');
    place(ann, 30, 40, Math.PI / 2);
    place(bob, 30, 41, Math.PI / 2);
    run(net, [ann, bob], 600);
    return { net, ann, bob };
  }

  it('slaps a backside from behind, scores it, and makes them stumble', () => {
    const { net, ann, bob } = behind();
    expect(ann.role.slapCheck).toBe('ok');
    ann.intent.slap = true;
    run(net, [ann, bob], 100);
    expect(ann.me.state.windup).toBe(bob.me.id);
    run(net, [ann, bob], SLAP_MS + 400);
    expect(bob.slaps).toHaveLength(1);
    expect(bob.slaps[0].denied).toBe(false);
    expect(ann.me.state.score).toBe(SLAP_POINTS);
    expect(bob.me.state.score).toBe(0);
    expect(bob.me.state.y).toBeGreaterThan(41.2);
    // and it needs a moment before it's fair game again
    expect(ann.role.slapCheck).toBe('resting');
  });

  it('is denied when they turn round in time, and they score for it', () => {
    const { net, ann, bob } = behind();
    ann.intent.slap = true;
    run(net, [ann, bob], 50);
    // Bob hears it coming and turns round
    expect(bob.role.alert).toBe('windup');
    bob.role.heading = -Math.PI / 2;
    run(net, [ann, bob], SLAP_MS + 400);
    expect(ann.slaps[0].denied).toBe(true);
    expect(bob.me.state.score).toBe(DENY_POINTS);
    expect(ann.me.state.score).toBe(0);
  });

  it("can't be done from the front, or to someone who's turned slaps off", () => {
    const { net, ann, bob } = behind();
    bob.role.heading = -Math.PI / 2;
    run(net, [ann, bob], 300);
    expect(ann.role.slapCheck).toBe('front');
    bob.role.heading = Math.PI / 2;
    bob.role.noSlaps = true;
    run(net, [ann, bob], 300);
    expect(ann.role.slapCheck).toBe('theirs-off');
    ann.intent.slap = true;
    run(net, [ann, bob], SLAP_MS + 400);
    expect(bob.slaps).toHaveLength(0);
  });

  it('warns you of someone standing behind you, but not of someone creeping', () => {
    const { net, ann, bob } = behind();
    expect(bob.role.alert).toBe('behind');
    run(net, [ann, bob], 300, () => (ann.intent.crouch = true));
    expect(bob.role.alert).toBe(null);
  });
});

describe('The team', () => {
  it('keeps three buddies about, and one comes over to take a five that is held out', () => {
    // no dice: buddies always take a five, and always land a perfect one
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const net = new Sim();
    const ann = peer(net, 'ann');
    const keeper = new TeamKeeper(ann.ctx);
    place(ann, 30, 12, Math.PI / 2);
    run(net, [ann], 4000, () => stepRules(ann.ctx, keeper, 0.016, net.now));
    const buddies = [...ann.ctx.world.all(Buddy)];
    expect(buddies.map((b) => b.state.slot).sort()).toEqual([BuddyKind.Coach, BuddyKind.Lineman, BuddyKind.Mascot]);
    ann.intent.move = Move.High;
    let taken = false;
    for (let i = 0; i < 40 && !taken; i++) {
      run(net, [ann], 250, () => stepRules(ann.ctx, keeper, 0.016, net.now));
      // hold it out as long as it takes
      if (ann.me.state.offer === Move.None && !ann.fives.length) ann.intent.move = Move.High;
      taken = ann.fives.length > 0;
    }
    expect(taken).toBe(true);
    const five = ann.fives[0];
    expect(buddies.some((b) => b.id === five.a)).toBe(true);
    expect(five.grade).toBe(Grade.Perfect);
    expect(ann.me.state.score).toBe(100);
    const coach = ann.ctx.world.get(five.a)!;
    expect((coach.state as { mode: BuddyMode }).mode).toBe(BuddyMode.React);
  });
});
