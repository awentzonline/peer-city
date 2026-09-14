/**
 * Headless scale test: hundreds of simulated browsers sharing one big world
 * over an in-memory network with latency. Reports connection counts,
 * bandwidth, replication consistency and ownership convergence, including a
 * churn phase where a slice of peers leaves abruptly and new ones join.
 *
 *   npm run sim -- --peers 200 --seconds 40 --npcs 12
 */
import { defineEntity, t, type NetEntity } from '../src/engine/index';
import type { NetWorld } from '../src/engine/net/world';
import { Sim } from '../tests/harness';

declare const process: { argv: string[] };

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const PEERS = Number(args.get('peers') ?? 150);
const SECONDS = Number(args.get('seconds') ?? 40);
const NPCS = Number(args.get('npcs') ?? 10);
const SIZE = Number(args.get('size') ?? 16000);
const ZONE = Number(args.get('zone') ?? 2048);
const RADIUS = Number(args.get('radius') ?? 1100);

const Avatar = defineEntity({ name: 'avatar', fields: { x: t.fixed(0.5), y: t.fixed(0.5), angle: t.angle(8), hp: t.uint(8, 100) } });
const Npc = defineEntity({ name: 'npc', fields: { x: t.fixed(0.5), y: t.fixed(0.5), angle: t.angle(8), mood: t.uint(8) }, migratable: true });

interface Client {
  world: NetWorld;
  avatar: NetEntity<{ x: number; y: number; angle: number; hp: number }>;
  vx: number;
  vy: number;
}

const sim = new Sim({ latencyMs: 45, jitterMs: 25, connectDelayMs: 400 });
const clients: Client[] = [];
let serial = 0;

function addClient(): Client {
  const world = sim.add(`peer-${String(serial++).padStart(4, '0')}`, {
    worldId: 'loadsim',
    entities: [Avatar, Npc],
    zoneSize: ZONE,
    cellSize: 512,
    interestRadius: RADIUS,
  });
  // cluster players loosely so plenty of them share space
  const hub = [SIZE * 0.3, SIZE * 0.7][serial % 2];
  const x = hub + (Math.random() - 0.5) * SIZE * 0.5;
  const y = hub + (Math.random() - 0.5) * SIZE * 0.5;
  world.setFocus(x, y);
  const avatar = world.spawn(Avatar, { x, y });
  for (let i = 0; i < NPCS; i++) world.spawn(Npc, { x: x + (Math.random() - 0.5) * 1200, y: y + (Math.random() - 0.5) * 1200 });
  const c: Client = { world, avatar, vx: 0, vy: 0 };
  clients.push(c);
  return c;
}

for (let i = 0; i < PEERS; i++) addClient();

function stepClients(dtMs: number) {
  for (const c of clients) {
    if (Math.random() < 0.01) {
      const a = Math.random() * Math.PI * 2;
      const speed = Math.random() * 0.25; // up to 250 px/s
      c.vx = Math.cos(a) * speed;
      c.vy = Math.sin(a) * speed;
    }
    const s = c.avatar.state;
    s.x = Math.max(0, Math.min(SIZE, s.x + c.vx * dtMs));
    s.y = Math.max(0, Math.min(SIZE, s.y + c.vy * dtMs));
    s.angle = Math.atan2(c.vy, c.vx);
    c.world.setFocus(s.x, s.y);
    for (const npc of c.world.all(Npc)) {
      if (!npc.mine) continue;
      npc.state.angle += (Math.random() - 0.5) * 0.2;
      npc.state.x += Math.cos(npc.state.angle) * 0.04 * dtMs;
      npc.state.y += Math.sin(npc.state.angle) * 0.04 * dtMs;
    }
  }
}

function report(label: string) {
  const peers = clients.map((c) => c.world.peerCount);
  const rooms = clients.map((c) => c.world.stats.rooms);
  const up = clients.map((c) => c.world.stats.bytesOutPerSec / 1024);
  const down = clients.map((c) => c.world.stats.bytesInPerSec / 1024);
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const max = (a: number[]) => Math.max(...a);
  const npcOwners = new Map<number, Set<string>>();
  let npcTotal = 0;
  for (const c of clients) {
    for (const n of c.world.all(Npc)) {
      if (n.mine) npcTotal++;
      let set = npcOwners.get(n.id);
      if (!set) npcOwners.set(n.id, (set = new Set()));
      set.add(n.owner);
    }
  }
  const split = [...npcOwners.values()].filter((s) => s.size > 1).length;
  const handoffs = clients.reduce((s, c) => s + c.world.stats.handoffs, 0);
  const handoffRate = (handoffs - lastHandoffs) / 5 / Math.max(1, npcTotal);
  lastHandoffs = handoffs;
  console.log(
    `${label.padEnd(10)} clients=${clients.length} peers avg ${avg(peers).toFixed(1)} max ${max(peers)} | rooms avg ${avg(rooms).toFixed(1)} | ` +
      `up avg ${avg(up).toFixed(1)} max ${max(up).toFixed(1)} KB/s | down avg ${avg(down).toFixed(1)} max ${max(down).toFixed(1)} KB/s | ` +
      `npcs ${npcTotal} split-views ${split} | handoffs/npc/s ${handoffRate.toFixed(3)}`,
  );
}
let lastHandoffs = 0;

function consistency() {
  let expected = 0;
  let seen = 0;
  let lagSum = 0;
  let lagN = 0;
  for (const a of clients) {
    for (const b of clients) {
      if (a === b) continue;
      const d = Math.hypot(a.avatar.state.x - b.avatar.state.x, a.avatar.state.y - b.avatar.state.y);
      if (d > RADIUS * 0.85) continue;
      expected++;
      const r = a.world.get(b.avatar.id);
      if (!r) continue;
      seen++;
      const err = Math.hypot(r.state.x - b.avatar.state.x, r.state.y - b.avatar.state.y);
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > 0.02) {
        lagSum += err / speed;
        lagN++;
      }
    }
  }
  return { expected, seen, avgLagMs: lagN ? lagSum / lagN : 0 };
}

const start = Date.now();
const half = (SECONDS * 1000) / 2;
for (let elapsed = 0; elapsed < SECONDS * 1000; elapsed += 1000) {
  sim.run(1000, () => stepClients(16));
  if (elapsed === Math.floor(half / 1000) * 1000) {
    const leaving = clients.splice(0, Math.floor(clients.length * 0.15));
    for (const c of leaving) sim.remove(c.world);
    for (let i = 0; i < leaving.length; i++) addClient();
    console.log(`--- churn: ${leaving.length} peers dropped without warning, ${leaving.length} joined ---`);
  }
  if ((elapsed / 1000) % 5 === 4) report(`t=${elapsed / 1000 + 1}s`);
}

function unownedNpcs(): Set<number> {
  const known = new Set<number>();
  for (const cl of clients) for (const n of cl.world.all(Npc)) known.add(n.id);
  return new Set([...known].filter((id) => !clients.some((cl) => cl.world.get(id)?.mine)));
}

// settle, then verify
sim.run(5000, () => stepClients(16));
const c = consistency();
report('final');
const unownedNow = unownedNpcs();
const known = new Set<number>();
for (const cl of clients) for (const n of cl.world.all(Npc)) known.add(n.id);
// Unowned copies should be transient (handoffs in flight, stale copies awaiting cleanup).
sim.run(6000, () => stepClients(16));
const unownedLater = unownedNpcs();
const persistent = [...unownedNow].filter((id) => unownedLater.has(id)).length;
const handoffs = clients.reduce((s, cl) => s + cl.world.stats.handoffs, 0);
const claims = clients.reduce((s, cl) => s + cl.world.stats.claims, 0);
const conflicts = clients.reduce((s, cl) => s + cl.world.stats.conflicts, 0);
console.log(
  `visibility: ${c.seen}/${c.expected} nearby avatars replicated (${((100 * c.seen) / Math.max(1, c.expected)).toFixed(2)}%), ` +
    `avg staleness ${c.avgLagMs.toFixed(0)}ms | npcs known ${known.size}, unowned at an instant ${unownedNow.size}, still unowned 6s later ${persistent}`,
);
console.log(`ownership: current peers made ${handoffs} handoffs, ${claims} orphan claims, ${conflicts} conflicts resolved`);
console.log(`simulated ${SECONDS + 5}s of ${PEERS} peers in ${((Date.now() - start) / 1000).toFixed(1)}s wall`);
