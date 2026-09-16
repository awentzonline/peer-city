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

Implementing `Transport` (join room → peer join/leave, send, receive) is all it takes to add another. A room may also
expose `media` (add/remove a `MediaStream` for one peer, receive theirs), which is what proximity voice rides on;
`TrysteroTransport` has it, and transports without it simply have no voice.

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

## Peer City 3D (first-person + room-scale VR)

`/fps.html` is the same sandbox rebuilt as a first-person shooter in [three.js](https://threejs.org),
playable on desktop or in a WebXR headset (e.g. Meta Quest Browser). It runs on the same engine
and networking: zones, interest management, NPC ownership migration, carjacking via
`requestOwnership`, damage sent to the victim's owner, and police.

```bash
npm run dev    # http://localhost:5173/fps.html
```

**Desktop:** WASD move · mouse look · click shoot · wheel / 1-5 switch gun · Shift run · Space jump / handbrake · **F** enter/exit
car · **Esc** settings · **V** microphone (chase camera while driving) · H horn · `` ` `` net stats · N mute

**VR:** walk around your room for real, or use the left stick. Right stick snap-turns. Squeeze a grip to
grab a gun off your body (pistol on the right hip, SMG on the left, long guns over your shoulders) and
let go against your torso to stash it there; the trigger fires. **A/X** enter/exit a car. Driving: left
stick steers and accelerates, clicking the right stick is the handbrake, **B** horns, **Y** recenters your seat (or opens
the settings panel on foot). Cash, wanted
level, health and the minimap are on your left wrist.

What changes in 3D:

- **Units are meters.** The world is still simulated on the ground plane (`x`, `y`) with height `z`,
  so the 2D AI, traffic and collision code carries over. three.js renders x → X, z → Y, y → Z. The
  engine's distance constants (`spatialCellSize`, `focusResendDistance`, `zoneJoinMargin`,
  `zoneKeepMargin`) are options now, scaled down for a meter-scale world.
- **3D ballistics.** Bullets march the tile grid (`City.raycast3D`) against building heights and the
  ground, then test upright cylinders (people, with headshots) and oriented boxes (cars).
- **Avatars replicate head and hand.** `Player` carries head height, look pitch, and the gun hand's
  position and aim, so you see where VR players point their guns and when they crouch.
- **Room-scale.** The camera and controllers live in a play-space group (`Rig.root`). Your avatar is
  wherever your head is. If walking in your room would put your head inside a wall or car, the play
  space is pushed back instead. Stick locomotion and snap turns move the play space. Sitting in a car
  calibrates your current head pose to the driver's seat, whatever your real height or position.
- **VR comfort:** no camera shake or forced camera motion in a headset. Damage and death tint the view
  instead.
- `?xrsim` emulates a headset on desktop for testing the VR code paths. Mouse moves the head, arrow keys
  walk the room, C crouches, WASD/Q/E are the sticks, mouse buttons the triggers, F = A, R = Y,
  Space/Shift the grips, X the right stick click. Hold G or B to move your right hand to your hip or over
  your shoulder.

- **Model assets.** Most of the world is still built in code, but models can come from asset files.
  Source models (FBX, OBJ or .blend) are converted to GLB with Blender and committed under `assets/`:

  ```bash
  blender -b --factory-startup -P scripts/assets/convert.py -- assets/models/weapons path/to/Pistol_01.fbx
  ```

  `src/crossplay/assets.ts` loads them before the game starts (Peer City lists its files in
  `src/fps/assets.ts`) and bakes their materials into vertex colours, so a model is a single draw call
  with the shared material. The guns come from
  [Zsky's Weapons Pack](https://www.patreon.com/Zsky) (CC BY 4.0).
- **Guns are tools, and tools are pickups.** Everyone starts with a pistol. An SMG, shotgun, assault rifle
  and sniper rifle spawn around the streets (orange on the minimap); walk over one to take it and its
  ammo. A gun is one kind of hand-held `Tool` (`src/crossplay/tool.ts`): a model, a grip (where the tip is and
  the angle it's held at), VR stash spots, charges, and hooks for pickup, drop, equip, use, release and
  hold. `Gun` (`src/fps/gun.ts`) subclasses it, Peer City's tools are listed in `src/fps/arsenal.ts`, and
  "Adding a tool" in [docs/crossplay-plan.md](docs/crossplay-plan.md) walks through making another. The
  tool in each hand replicates (headset players send both tracked hands, desktop players their crosshair
  hand), so others see what you're holding, and it's dropped where you die.
- **Holsters (VR).** Your whole torso is a holster (`src/crossplay/torso.ts`, `src/crossplay/holsters.ts`). Each hand
  grabs its own gun with the grip; let go with your hand on your body and the gun stays frozen there,
  relative to your torso, until you take it again. Let go anywhere else and it returns to its last spot.
  There's no body tracking, so the torso hangs below your head and only turns once you look well to
  one side. You can carry two of each gun, one for each hand, sharing their ammo; you start with a
  pistol on each hip. Stick locomotion has one fast top speed that takes about half a second to reach.

- **Platforms and roles.** The rules never read a device. `AvatarSim` (`src/fps/avatar.ts`) plays the
  avatar from a plain `AvatarIntent` and runs headless in tests. Per-platform frontends (`DesktopAvatar`,
  `VrAvatar`) read devices into that intent, draw the result, and handle the rules' callbacks, like
  pushing a VR play space back from a wall. Other roles (say, a touch player directing NPCs from above)
  plug into the same `Role` / `Frontend` contracts in `src/crossplay/role.ts`.

Source: `src/fps/`, on the shared crossplay layer in `src/crossplay/` (below). Where it's heading, VR,
desktop and mobile players each getting their own experience, and sometimes their own role, in the same
world: [docs/crossplay-plan.md](docs/crossplay-plan.md).

---

## The crossplay layer (`src/crossplay/`)

What a 3D game on the engine needs to be played on desktop and in a headset at once, without being about
any one game. It came out of building a second game (Peer Wilds) on what Peer City 3D had:

| Module | What it is |
| --- | --- |
| `role.ts`, `platform.ts` | `Role` (a game's rules, fed an intent) and `Frontend` (one platform's input and presentation); the `Seat` swaps frontends when a headset session starts or ends |
| `avatar.ts` | `Avatar`: a body that walks with a virtual head or follows a tracked one round the room (pushing the play space back from walls), and hands that use tools from a crosshair or wherever tracked hands point. `BODY_FIELDS` are its replicated fields, spread into a game's player entity. A game subclasses it and says how the body collides and where the ground is |
| `intent.ts` | `AvatarIntent`, `HandIntent`: what a player wants in terms of the body. Games extend it (Peer City adds driving) |
| `tool.ts`, `heldTool.ts`, `inventory.ts` | hand-held tools with hooks, grips, charges and VR stash spots. Each game has its own base tool saying what picking up and dropping one does in its world |
| `holsters.ts`, `torso.ts` | a headset player's tools, carried on the body and grabbed with the grips |
| `rig.ts`, `xrsim.ts`, `input.ts`, `stage.ts` | the play space and its XR poses (or `?xrsim`'s fake ones), keyboard and mouse, and the renderer and loop that keeps simulating in a background tab |
| `models.ts`, `avatarView.ts`, `desktopTool.ts` | people and tools built from vertex-coloured parts, drawing another player's replicated body and hands, the first-person tool on desktop |
| `voice.ts` | proximity voice chat: your microphone goes to the people near you and their voices play from where they stand |
| `settings.ts`, `settingsMenu.ts`, `settingsPanel.ts` | the in-game settings menu: one set of rows, drawn as a DOM overlay on desktop and as a panel you poke in a headset |
| `particles.ts`, `audio.ts`, `panel.ts`, `assets.ts`, `textures.ts`, `math.ts` | GPU particles, spatial synthesized sound, canvas panels for headset HUDs, GLB loading |

### Proximity voice chat

Both games let you talk to the people standing near you. Press **V** (or turn the microphone on in the settings
menu) and anyone within about 22 meters hears you from where you are: voices go through the same HRTF panners as
the game's sounds, so in a headset someone behind you sounds behind you.

- **Nobody far away receives your audio at all.** Your microphone is added to a peer's connection when they come
  into earshot and taken off it when they leave, rather than being sent to everyone and turned down. Out of range
  means the audio never arrives.
- **It rides on the connections the engine already has.** Voice opens one room per zone room the world is in
  (`world.zoneKeys()`), and Trystero shares one `RTCPeerConnection` per peer across rooms, so the tracks go over
  connections that exist for game state. The peer graph doesn't widen, and the zone hysteresis that stops entity
  churn stops voice churn too. The send window is wider than earshot (1.0–1.9×) because renegotiating a stream
  isn't instant, so walking in and out of range doesn't rattle the connection.
- **The microphone starts off** and nothing asks the browser for it until you turn it on; turning it off stops the
  tracks, so the recording light really goes out. Hearing other people needs no permission at all.
- **Mute is per person**, from the settings menu, and sticks if they wander off and come back.
- Local-tab networks (BroadcastChannel) carry no media, so voice is only there on the online network.

### The settings menu

`settings.ts` holds one list of rows — the microphone, whether you hear others, a row per person nearby with a
talking meter, and the game's sound — with no idea how they're drawn. `settingsMenu.ts` draws them as a DOM
overlay on desktop (**Esc**, which also hands back the mouse), and `settingsPanel.ts` paints the same rows onto a
panel that hangs in front of you in a headset (**Y**), where you put a fingertip on a row and pull the trigger.
A new setting is added once and appears on every platform.

---

## Peer Wilds (survival, farming and hunting)

`/wilds.html` is a third game on the engine: survive on a wild island with other players and no server.
Hunt deer and rabbits with a bow, fell trees for firewood, till the soil and grow carrots, cook meat, and
keep a fire going through the night, when the cold makes you hungry and wolves come out.

```bash
npm run dev    # http://localhost:5173/wilds.html
```

The same tools work on desktop and in a headset, but in VR they're hands-on:

| | Desktop | VR |
| --- | --- | --- |
| Axe | click to chop or strike | swing it into a trunk, an animal or a survivor |
| Bow | hold click to draw, let go | take an arrow from over your shoulder, touch it to the bow, pull the trigger, draw back, let go |
| Hoe | click the ground, or click to strike | chop it down into the soil, or swing it to strike |
| Sneaking | hold **C** to crouch | crouch for real |
| Seeds | click tilled soil | reach down to a plot and pull the trigger |
| Food | click to eat | hold it to your mouth |
| Raw meat | hold click by a fire | hold it over the flames |
| Logs | click the ground (3 build a fire) or a fire | set them on the ground or on a fire |
| Crops | **E** | reach down and squeeze an empty hand on a ripe carrot |
| Pack | **B**, then click to move things | reach behind a shoulder and squeeze; grab what floats out |

**Desktop:** WASD move · mouse look · click use · wheel / 1-9 tool · **B** pack · **E** pull crops · Shift run ·
**C** crouch · Space jump · **Esc** settings · **V** microphone · `` ` `` net stats · N mute. `?hour=21` pins this peer's
time of day, for trying nights.

**The pack.** A kind of tool is either *to hand* — on the number keys, or on your body in a headset — or in your
pack. What you gather (seeds, food, logs) goes into the pack when you pick it up, so the axe, bow, hoe and arrows
stay where you can reach them. It's an organiser, not a limit: stowed kinds still gather charges and are still
lost where you fall. `Inventory` in `src/crossplay/` owns it, so a game that never sets `Tool.stows` sees no change.

Out of arrows? Sneak up and use the axe or hoe. Animals notice you from much nearer when you're crouched, creeping
or still, or behind them, and further off when you run. Striking one before it notices you does triple damage,
enough for the axe to drop a deer in one blow.

How it uses the engine, and what it found:

- **The island is seeded** (`land.ts`): heightmap terrain, lakes, forests and boulders are the same on every
  peer, so none of it is sent. Movement and rays use the ground's height; the crossplay avatar only needed
  to learn where the ground is.
- **Sparse changes to a dense world.** There are thousands of trees and none are entities. Felling one spawns a
  `Stump`; every peer hides the tree while the stump exists, and it grows back when the stump's owner
  despawns it.
- **Time without a server.** The day is the wall clock divided into days (`clock.ts`): nobody owns it or sends
  it. Long-lived timestamps in state (when a crop was sown, when a fire burns out, when a tree was felled)
  are wall-clock seconds, so crops grow on every peer without ticking and survive changing owners.
- **Projectiles, not hit-scan.** An arrow isn't an entity: the shooter's peer flies it under gravity and decides
  what it hits (`arrows.ts`), and a `Loose` action lets everyone nearby fly a copy to watch. Arrows that land
  in the ground often become pickups again.
- **Owners make changes; ownership is the lock.** Sowing and harvesting a plot, and collecting items, take
  ownership first. Butchering a carcass and stoking a fire are actions sent to the owner.
- **Rules own the tool's physics, not the device's.** A tracked hand's tool has a velocity, so an axe chops when
  it's swung into bark fast enough, a hoe tills when it's driven into the ground, and food is eaten when it's
  held at the head's mouth, all worked out in the rules from replicated body facts. The crosshair versions
  are simpler paths through the same hooks.
- **Limit: the world lasts while people are there.** Plots, stumps and fires are migratable, so they outlive
  whoever made them, but when everyone leaves an area they unload like everything else.

Source: `src/wilds/`. Tests: `tests/wilds.test.ts` plays the rules headless: felling a tree with tracked
swings, farming with a crosshair, drawing a bow with two hands, striking survivors and animals with the axe
and hoe, sneaking up on a deer, gathering into the pack, eating and cooking, wolves at night.

---

## Peer Derby (build downhill racers together, then race them)

`/derby.html` is a fourth game on the engine: everyone gets a bay in a garage at the top of a hill, builds a
ridiculous racer out of parts (with their friends' help, if they like), and then races it to the bottom.

```bash
npm run dev    # http://localhost:5173/derby.html
```

**Building.** The part gun sticks the loaded part onto whichever face of a racer's part you point at, and the
wrench takes parts off (with anything only held on by them). Anyone can build on anyone's racer.

| Part | What it does |
| --- | --- |
| Crate | the frame everything's built from |
| Wheel / Big wheel | rolls; wheels in front of the centre of mass steer. Big wheels ride over bumps |
| Rocket | pushes away from the way it points while you boost (six seconds of fuel a race) |
| Wing | lift that grows with speed, and drag against falling flat |
| Balloon | pulls up; pops on anything hard |
| Anvil | 60 kg of keeping low |
| Bumper | bouncy |
| Ski | nearly frictionless: build a sled |

**Racing.** Press ready; the race starts when everyone is, or 25 seconds after the first person is. Racers go to
the grid, count down, and roll. Parts hit hard enough tear off, and so does whatever was only attached through
them. Falling off, flipping or getting stuck puts you back at the last checkpoint, mended.

| | Desktop | VR | Touch |
| --- | --- | --- | --- |
| Build | click with the part gun; **1-9** / wheel pick the part, **X** wrench, **F** ready | grab the part gun (right hip) or wrench (left hip), point, trigger; **A** next part, **X** ready | **tap** a face to build there (or **STICK** for the crosshair); left thumb walks, right looks; parts strip on the right, **READY** |
| Drive | **A D** steer, **W** push off, **S** brake, **Space** rockets, **R** checkpoint, **C** camera | left stick steers, **A** push, left / right trigger brake / rockets, **B** checkpoint, **Y** recentre | left thumb slides to steer (or **TILT**), hold **ROCKETS** / **BRAKE** / **PUSH**, **RESET**, **CAM**, **QUIT** twice |

How it uses the engine, and what it found:

- **Rigid-body physics, one world per peer.** Rapier (`@dimforge/rapier3d-compat`, WASM) runs on every peer over
  the same seeded course. Only the owner simulates its racer, as a dynamic body on raycast wheels; everyone else's
  racer is a kinematic stand-in that follows its replicated pose. Bumping into someone is plausible rather than
  exact, and nobody is in charge of a collision.
- **A design is one replicated blob.** `t.bytes` (new in the engine) carries a racer's parts, 4 bytes each, and a
  bitmask of the parts torn off in this race. Other peers rebuild models and stand-ins when either changes.
- **Edits by cell, sent to the owner.** Helpers send `Edit { racer, cell, face, kind }` to the racer's owner, who
  validates and applies it. Addressing a cell rather than an index keeps concurrent edits from tripping over each
  other.
- **A rotation is a quaternion in four fixed-point fields.** The owner keeps the sign continuous, so linear
  interpolation of the components (normalized on read) never goes the long way round.
- **One migratable `Race` runs the phases.** Its owner decides when to count down, start and finish; each racer's
  owner reacts to the phase it sees (to the grid, go, home), so there's no start signal to lose.
- **Debris is cosmetic.** The owner throws its torn-off parts and sends `Shatter`; everyone else throws copies
  from where they see that racer. Debris collides only with the course and other debris.

Source: `src/derby/`. Tests: `tests/derby.test.ts` builds on someone else's racer across two peers, builds with
tracked hands, runs a race from ready to the go, rolls a starter cart down the whole hill with a steering bot
(no parts lost on the jumps), and smashes a racer into a wall.

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
