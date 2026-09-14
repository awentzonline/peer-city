# p2p-game-engine

A framework for **serverless, peer-to-peer, open-world multiplayer browser games**, built on
TypeScript + [Phaser 4](https://phaser.io) + [Trystero](https://github.com/dmotz/trystero) (WebRTC),
plus **Peer City**, a small top-down GTA-style sandbox that proves it out.

No game server, no relay for game data: browsers find each other through Trystero's
public signalling (Nostr by default) and then talk directly over WebRTC data channels.

```bash
nvm use            # Node 20+ (repo pins 22)
npm install
npm run dev        # http://localhost:5173
npm test           # engine unit + multi-peer simulation tests
npm run sim -- --peers 200 --seconds 40   # headless scale test
```

Open several tabs (pick **Local tabs** for an offline BroadcastChannel network, or **Online** to
connect across machines) and play together. `?debug` shows live network stats (toggle with `` ` ``).

---

## Why this is hard, and how the engine approaches it

A full WebRTC mesh stops working past a few dozen peers, and without a server nobody is in
charge of the NPCs. The engine tackles both problems with four ideas:

### 1. Zones: only connect to peers you might see

The world is cut into square **zones** (default 2048px). Each zone is a Trystero room. A peer
joins the rooms of every zone overlapping its interest circle (with hysteresis), so its
connections are limited to its neighbourhood rather than the whole player base.
Trystero shares one `RTCPeerConnection` per remote peer across rooms, so overlapping zones
don't duplicate connections. When the last shared room goes away, a grace period absorbs
zone hops without entity churn.

### 2. Interest management + field-level deltas

Every peer advertises its **focus** (camera position + radius). Owners send each peer only the
entities inside that peer's radius:

- Fields are **quantized per type** (`t.fixed(0.5)`, `t.angle(10)`, `t.uint(8)`, ...) and diffed
  against *what that particular peer last received*. Data channels are reliable and ordered, so a
  field that didn't change costs nothing: no acks, no snapshots.
- **Distance-based update rates**: near entities every tick, mid every 2, far every 4.
- A **per-peer byte budget** each tick, allocated by priority × staleness.
- Keepalives, a "settled" update after motion stops, periodic full refreshes, and
  resync-on-unknown-delta make the stream self-healing.
- Remote entities are rendered through a **snapshot interpolation buffer** (clock-offset
  corrected, gap-bridged, capped extrapolation).

### 3. Ownership, authority and migration

Every entity has exactly one **owner** that simulates it; others only receive it.

- Player-controlled things are owned by their player.
- **Migratable** entities (NPCs, cars, pickups) belong to the peer that wins a
  **rendezvous hash** over the zone's members for the entity's **cell** (default 512px). As
  players come and go only the affected cells move, NPC load spreads across nearby peers, and
  entities hand off as they wander.
- If an owner vanishes, the new winner claims its migratable entities with a higher **epoch**.
  Conflicts are resolved by `(epoch, peerId)`, so every peer converges on the same owner.
- `requestOwnership(e)` asks the current owner to hand over an entity (enter a car, pick up an
  item). The owner's **transfer policy** decides, which makes ownership a distributed lock.

### 4. Typed actions

Events and RPCs are schema-encoded binary messages with routing:
`{to:'owner', entity}` (forwarded if ownership moved in flight), `{to:'near', x, y, radius}`,
`{to:'peer', peer}`, `{to:'all'}`. Damage, for example, is sent to the victim's owner, the
only peer allowed to write the victim's state.

---

## Using the framework

### Declare what's replicated

```ts
import { defineEntity, defineAction, t } from '@engine/index';

export const Car = defineEntity({
  name: 'car',
  fields: {
    x: t.fixed(0.5),          // half-pixel precision, varint encoded
    y: t.fixed(0.5),
    angle: t.angle(10),       // 10 bits, interpolates the short way round
    speed: t.fixed(1, 0, 'none'),
    hp: t.uint(8, 100),
    driver: t.ref(),          // another entity
    mode: t.uint(8),
  },
  migratable: true,           // survives its owner leaving; rebalanced by region
  priority: 2,                // wins bandwidth over priority-1 things
  cullDistance: 1700,         // owner despawns it when no player is near
});

export const Damage = defineAction('damage', { target: t.ref(), amount: t.uint(8) });
```

Only fields that change are sent, so put AI state that must survive migration (waypoints,
targets) in the schema and keep scratch data in `entity.local`.

### Create a world

```ts
import { NetWorld } from '@engine/index';
import { TrysteroTransport } from '@engine/transport/trystero';

const world = new NetWorld({
  transport: new TrysteroTransport({ appId: 'my-game' }),   // or BroadcastTransport / MemoryNetwork
  worldId: 'my-game/shard-1',
  entities: [Player, Car, Ped],      // same order on every peer (schema is fingerprinted)
  actions: [Damage],
  zoneSize: 2048,
  cellSize: 512,
  interestRadius: 1100,
  tickRate: 20,
});
```

### Game loop

```ts
update() {
  world.update();                       // receive, tick, interpolate
  world.setFocus(me.state.x, me.state.y);

  for (const car of world.all(Car)) {
    if (!car.mine) continue;            // simulate only what you own
    car.state.x += ...;                 // just mutate state; the engine diffs it
  }
  views.update(dt);                     // draw from entity.render (interpolated for remote)
}
```

### Common calls

| Call | Purpose |
| --- | --- |
| `world.spawn(Def, init, {held})` / `world.despawn(e)` | create / destroy (owner only) |
| `world.all(Def)`, `world.get(id)`, `world.getAs(Def, id)` | lookup |
| `world.query(x, y, r, Def?)` | spatial query on rendered positions |
| `world.requestOwnership(e)` → `Promise<boolean>`, `world.release(e)` | take / give back control |
| `world.setTransferPolicy(Def, (e, requester) => bool)` | guard handovers |
| `world.send(Action, payload, target)`, `world.onAction(Action, fn)` | typed events |
| `world.on('entityAdded' / 'entityRemoved' / 'ownershipGained' / 'ownershipLost' / 'peerJoined' / 'peerLeft')` | lifecycle |
| `world.isAuthorityFor(x, y)`, `world.isObserved(x, y, r)`, `world.peerFoci()` | coordination helpers |
| `new EntityViews(world).register(Def, {create, update, destroy})` | bind entities to Phaser objects |
| `new NetDebugPanel(world)` | overlay with peers, rooms, KB/s, RTT |

### Transports

| Transport | Use |
| --- | --- |
| `TrysteroTransport` | production: serverless WebRTC (Nostr signalling; TURN configurable) |
| `BroadcastTransport` | many tabs on one machine, no network |
| `MemoryNetwork` | tests & headless simulation with latency/jitter and a fake clock |

Implementing `Transport` (join room → peer join/leave, send, receive) is all it takes to add another.

---

## Peer City (the demo)

A procedurally generated city (seeded, so no map data is networked) with traffic that follows
lanes and picks turns at intersections, pedestrians that roam sidewalks and flee from gunfire,
parked cars, cash pickups, and police that respond to your wanted level.

**Controls:** WASD move/drive · mouse aim · click shoot · **F** enter/exit car · Space handbrake ·
H horn · Shift run · `` ` `` net stats · N mute

How it uses the framework:

- **NPC population:** each peer spawns around its own focus using what it can see, and spawn
  chance is divided by the number of nearby players so density doesn't multiply. Engine
  rebalancing then spreads ownership across peers, and `cullDistance` removes what nobody sees.
- **Carjacking** is `requestOwnership(car)`. The car's owner (often another player's machine
  running traffic AI) hands it over, and the NPC driver is spawned as a fleeing pedestrian.
- **Combat:** shooters hit-scan against what they see and send `Damage` to the victim's owner;
  deaths send `Kill` back to the attacker's owner for wanted level and cash.
- **Police:** patrol cars ram suspects who are driving. When a suspect is on foot or stopped, the car
  pulls over and two officers get out (`police.ts`). Officers try to arrest you at 1 star. They
  shoot back at 2+ stars, or when they've seen you firing (every peer that receives your `Shot`
  remembers it). Arrest means an officer holding you for 1.4s. Their owner sends `Busted`, and your
  own peer confirms the officer is really beside you before applying it. You can outrun officers.
- **Pickups:** ownership acts as the lock, so only one player can collect each one.
- Traffic AI state (`dir`, `ri`, `ni`, `nd`) and the police chase `target` live in the schema, so
  a car keeps driving its route after migrating to another peer.

Source: `src/engine/` (framework) and `src/game/` (demo).

---

## Scaling results

`scripts/loadsim.ts` runs many `NetWorld`s in one process over a simulated network (45ms latency
plus 25ms jitter, 400ms connection setup). Avatars move at up to 250px/s and each peer starts with
10 wandering migratable NPCs. The world is 16,000px square and players are clustered around two hubs.
Halfway through, 15% of peers drop without warning and are replaced.

120 peers, 1,200+ NPCs, interest radius 1100px:

| Zone size | Peers per client (avg / max) | Rooms | Upload per client (avg / max) | Nearby avatars replicated | Avg staleness |
| --- | --- | --- | --- | --- | --- |
| 2048px | 41 / 64 | 6.7 | 15.8 / 45 KB/s | 100% | 109ms |
| 1024px | 35 / 54 | 17 | 13.8 / 34 KB/s | 100% | 111ms |

- Ownership handoffs settle at about 0.1 per NPC per second.
- About 5% of NPCs are momentarily unowned (handoffs in flight). Only 1 of 1,377 was still
  unowned 6 seconds later.
- NPCs survived the abrupt churn: survivors made 1,216 orphan claims and resolved 837 conflicts.
- Smaller zones mean fewer connections but more rooms, and each room is a signalling
  subscription. Tune `zoneSize` to how densely your players gather.

Numbers come from a simulation, not real browsers, and the engine is not tuned yet.

---

## Limits and trade-offs

- **Trust:** owners are authoritative for what they own, and there is no cheat prevention. Fine
  for friends and casual sandboxes; competitive games need validation or a referee peer.
- **Density:** zones cap connections by area, not by crowding. If 100 players stand in one spot
  they will still try to fully mesh; browsers typically handle a few dozen WebRTC connections.
  Smaller zones help, and a relay/supernode layer would be the next step.
- **Reliable channels:** Trystero exposes ordered, reliable data channels. The delta scheme
  relies on that, but it means head-of-line blocking under packet loss.
- **Discovery is local:** you only meet players in zones you enter. The demo spawns everyone
  downtown so they find each other.
- **No persistence:** the world exists where players are; unobserved areas unload.
- Some networks need a TURN server (`TrysteroTransport({ turnConfig })`).
