import { describe, expect, it } from 'vitest';
import { ByteReader, ByteWriter } from '../src/engine/net/codec';
import { defineAction, defineCommand, defineEntity, t } from '../src/engine/net/schema';
import { Singleton } from '../src/engine/net/singleton';
import { defineLocal, type NetEntity } from '../src/engine/net/entity';
import type { NetWorld } from '../src/engine/net/world';
import { Sim } from './harness';

const Avatar = defineEntity({
  name: 'avatar',
  fields: { x: t.fixed(0.5), y: t.fixed(0.5), angle: t.angle(10), hp: t.uint(8, 100), name: t.string(16) },
});
const Crate = defineEntity({
  name: 'crate',
  fields: { x: t.fixed(1), y: t.fixed(1), color: t.uint(8) },
  migratable: true,
});
const Ping = defineAction('ping', { n: t.int(), who: t.string() });
const Hit = defineAction('hit', { target: t.ref(), dmg: t.uint(8) });
const Paint = defineCommand('paint', { crate: t.ref(), color: t.uint(8) }, { target: 'crate' });
const Match = defineEntity({ name: 'match', fields: { x: t.fixed(1), y: t.fixed(1), round: t.uint(8) }, migratable: true });

const base = { worldId: 'test', entities: [Avatar, Crate, Match], actions: [Ping, Hit, Paint], interestRadius: 800, zoneSize: 2048 };

function find(w: { get(id: number): NetEntity<any> | undefined }, id: number) {
  return w.get(id);
}

describe('codec', () => {
  it('round-trips primitives', () => {
    const w = new ByteWriter(4);
    w.u8(200).u16(65000).u32(4_000_000_000).f32(1.5).f64(Math.PI).varuint(300).varint(-12345).id48(0xabcdef123456).string('héllo');
    for (const v of [0, 1, 127, 128, 2 ** 40, Number.MAX_SAFE_INTEGER]) w.varuint(v);
    const r = new ByteReader(w.finish());
    expect([r.u8(), r.u16(), r.u32(), r.f32(), r.f64(), r.varuint(), r.varint(), r.id48(), r.string()]).toEqual([
      200, 65000, 4_000_000_000, 1.5, Math.PI, 300, -12345, 0xabcdef123456, 'héllo',
    ]);
    for (const v of [0, 1, 127, 128, 2 ** 40, Number.MAX_SAFE_INTEGER]) expect(r.varuint()).toBe(v);
    expect(r.remaining).toBe(0);
  });

  it('quantizes angles and fixed point', () => {
    const a = t.angle(8);
    expect(a.dequantize(a.quantize(-Math.PI / 2))).toBeCloseTo((3 * Math.PI) / 2, 1);
    const f = t.fixed(0.5);
    expect(f.quantize(10.24)).toBe(20);
    expect(f.quantize(10.26)).toBe(21);
  });
});

describe('bytes fields', () => {
  it('round-trip a blob, diff by contents, and clip to the limit', () => {
    const f = t.bytes(4);
    const blob = new Uint8Array([0, 7, 200, 255]);
    const q = f.quantize(blob);
    expect(f.quantize(new Uint8Array([0, 7, 200, 255]))).toBe(q);
    const w = new ByteWriter();
    f.write(w, q);
    const back = f.dequantize(f.read(new ByteReader(w.finish())));
    expect([...back]).toEqual([0, 7, 200, 255]);
    expect(f.quantize(new Uint8Array([1, 2, 3, 4, 5]))).toHaveLength(4);
  });
});

describe('replication', () => {
  it('replicates spawn, deltas and despawn inside the interest radius', () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const b = sim.add('b', base);
    a.setFocus(100, 100);
    b.setFocus(300, 100);
    const e = a.spawn(Avatar, { x: 100, y: 100, name: 'alice' });
    sim.run(600);

    const remote = find(b, e.id)!;
    expect(remote).toBeDefined();
    expect(remote.mine).toBe(false);
    expect(remote.state.name).toBe('alice');

    e.state.x = 180;
    e.state.hp = 42;
    sim.run(400);
    expect(remote.state.x).toBe(180);
    expect(remote.state.hp).toBe(42);
    expect(remote.render.x).toBeCloseTo(180, 0);

    let reason = '';
    b.on('entityRemoved', (_e, r) => (reason = r));
    a.despawn(e);
    sim.run(200);
    expect(find(b, e.id)).toBeUndefined();
    expect(reason).toBe('destroyed');
  });

  it('only sends entities inside the receiver interest radius, and removes them on exit', () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const b = sim.add('b', base);
    a.setFocus(0, 0);
    b.setFocus(0, 0);
    const far = a.spawn(Avatar, { x: 1500, y: 0 });
    const near = a.spawn(Avatar, { x: 200, y: 0 });
    sim.run(600);
    expect(find(b, near.id)).toBeDefined();
    expect(find(b, far.id)).toBeUndefined();

    near.state.x = 1400; // beyond 1.2 * 800
    sim.run(600);
    expect(find(b, near.id)).toBeUndefined();

    far.state.x = 100;
    sim.run(600);
    expect(find(b, far.id)?.state.x).toBe(100);
  });

  it('peers far apart are not connected at all', () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const b = sim.add('b', base);
    a.setFocus(500, 500);
    b.setFocus(20000, 20000);
    sim.run(500);
    expect(a.peerCount).toBe(0);
    b.setFocus(900, 500);
    sim.run(800);
    expect(a.peerCount).toBe(1);
    expect(b.peerCount).toBe(1);
  });

  it('transfers ownership on request and respects the transfer policy', async () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const b = sim.add('b', base);
    a.setFocus(0, 0);
    b.setFocus(0, 0);
    const crate = a.spawn(Crate, { x: 10, y: 10, color: 3 });
    a.setTransferPolicy(Crate, (e) => e.state.color !== 99);
    sim.run(500);

    const onB = find(b, crate.id)!;
    let granted: boolean | undefined;
    b.requestOwnership(onB).then((ok) => (granted = ok));
    sim.run(400);
    await Promise.resolve();
    expect(granted).toBe(true);
    expect(onB.mine).toBe(true);
    expect(onB.held).toBe(true);
    expect(crate.mine).toBe(false);

    onB.state.x = 55;
    sim.run(300);
    expect(crate.state.x).toBe(55);

    // B now owns it and denies when color is 99 (policy registered on B)
    b.setTransferPolicy(Crate, (e) => e.state.color !== 99);
    onB.state.color = 99;
    b.release(onB);
    sim.run(300);
    let second: boolean | undefined;
    a.requestOwnership(crate).then((ok) => (second = ok));
    sim.run(400);
    await Promise.resolve();
    expect(second).toBe(false);
  });

  it('migratable entities survive their owner leaving; avatars do not', () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const b = sim.add('b', base);
    const c = sim.add('c', base);
    for (const w of [a, b, c]) w.setFocus(100, 100);
    const crate = a.spawn(Crate, { x: 120, y: 120 }, { held: true });
    const avatar = a.spawn(Avatar, { x: 100, y: 100 });
    sim.run(800);
    expect(find(b, crate.id)).toBeDefined();
    expect(find(c, avatar.id)).toBeDefined();

    sim.remove(a);
    sim.run(4000);
    const onB = find(b, crate.id)!;
    const onC = find(c, crate.id)!;
    expect(onB).toBeDefined();
    expect(onC).toBeDefined();
    // exactly one survivor owns it and both agree who
    expect(Number(onB.mine) + Number(onC.mine)).toBe(1);
    expect(onB.owner).toBe(onC.owner);
    expect(onB.epoch).toBe(onC.epoch);
    expect(find(b, avatar.id)).toBeUndefined();
    expect(find(c, avatar.id)).toBeUndefined();
  });

  it('rebalances migratable entities across peers and converges on one owner each', () => {
    const sim = new Sim();
    const peers = ['p1', 'p2', 'p3', 'p4'].map((id) => sim.add(id, { ...base, cellSize: 128 }));
    for (const w of peers) w.setFocus(400, 400);
    const crates = [];
    for (let i = 0; i < 40; i++) crates.push(peers[0].spawn(Crate, { x: 50 + (i % 8) * 100, y: 50 + Math.floor(i / 8) * 100 }));
    sim.run(8000);
    const ownersById = new Map<number, Set<string>>();
    const perPeer = new Map<string, number>();
    for (const w of peers) {
      for (const e of w.all(Crate)) {
        if (!ownersById.has(e.id)) ownersById.set(e.id, new Set());
        ownersById.get(e.id)!.add(e.owner);
        if (e.mine) perPeer.set(w.selfId, (perPeer.get(w.selfId) ?? 0) + 1);
      }
    }
    expect(ownersById.size).toBe(40);
    for (const owners of ownersById.values()) expect(owners.size).toBe(1);
    // load actually spread out
    expect(perPeer.size).toBeGreaterThan(1);
    expect([...perPeer.values()].reduce((s, n) => s + n, 0)).toBe(40);
  });

  it('resolves simultaneous ownership claims deterministically', () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const b = sim.add('b', base);
    a.setFocus(0, 0);
    b.setFocus(0, 0);
    const ea = a.spawn(Crate, { x: 10, y: 10 }, { held: true });
    sim.run(500);
    const eb = b.get(ea.id)!;
    // Force a split-brain: both believe they own it with the same epoch.
    (b as any).takeOwnership(eb, ea.epoch, 'a', true);
    ea.state.x = 30;
    eb.state.x = 60;
    sim.run(1500);
    expect(Number(ea.mine) + Number(eb.mine)).toBe(1);
    expect(ea.owner).toBe('a'); // 'a' < 'b' wins ties
    expect(eb.state.x).toBe(30);
  });

  it('routes actions to owners (with forwarding) and to nearby peers', () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const b = sim.add('b', base);
    const c = sim.add('c', { ...base });
    a.setFocus(0, 0);
    b.setFocus(100, 0);
    c.setFocus(5000, 5000);
    const got: string[] = [];
    for (const w of [a, b, c]) {
      w.onAction(Ping, (p, ctx) => got.push(`${w.selfId}<-${ctx.from}:${p.n}`));
      w.onAction(Hit, (p, ctx) => {
        const target = w.get(p.target);
        if (target?.mine) {
          target.state.hp -= p.dmg;
          got.push(`${w.selfId} hit by ${ctx.from}`);
        }
      });
    }
    const av = a.spawn(Avatar, { x: 0, y: 0, hp: 100 });
    sim.run(600);
    b.send(Hit, { target: av.id, dmg: 30 }, { to: 'owner', entity: b.get(av.id)! });
    b.send(Ping, { n: 7, who: 'b' }, { to: 'near', x: 0, y: 0 });
    sim.run(300);
    expect(av.state.hp).toBe(70);
    expect(got).toContain('a hit by b');
    expect(got).toContain('a<-b:7');
    expect(got).toContain('b<-b:7');
    expect(got.some((g) => g.startsWith('c'))).toBe(false);
  });

  it('keeps many peers consistent with bounded connections', () => {
    const sim = new Sim({ latencyMs: 40, jitterMs: 20, connectDelayMs: 200 });
    const N = 60;
    const worlds: NetWorld[] = [];
    const avatars: NetEntity<any>[] = [];
    const vel: [number, number][] = [];
    const size = 12000;
    for (let i = 0; i < N; i++) {
      const w = sim.add(`peer${String(i).padStart(3, '0')}`, base);
      const x = Math.random() * size;
      const y = Math.random() * size;
      w.setFocus(x, y);
      avatars.push(w.spawn(Avatar, { x, y }));
      vel.push([(Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4]);
      worlds.push(w);
    }
    sim.run(15000, () => {
      for (let i = 0; i < N; i++) {
        const s = avatars[i].state;
        s.x = Math.min(size, Math.max(0, s.x + vel[i][0] * 16));
        s.y = Math.min(size, Math.max(0, s.y + vel[i][1] * 16));
        worlds[i].setFocus(s.x, s.y);
      }
    });

    let expected = 0;
    let seen = 0;
    let maxLagMs = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (i === j) continue;
        const d = Math.hypot(avatars[i].state.x - avatars[j].state.x, avatars[i].state.y - avatars[j].state.y);
        if (d > 700) continue; // comfortably inside the radius
        expected++;
        const r = worlds[i].get(avatars[j].id);
        if (r) {
          seen++;
          const err = Math.hypot(r.state.x - avatars[j].state.x, r.state.y - avatars[j].state.y);
          const speed = Math.hypot(vel[j][0], vel[j][1]); // px per ms
          if (speed > 0.01) maxLagMs = Math.max(maxLagMs, err / speed);
        }
      }
    }
    const avgPeers = worlds.reduce((s, w) => s + w.peerCount, 0) / N;
    expect(seen).toBe(expected);
    // latency (40-60ms) + tick alignment (50ms) + far-LOD throttle (up to 200ms) + frame
    expect(maxLagMs).toBeLessThan(400);
    // zones keep each peer connected to a fraction of the population
    expect(avgPeers).toBeLessThan(N / 3);
  });
});

describe('commands, locks, singletons and tracking', () => {
  it('carries out a command only on its target\'s owner, following the target when it changes hands', () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const b = sim.add('b', base);
    const c = sim.add('c', base);
    for (const w of [a, b, c]) w.setFocus(0, 0);
    const ran: string[] = [];
    for (const w of [a, b, c]) {
      w.onCommand(Paint, Avatar, () => ran.push(`${w.selfId} avatar`));
      w.onCommand(Paint, Crate, (crate, p, ctx) => {
        crate.state.color = p.color;
        ran.push(`${w.selfId} crate from ${ctx.from}`);
      });
    }
    const crate = a.spawn(Crate, { x: 10, y: 10 }, { held: true });
    sim.run(600);
    c.command(Paint, { crate: crate.id, color: 5 });
    sim.run(300);
    expect(crate.state.color).toBe(5);
    expect(ran).toEqual(['a crate from c']);

    // b takes it over; c still believes a owns it, so a forwards the next one
    a.release(crate);
    void b.requestOwnership(b.get(crate.id)!);
    sim.run(400);
    expect(b.get(crate.id)!.mine).toBe(true);
    ran.length = 0;
    const onC = c.get(crate.id)!;
    onC.owner = 'a';
    c.command(Paint, { crate: crate.id, color: 9 });
    sim.run(400);
    expect(b.get(crate.id)!.state.color).toBe(9);
    expect(ran).toEqual(['b crate from c']);
  });

  it('refuses a command whose target field is not a reference', () => {
    expect(() => defineCommand('bad', { target: t.uint(8) })).toThrow(/t.ref/);
  });

  it('lets only one of two peers win a lock, and releases it after', async () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const b = sim.add('b', base);
    const c = sim.add('c', base);
    for (const w of [a, b, c]) w.setFocus(0, 0);
    const crate = a.spawn(Crate, { x: 10, y: 10 });
    sim.run(600);
    const results: (string | undefined)[] = [];
    for (const w of [b, c]) {
      void w
        .withLock(w.get(crate.id)!, (e) => {
          if (e.state.color !== 0) return undefined; // someone got there first
          e.state.color = w === b ? 1 : 2;
          return w.selfId;
        })
        .then((r) => results.push(r));
    }
    for (let i = 0; i < 20; i++) {
      sim.run(50);
      await Promise.resolve();
    }
    expect(results).toHaveLength(2);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.find(Boolean) === 'b' ? b : c;
    const held = winner.get(crate.id)!;
    expect(held.mine).toBe(true);
    expect(held.held).toBe(false);
    sim.run(600);
    expect(a.get(crate.id)!.state.color).toBe(winner === b ? 1 : 2);
  });

  it('keeps a lock held that was held before', async () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const crate = a.spawn(Crate, { x: 0, y: 0 }, { held: true });
    const r = a.withLock(crate, () => 'ok');
    sim.run(50);
    expect(await r).toBe('ok');
    expect(crate.held).toBe(true);
  });

  it('converges on one singleton when peers make one at once, and it outlives its maker', () => {
    const sim = new Sim();
    const worlds = ['a', 'b', 'c'].map((id) => sim.add(id, base));
    for (const w of worlds) w.setFocus(0, 0);
    // no waiting: every peer makes its own straight away
    const keepers = worlds.map((w) => new Singleton(w, Match, { init: () => ({ x: 5, y: 5 }), waitMs: 0, jitterMs: 0 }));
    sim.run(3000, (now) => keepers.forEach((k) => k.update(now)));
    const ids = keepers.map((k) => k.entity?.id);
    expect(new Set(ids).size).toBe(1);
    for (const w of worlds) expect(w.all(Match).size).toBe(1);

    const owner = worlds.find((w) => keepers[worlds.indexOf(w)].entity!.mine)!;
    const i = worlds.indexOf(owner);
    sim.remove(owner);
    keepers.splice(i, 1);
    sim.run(5000, (now) => keepers.forEach((k) => k.update(now)));
    expect(keepers.map((k) => k.entity?.id)).toEqual([ids[0], ids[0]]);
    expect(keepers.filter((k) => k.entity!.mine)).toHaveLength(1);
  });

  it('tracks the entities of one type, including ones already known', () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const early = a.spawn(Crate, { x: 0, y: 0 });
    a.spawn(Avatar, { x: 0, y: 0 });
    const seen: string[] = [];
    const stop = a.track(Crate, { added: (e) => seen.push(`+${e.id === early.id ? 'early' : 'late'}`), removed: (_e, why) => seen.push(`-${why}`) });
    const late = a.spawn(Crate, { x: 1, y: 1 });
    a.despawn(early);
    stop();
    a.despawn(late);
    expect(seen).toEqual(['+early', '+late', '-despawned']);
  });

  it('keeps each type\'s owned and remote entities in step as ownership moves', async () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const b = sim.add('b', base);
    a.setFocus(0, 0);
    b.setFocus(0, 0);
    const crate = a.spawn(Crate, { x: 10, y: 10 });
    const avatar = a.spawn(Avatar, { x: 0, y: 0 });
    sim.run(600);
    const onB = b.get(crate.id)!;
    expect([...a.owned(Crate)]).toEqual([crate]);
    expect([...a.owned(Avatar)]).toEqual([avatar]);
    expect(a.remote(Crate).size).toBe(0);
    expect([...b.remote(Crate)]).toEqual([onB]);

    void b.requestOwnership(onB);
    sim.run(400);
    await Promise.resolve();
    expect(a.owned(Crate).size).toBe(0);
    expect([...a.remote(Crate)]).toEqual([crate]);
    expect([...b.owned(Crate)]).toEqual([onB]);
    expect(b.remote(Crate).size).toBe(0);

    b.despawn(onB);
    sim.run(300);
    for (const w of [a, b]) expect(w.owned(Crate).size + w.remote(Crate).size).toBe(0);
    expect(b.remote(Avatar).size).toBe(1);
  });

  it('keeps typed local data per entity, apart for each kind', () => {
    const sim = new Sim();
    const a = sim.add('a', base);
    const Mind = defineLocal(() => ({ fleeUntil: 0 }));
    const Memory = defineLocal<{ seen?: number }>(() => ({}));
    const one = a.spawn(Crate, { x: 0, y: 0 });
    const two = a.spawn(Crate, { x: 1, y: 1 });
    Mind.of(one).fleeUntil = 50;
    Memory.of(one).seen = 3;
    expect(Mind.of(one)).toEqual({ fleeUntil: 50 });
    expect(Mind.of(two)).toEqual({ fleeUntil: 0 });
    expect(Memory.of(one).seen).toBe(3);
    expect(Memory.of(two).seen).toBeUndefined();
  });
});
