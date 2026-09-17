# Extreme crossplay plan

Status: phase 1 done (2026-09-15): input and presentation are split from the rules into per-platform
frontends. Priorities below were set by the project owner the same day. The same day a second game, Peer
Wilds (survival, farming and hunting), was built on that structure, and what both games share moved into
`src/crossplay/` (see "Lessons from a second game"), and Peer City got a first touch frontend
(see "Touch, as built").

## Goal

Peer City began as a GTA-style demo. The aim now is a framework for **extreme crossplay**: VR, desktop
and mobile players in the same peer-to-peer world at once, each with an experience designed for their
device rather than a port.

Extreme crossplay doesn't mean everyone plays the same game. Platforms can take **different roles** in
one world: headset and desktop players fight in the streets as avatars while a touch player looks down on
the city RTS-style and spawns NPCs against them, as in Zombie Master. A platform is the device; a role is
what you do in the world. Any role can have frontends for any platforms that suit it.

The rule that makes this possible: **rules and replicated state describe a role's body, intent and world
facts, never one device's controls.** Input and presentation are per-platform layers around a shared core.

## Priorities

- **Now:** a platform-agnostic structure (roles, intents, frontends) that more roles and platforms slot into.
- **Now, first pass:** a mobile interface. Peer City's touch avatar exists; Peer Wilds has none yet, and the
  performance budget below is untouched.
- **Not now:** crossplay fairness (aim assist, per-platform balance, hit validation).

## How it's built

```
 device ──> Frontend.read() ──> intent ──> Role.update() ──> replicated state
 (keyboard/mouse,                (plain data)   (headless)         │
  WebXR, touch)                                     │               ▼
                              role callbacks <──────┘       other peers' views
 camera, HUD, models <── Frontend.present()   (e.g. AvatarBody: moved, placed, hurt, used)
```

Shared pieces are in `src/crossplay/`, Peer City's in `src/fps/` (Peer Wilds' in `src/wilds/`):

- **`crossplay/role.ts`**: the contracts. A `Role<Intent>` owns the rules and only sees its intent. A
  `Frontend<Intent>` is one platform's take on a role: `read(dt)` turns the device into an intent (every
  simulation step, background tab included), and `present(dt)` draws the result (rendered frames). A
  `Seat` is the local player: a role and its current frontend. A frontend only exists while its platform
  is playing: `seat.use(create)` disposes of the old one, then builds the new one and attaches it to the
  role. So a frontend may add models to the rig when it's built, but `dispose()` must take every one back
  out (`tests/presentation.test.ts`).
- **`crossplay/platform.ts`**: `Platform` (desktop, vr, touch), replicated as `Player.platform` so peers can draw
  device cues. Headset players' empty hands are drawn tracked.
- **`crossplay/touch.ts`** and **`crossplay/touchControls.ts`**: the touch device, split so the gestures can
  be tested without a DOM. `TouchInput` is the rules of the thumbs (a floating walk stick, a look drag, a
  tap that fires, named button presses with the same `down` / `pressed` / `endFrame` shape as the keyboard);
  `TouchControls` is the overlay that feeds it pointer events and draws the stick, buttons and tool slots
  (`touch.css`). Game-neutral: a second game gives its own buttons.
- **`crossplay/avatar.ts`**: `Avatar`, what every game's avatar role shares: walking (virtual head, or a
  tracked head followed round the room with stick locomotion eased in), using tools from a crosshair or
  tracked hands, carrying hand poses along by the rules' moves, and `BODY_FIELDS`, the replicated body. A
  game subclasses it, says how the body collides (`move`, `collide`) and where the ground is (`groundAt`),
  and writes its own `update`.
- **Peer City's avatar role**
  - `crossplay/intent.ts` / `fps/intent.ts`: `AvatarIntent`, the body's plus Peer City's driving. A head is either tracked (`head`: room-scale, the device owns where it
    faces) or virtual (`turn`, `lookUp`: the rules own the heading, since cars carry it round). Hands are
    either tracked (`hands`: each uses the tool it holds, where it points) or a crosshair (`trigger`,
    `cycleTool`, `selectTool`). Movement, run, jump, brake, horn and interact are shared.
  - `fps/avatar.ts`: `AvatarSim extends Avatar`, the rules: cars, pickups, wanted level, death and arrest,
    on top of the shared walking and tools (see "Adding a tool").
    `AvatarBody` is how it reaches back to the device: `moved`, `placed`, `seated`, `hurt`, `used`, `died`.
    Combat calls `hurt`,
    `nudge`, `die`, `busted` and `crime` on it.
  - `desktopAvatar.ts`: `DesktopAvatar`. Keys and mouse, crosshair with tracers leaving the tool model
    (`desktopTool.ts`), chase camera, death orbit, DOM HUD, camera shake.
  - `touchAvatar.ts`: `TouchAvatar`. Thumbs, the same crosshair and first-person tool model the desktop
    uses, contextual buttons, a tool strip instead of the number keys, and a chase camera while driving.
  - `vrAvatar.ts`: `VrAvatar`. Snap turn and seat recentering (device-only, so the rules never see
    them), holsters deciding what each hand holds, play space moved by `AvatarBody` callbacks, seat
    calibration, tint and haptics instead of shake, wrist HUD. Poses come from an `XrPoseSource`:
    `WebXrPoses` (`rig.ts`) or `SimulatedXr` (`xrsim.ts`, `?xrsim`).
- **`Game.ts`** gives `Shell.seat` (`crossplay/shell.ts`) a way to build each platform's frontend, and the shell
  picks one for how the page is being played (a presenting headset, `?xrsim`, touch or desktop) at start and
  again whenever an XR session starts or ends. Only the shell's global keys (`` ` ``, N, and on desktop Esc and
  V) are read outside a frontend, and touch has no keyboard to press them with.
- **`GameContext`** has no device in it. `Hud` is the shared status and announcement model; each frontend
  presents it (`Hud.showAvatar` formats status for a platform's button name).

Things that aren't obvious from the types:

- A frontend reads hand poses before the rules run, but the rules can move the avatar in the same frame (a
  wall holding the head back, stick locomotion). `AvatarSim` carries hand poses along by those moves, and
  ignores them for one frame after `placed`, which isn't a plain shift.
- `AvatarSim` switches a virtual head back to the avatar's last `yaw` when a tracked head goes away, so
  taking a headset off keeps you facing the same way.
- Tests: `tests/avatar.test.ts` drives `AvatarSim` with intents and a recording `AvatarBody`, over an
  in-memory world with no DOM or WebGL.

## Adding a platform to a role

What Peer City's touch avatar did, which is the shape any new platform follows:

1. Write a frontend implementing `AvatarFrontend`, with its own `Platform`.
2. `read`: turn the device into the intent. Touch: the look drag becomes `turn` / `lookUp` (a virtual
   head), the stick `strafe` / `forward` / `run`, buttons `trigger`, `jump`, `brake`, `interact`,
   `crouch` and `selectTool`; `hands` stays null (a crosshair).
3. `present`: the camera, the HUD the way that device needs it, and the `AvatarBody` callbacks it cares
   about (touch buzzes with `navigator.vibrate` where the desktop shakes the camera).
4. In `Game`, add it to the frontends passed to `shell.seat`. Touch is chosen by `isTouchDevice()` in the lobby
   (`crossplay/lobby.ts`, for games that pass `touch: true`), and `?touch` / `?desktop` force either one, which
   is how it's tested with a mouse.

## Touch, as built

The controls are the ones every touch shooter converges on, and they answered the open question below:
a touch avatar is **first person**, the same crosshair the desktop aims with, because a phone's screen is
small enough already. Driving is the exception and defaults to the chase camera.

- Left thumb walks, wherever it lands, and running is the stick pushed to the edge rather than a button.
- Right thumb looks. A quick tap that barely moved fires, so a second finger shoots without moving the aim;
  `FIRE` is held down for automatic weapons.
- The buttons say what they do here and now: `USE` becomes `EXIT`, `JUMP` becomes `BRAKE`, and `CAM` and
  `HORN` only appear in a car.
- The number keys become a strip of the tools you carry (`Inventory.toHand()`), up the right edge.
- There's no keyboard for the global keys, so the settings menu and the microphone are chips the frontend
  calls `Game` back through.
- The HUD moves out of the thumbs' way with `body.touch` rules in each game's stylesheet.

Still to do for mobile: a Peer Wilds touch frontend, the performance budget below, and deciding whether
touch wants any of the fairness levers (it currently aims with no help at all).

## Adding a role (e.g. an overseer on touch)

Peer Haunt built one (see "Lessons from a sixth game"): `src/haunt/haunt.ts` is the role, `hauntDesktop.ts`,
`hauntTouch.ts` and `hauntVr.ts` its frontends. The steps it took:

1. An intent: plain data such as a pan and zoom, a selection, and "spawn this kind of NPC here".
2. A `Role` for its rules. It owns `world.setFocus` (the area it's looking at) and can spawn and own NPCs
   with the engine as it is. It has no `Player`, so decide how others see it (e.g. a replicated overseer
   entity with a cursor) and what it may spawn and where.
3. Frontends for the platforms that suit it: touch first, a desktop one is handy for testing.
4. What still assumes an avatar and would need to change:
   - `Game` builds a `Seat` for the avatar only. The lobby needs to pick a role, then a frontend for that
     role and platform.
   - `Spawner` (`spawner.ts`) does nothing without `ctx.me`; it should populate around the local focus.
   - `registerCombat` takes an `AvatarSim`; its avatar handlers only apply when there's a local avatar.
   - `registerViews` needs a `LocalView`; an overseer's is "never show self, no steering wheel".

## Adding a tool

Tools are what an avatar carries and holds: guns, axes, bows, seeds, food, and anything else a game needs.

- `crossplay/tool.ts`: `Tool<Avatar>`, one object per kind, and `Toolbox`, a game's kinds in slot order. A tool's id, which is
  what `tool` / `ltool` and pickups replicate, is its place in the toolbox.
- `crossplay/inventory.ts`: what an avatar carries. Issued tools (the pistols, the axe) can't be lost and never run out;
  others go up to `max` of a kind, sharing their `charges`. Consumables are tools whose charges are the
  things themselves (arrows, seeds, logs, carrots), with `selectOnPickup: false` so gathering doesn't
  switch the crosshair's tool.
- `crossplay/heldTool.ts` runs each hand's hooks.
- Each game has a base tool class saying what picking one up and dropping one does in its world: `fps/tool.ts`
  (a `Pickup`) and `wilds/kit.ts`' `WildTool` (an `Item`). `fps/gun.ts` is `Gun`, `fps/arsenal.ts` Peer City's
  toolbox, `wilds/kit.ts` Peer Wilds'.

1. Subclass `Tool` (or `Gun`) and override the hooks you need. They run in the rules, on the avatar's
   owner, the same on every platform and headless in tests:
   - `onPickup(avatar, got)` and `onDrop(avatar, drop)`: into and out of the inventory. `drop.reason` is
     `dropped` (by default that leaves a pickup), `lost` (death or arrest) or `spent` (charges ran out).
   - `onEquip(hand)` and `onUnequip(hand)`: into and out of a hand, by grabbing from a holster or selecting.
   - `onUse(hand)` when the trigger's pulled, and again every `cooldownMs` while it's held if `automatic`;
     `onRelease(hand)`; `onHold(hand, dt)` every frame.
   - `hand` is a `ToolUse`: `side` (null for the crosshair), `origin` and `aim` to act from, `tip` for
     effects, `velocity` (a tracked hand swinging it), `tool`, `pressedAt`, `spend(n)`, and
     `effect({ kick, hit })`, which reaches the frontend as `AvatarBody.used` for recoil, haptics and hit
     markers. `avatar.hand(side)` is the other hand, for two-handed tools like the bow.
   - A tool can be richer in tracked hands without the rules reading a device: work from the body facts
     (`side`, `origin`, `velocity`, the other hand). Peer Wilds' axe chops when its head moves into bark
     fast, food is eaten at the mouth, and the crosshair versions are simpler paths in the same hooks.
   - Every hand holding a kind shares its one tool object, so keep per-hand state in a `WeakMap` keyed by
     the `ToolUse`.
2. Say how it looks and sits in the hand:
   - `model`: an `asset`, or `build()` for geometry made in code; `orient` turns it so its tip points down
     -Z, and it's scaled to `length`.
   - `grip.tip`: where the tip is from where the hand holds it, in meters (+X right, +Y up, -Z forward).
     The model's front face is centred on it.
   - `grip.pitch`, `yaw` and `roll`: the angle it's held at. The rules aim from the same tip and direction the
     frontends draw, and others see it held at that angle too.
   - `stash`: where the first, second... of the kind go on a headset player's body.
3. Add it to the `Toolbox` in `arsenal.ts`. That changes ids, so every peer needs the same build.
4. Change the world the usual way from hooks (spawn entities, send actions, write the avatar's state). If a
   tool needs to show more than recoil and hit markers on the device, add to `UseEffect` and handle it in
   each frontend's `used`.

## Lessons from a second game

Peer Wilds (`src/wilds/`, `/wilds.html`) is survival, farming and hunting on a seeded island. Building it
on Peer City 3D's structure showed what was general and what wasn't.

What carried over unchanged: roles, frontends and the seat; the rig, `?xrsim`, holsters and torso; tools,
inventory and held-tool hooks; the engine's ownership-as-lock, owner-routed actions and spawner pattern.

What had to be pulled apart (now `src/crossplay/`):

- `AvatarSim` mixed the body with cars and police. The body is `Avatar`; games add rules on top.
- `Tool` assumed Peer City's avatar and `Pickup`. It's generic over the avatar now, and each game has its
  own base tool for pickup and drop.
- The ground was flat. `Avatar.groundAt` lets feet, eyes and hand heights sit on terrain; a headset
  frontend eases the play space's floor over the ground under the avatar.
- Tools needed more from a tracked hand: its `velocity`, the other hand, and an empty hand reaching for
  something in the world (`HandIntent.grab`, from `Holsters.grabbing`).
- The renderer and loop (`Stage`), models of people and tools, drawing another player's replicated body,
  particles, spatial audio and headset panels were already game-neutral; they just lived in `src/fps/`.
- A hand's cooldown survived switching tools; now it's reset when the tool changes.

Patterns worth reusing:

- **Sparse state over a seeded world**: only changes (felled trees as `Stump`s) are entities.
- **Wall-clock time** for the day and for long-lived timestamps: no owner, nothing to tick or send.
- **Projectiles as actions**: the shooter's peer flies them and decides hits; others fly a copy to watch.

Open questions for the project owner:

- **Persistence.** Plots, stumps and fires live while someone is nearby, then unload with the area. Should
  a farm outlast everyone leaving (e.g. each player saving what they built, restored when they return)?
- **Putting things in hands.** The device decides what a hand holds (holsters), so a pulled carrot goes to
  your belt rather than into the hand that pulled it. Should rules be able to hand a tracked hand a tool?
- **Desktop tool views.** Desktop frontends scale long tools to fit the view per game. Should `Tool` say how
  it's shown first person on a crosshair?

## Lessons from a third game

Peer Derby (`src/derby/`, `/derby.html`, 2026-09-16) is building downhill racers together in a garage and racing
them. It was the first game to need real physics, and the first where a player's role changes mid-game.

What carried over unchanged: `Avatar` for walking the garage, tools and holsters for the part gun and wrench (both
hands, a laser to aim with), `Seat` and frontends, `Stage`, voice and settings, `DesktopTool`, panels.

What the engine and crossplay layer didn't have, and what was done about it:

- **Blobs.** A racer's design is structured, changes rarely and is edited by several people. The engine gained
  `t.bytes(max)`, diffed by contents. Worth considering: a first-class quaternion field. For now a rotation is four
  `t.fixed` fields, with the owner keeping the sign continuous and readers normalizing.
- **Physics as a per-peer service.** Each peer runs its own Rapier world; owned bodies are dynamic, everyone
  else's are kinematic stand-ins following render state (`RacerProxies`). That pattern, plus fixed-step
  accumulation and "debris only collides with the world", is game-neutral and could move to `crossplay/` when a
  second game wants physics.
- **A role that changes what it is.** The builder is an avatar in the garage and a driver in the race. Rather than
  swapping roles in the `Seat` (which still assumes one role), one role holds both and the intent carries both
  sets of fields (walk and tools, steer and boost). Frontends switch presentation on `builder.seated`, and the
  body gained `seated`, `countdown`, `crashed` and `finished` callbacks. If more games do this, `Seat` could swap
  roles, and intents could be split per mode.
- **Seated VR.** `Rig.seatIn` from Peer City's cars was enough: it follows the racer's heading only, never its
  pitch or roll, which is kinder to stomachs.
- **Coordination without a start signal.** A migratable `Race` entity holds the phase and a timer; its owner runs
  it, and each racer's owner acts on the phase it sees. A lost message can't leave anyone on the grid, and the
  race survives its owner leaving. Duplicates from two peers creating one at once are resolved by lowest id.
- **The whole map is one neighbourhood.** Racers spread over a kilometre but everyone needs everyone's
  standings, so the world uses one big zone and a large interest radius. Fine for a group of friends; many
  racers would want a lighter "standings" channel than full entity replication.
- **Headless physics tests are cheap.** A steering bot runs a full race in about a second in vitest, which is how
  the course and part strengths were tuned (the jumps originally ended in cliffs that smashed every cart).

Decided by the project owner (2026-09-16):

- **A good phone version.** Touch should be a first-class way to play the derby, not a port: think outside the box
  if the desktop controls don't suit thumbs (tap a face to build, tilt or thumb controls to drive, whatever
  works best). A good phone version is the ideal for every game, but some games are weird enough that a phone
  can't do them full justice; then make the best one the game allows. Built as `derby/touch.ts` (below).
- **Physics is trusted.** Owners simulate their own racers unchecked, and that's fine; no validation needed.
- **Designs outlive the session.** First save and load them (locally), then share them (e.g. as codes). Saving and
  loading are built (below); codes aren't.

### Derby design shelves, as built

- **Diegetic, so every platform gets it for free.** Each bay has a shelf (`derby/shelf.ts` for the layout, picking and
  storage, `shelfView.ts` for drawing): a SAVE plaque over each of four cubbies, and a turning model of the design
  saved in each. The part gun and wrench press them, from a crosshair, a tap, or a tracked hand's laser, because
  `aimBuild` picks the nearer of a racer's part and a shelf button. No platform had to change.
- **Storage is a service in the context** (`DesignShelf`: `LocalShelf` in the browser, `MemoryShelf` in tests), like
  settings: the rules save through it and never see `localStorage`. It also keeps the racer as last built, which
  `Builder.spawn` restores.
- **Saves replicate on the builder** (`save0`..`save3`, `t.bytes`), so friends see your models and can copy one onto
  their own racer: a first, in-world kind of sharing. Only the owner can save on a shelf.
- **Losing work takes two presses**: saving over a design, and loading over a racer that isn't saved anywhere.
- Touch taps in the walking thumb's corner now count too (`TouchTuning.stickTaps`), since the lower cubbies (and
  low racer parts) sit right there on screen.

### Derby on touch, as built

- **Building is touching the racer.** A tap in the look zone sticks the loaded part on the face under the finger (or
  the wrench takes that part off), so aiming is pointing at the screen, not dragging a crosshair onto a face. The
  intent gained `aim`, a direction to use the crosshair tool along instead of through the middle of the view, and
  `TouchInput.tapAt` says where the tap was; the frontend unprojects it through the camera the frame was drawn
  with. STICK still uses the crosshair, for faces too small for a fingertip. The preview ghost stays on the
  crosshair, since a finger has no hover.
- The parts and wrench are the tool strip, in two columns; the HUD's key list and parts list hide on touch.
- **Racing:** the left thumb's stick steers on its x axis only; ROCKETS (only with rockets built), BRAKE and PUSH are
  held; RESET, and chips for CAM, TILT and QUIT (pressed twice, like Q). Dragging looks round the racer, the same
  `ChaseCamera` (`derby/chase.ts`) the desktop uses.
- **Tilt** (`crossplay/tilt.ts`) is opt-in: it turns `deviceorientation`'s angles into which way is up on the screen,
  allowing for the screen's rotation, so it doesn't jump when a landscape phone passes vertical, and adds to the
  thumb's steering. iOS only grants it from a tap, hence a chip. The sign conventions are tested headless, but
  **tilt hasn't been tried on a real phone yet**.
- Starting on a phone asks for fullscreen and a landscape lock (Android; iOS ignores both). Portrait still works.

## Lessons from a fourth game

Peer Walls (`src/walls/`, `/walls.html`, 2026-09-16) is painting a yard of walls together with spray cans, markers and
rollers. It's the first game whose world is mostly something the players make, and the first with no goal.

What carried over unchanged: `Avatar`, tools and holsters (a can on the hip is a gun on the hip), `Seat` and frontends,
`Stage`, voice and settings, `DesktopTool`, panels, particles.

What was new:

- **Dense, shared, player-made state that isn't entities.** Walls are pixels every peer keeps, and paint is an action
  stream everyone applies deterministically. The engine needed nothing new for that; the hard part was someone arriving
  late, solved in the game (`sync.ts`): a copy of the walls taken at one moment with each painter's last stroke number in
  it, strokes kept while it comes, and the unseen ones repainted on top. If another game needs a shared canvas, a voxel
  world or a terrain people dig, that pattern (and `WallSync` generalised over "a state and a stroke") could move to
  `crossplay/`.
- **Convergence without a server** is an id and a birth time on each copy: the older one wins when two meet.
- **Persistence, for the first time**, answering Peer Wilds' open question for this game: the walls are kept in the
  browser (IndexedDB) and a lone painter starts from them. Nothing arbitrates between two browsers' saves beyond "older
  walls win" when they meet.
- **Rules own distance, not the device.** A spray is wider and fainter further from the wall on every platform: a tracked
  hand measures from its nozzle, a crosshair from an arm's length in front of the eyes (`kit.ts`'s `ARM`).
- **Touch acts where a finger is, continuously.** `TouchInput.lookFinger` (new) gives the look-zone finger's position
  every frame, not only a tap, so DRAW paints wherever the finger is on the wall. Looking round needs DRAW turned off:
  a phone has one surface for both.

## Lessons from a fifth game

Peer Golf (`src/golf/`, `/golf.html`, 2026-09-16) is battle golf: everyone plays the same hole at once, clubs each other
and fights over a few carts. It's the second game with rigid bodies and the first with vehicles shared by everyone.

What carried over unchanged: `Avatar`, tools and holsters (clubs hang on the hips), `Seat` and frontends, `Stage`, voice
and settings, `HeadsetHud`, the minimap, touch controls, particles, `Singleton` for the match.

What was new, or moved:

- **Rigid-body helpers moved to `crossplay/rigid.ts`** from Peer Derby: loading Rapier, quaternions in world axes and in
  the scene, replicated rotations, collision groups and fixed steps. Both games now use them.
- **Not everything physical belongs in the physics engine.** A golf ball is small, fast and all about the ground it lands
  on, so its owner simulates it on its own (`ball.ts`) and only carts are Rapier bodies. The same test applies to anything
  whose behaviour is mostly "what kind of surface is this".
- **Entities that change hands because a player asked.** Until now ownership moved when an owner left. Carts move to
  whoever gets in (`requestOwnership`, with a transfer policy that refuses a cart someone's driving), and the rules wait
  a frame or two for the handover rather than acting on a promise.
- **A device can measure a use itself.** The crosshair's swing meter lives in the rules, but a touch player pulls a finger
  back, so `GolfIntent.power` carries the device's own measure when it has one. Other games with charged uses (a bow, a
  throw) could use the same shape.
- **A screen camera that changes with what you're doing** (`golf/camera.ts`): eyes, behind the ball, following the ball,
  chasing the cart, over yourself knocked down, with `showSelf` answered from the camera. If a third game needs one, the
  easing and the mode switch could move to `crossplay/`.
- **Tab** is now kept from the browser by `DesktopInput`, for holding a scorecard open.

Open questions:

- The tracked swing's power (each club's `smash`) is a guess that hasn't been tried in a real headset.
- Whether players between holes want something to do. (A cart for every two golfers was too few: now there's one each.)

## Lessons from a sixth game

Peer Haunt (`src/haunt/`, `/haunt.html`, 2026-09-16) is asymmetric horror: survivors (avatars) search a manor at night by
flashlight for the keys to the gate, while the Haunt, an overseer with no body, looks down on the house and sends monsters
after them. It's the first game where players in one world take different roles, which this plan set out as the goal of
extreme crossplay from the start.

What carried over unchanged: `Avatar`, tools and holsters (the flashlight clips to your chest), `Seat` and frontends,
`Stage`, voice and settings, `HeadsetHud`, touch controls, particles, `Singleton` for the night.

What was new, or changed:

- **Roles in the lobby.** `LobbyOptions.roles` reads the page's `input[name="role"]` radio buttons into `Launch.role`
  (remembered, `?role=` picks one, `<body data-role>` follows it for CSS). `Game` seats one role or the other; `Seat` and
  `Shell.seat` needed nothing new, because each is already generic over its role.
- **An overseer role isn't an avatar.** `HauntIntent` is device-neutral: a focus (what it's looking at, which drives
  `world.setFocus`), a pointer on the ground, how near counts as "on something" (a fingertip covers more ground than a mouse),
  and a few acts there: primary (use the armed power, else pick out a monster, else send the picked-out ones), secondary,
  arm a power, gather, select by ids, select all. Every platform does those differently and the rules never know which.
- **A free pointer.** `DesktopInput.setCapture(false)` leaves the mouse free, with `pointer` and `downAt(button)` for where
  it is and where a drag began, and clicks go through without asking for pointer lock. A `Frontend` that says `cursor: true`
  gets that from the shell, which also stops showing it the click-to-play prompt.
- **An overhead camera and map gestures** in `crossplay/`: `OverheadView` (pan, zoom and turn holding the ground under the
  pointer; screen to ground and back, headless, tested) and `MapGestures` (drag, pinch, twist, tap, long press). Both are
  game-neutral, for the next game with a map-like role.
- **VR overseer: a giant.** Rather than a miniature table, the play space is lifted 20 m over the house. Nothing had to
  change in `Rig`: the root's height is the frontend's, and a laser from the right hand finds the ground.
- **Voices from a presence.** `ShellOptions.speakers` lets a game say where voices come from, so the Haunt's voice plays
  from where it's pointing, and its listener sits where it's looking.
- **Headset hints fit the strip.** `HeadsetHud` shrinks a long hint rather than cutting it off.

Answers to the questions this section's predecessors left open, as built:

- **How an overseer appears to players:** as a *presence* where it points, a knot of darkness with two dim eyes, for a
  few seconds after it last acts. Survivors can fight it: a flashlight on the presence drives it back, costs it dread and
  stops it acting for a moment. Its voice comes from there too.
- **What limits what it can spawn:** dread, which builds through the night faster with more survivors inside and is
  shared by everyone playing the Haunt; a cap on monsters for the number of survivors; and *where*: inside the grounds,
  away from the pedestal, never within 7 m of a survivor or anywhere one can see.

Patterns worth reusing:

- **Held NPCs for a commander.** Monsters are spawned `held` by the Haunt's peer, so orders go straight to the peer that
  runs them and never chase a handoff; if the Haunt leaves, they migrate like any NPC and become the house's.
- **Hidden information as a view.** Haunt first hid survivors in the dark from the overseer until they gave themselves
  away, worked out on its peer from replicated state (`src/haunt/sightings.ts` in c999c04, since removed). Without a
  server that's a view, not a secret. Worth reviving for a stealth game.
- **A grid world for indoor play.** Seeded BSP rooms with a doorway in every split, loops, and furniture only where the
  floor stays connected; circle collision, line of sight and shared BFS distance fields on the same grid. Cheap enough
  that monsters re-path several times a second.
- **Darkness is a fixed light budget.** Four spotlights are shared out among the nearest flashlight beams every frame (a
  fixed count, so shaders never recompile), fog does the rest, and the overseer's peer lights the same scene brightly with
  ceilings hidden and walls cut to a dollhouse height.

Open questions:

- In the built-in browser pane two tabs each with a WebGL context lost them both, so the two roles were checked one tab at
  a time (with a stand-in survivor spawned from the console). Worth a real two-browser session, and a real phone and headset.
- Balance is guessed: dread rates, monster costs and speeds, battery drain, and the monster cap. Playtesting will say.
- Dead survivors only spectate. They could come back as something for the Haunt (a poltergeist role), which the role
  structure would take without changes.

## Lessons from a seventh game

Peer Shinobi (`src/shinobi/`, `/shinobi.html`, 2026-09-16) is a stealth game with two roles: shinobi (avatars) climb a
castle at night to kill its lord, and the Captain of the Watch (an overseer) commands the guards from a map. The owner
asked for throwing weapons, climbing, stealth, and an asymmetric head of security with a limited view who sends guards to
places, and left how to make that last one fun open.

What carried over unchanged: `Avatar`, tools, holsters and `DesktopTool`, `Seat`, `Shell` and frontends, `OverheadView`
and `MapGestures` for the overseer, `HeadsetHud`, touch controls, particles, `Singleton` for the night. The captain's three
frontends are close cousins of the Haunt's.

What was new, or changed:

- **A 2.5D world.** Every grid cell has a height, and collision takes the feet's height: a body walks over what's within a
  step and bumps into the rest. Rules own the vertical (`feet`, gravity, landing) and replicate it in the body's `z`. For a
  headset the frontend lifts the play space to the feet every frame, so standing on a roof puts your real floor there.
- **Climbing, two ways.** A virtual head holds `climb` facing a climbable face and goes up, along or over it. Tracked hands
  climb hand over hand with `crossplay/climb.ts`'s `HandClimb`: an empty gripping hand anchors where it took hold, the body
  moves so it stays put, and `slip` absorbs what walls and the ground didn't allow. It sits in the rules (it only reads
  `HandIntent`s), so it's headless and tested.
- **`Avatar.step` is protected**, so a game can write its own virtual-head walking (here: climbing and falling off edges)
  and still use the avatar's tools, hands and tracked-head following.
- **Thrown tools.** A `Tool`'s hooks already had what throwing needs: on a crosshair `onUse` throws along the aim; in a
  tracked hand `onHold` samples `ToolUse.velocity` while the trigger's held and `onRelease` throws the fastest recent sample
  (blended a little toward where the blade points). Flights are local projectiles copied to near peers (as Wilds' arrows),
  and a blade that lands becomes a migratable pickup.

How the overseer was made interesting without seeing everything:

- **The captain knows what the guards know.** Sightings (a guard's `spotting` of a shinobi, worked out from replicated
  state), noises (only if a living guard was within earshot) and deaths (only once a body's found, or a guard misses his
  check-in). This revives Haunt's removed "hidden information as a view", and it makes guard placement matter twice: a
  guard is both a defence and a sensor.
- **Orders spend attention and coverage, not currency.** Sending a guard to search leaves a gap on his route. The four calls
  (braziers, alarm bell, reinforcements, move the lord) have cooldowns rather than a shared resource, so the decision is
  when, and moving the lord doubles as bait.
- **Guards act on their own.** Suspicion, investigation, alarms and chases need no captain, so the game plays without one
  and the captain directs rather than micromanages.

Open questions:

- Balance is guessed: sight ranges, suspicion rates, exposure factors, how lethal the tanto and kunai are, archer accuracy
  and the call cooldowns. A real match between a captain and two or three shinobi will say.
- Checked in the browser pane one role per tab (a console-spawned stand-in shinobi for the captain), on desktop, `?touch`
  and `?xrsim` (hand-over-hand climbing works with the simulator's limited reach). Not tried on a phone or a headset, and
  real VR throwing feel is untested.
- Ideas that fit the structure without framework changes: carrying bodies into bushes, smoke bombs, guard dogs, a
  poltergeist-style role for taken shinobi (a guard's eyes for the captain?), and captain voice lines to nearby guards.

## Lessons from an eighth game

Peer Starship (`src/starship/`, `/starship.html`, 2026-09-17) is a bridge crew game. The owner asked for a "ship's viewer"
role, touch "station interfaces" so a phone becomes a station (with switching between stations when the crew is small),
and in-between roles for VR and desktop, including away missions.

What carried over unchanged: `Avatar`, tools and holsters (phaser, spanner, extinguisher), `Seat`, `Shell` and frontends,
`HeadsetHud`, touch controls, particles, `Singleton` for the ship.

What was new, or changed:

- **A role with no world view at all.** A station is a DOM panel (`stations.ts`) and draws nothing in 3D, so a phone at a
  station skips rendering. Frontends say what they draw each frame (`view.ts`'s `Drawn`: space, a deck through a camera, or
  nothing), and `Stage.render` (new) lets the game draw its own passes instead of one scene through the rig's camera.
- **Two scenes, two unit systems.** Space (u, ~100 m each) and the decks (meters) are separate three.js scenes over one
  replicated world. The bridge's viewscreen is a render target of the space scene; a crew member sees it on the wall, and
  the viewscreen role draws the same camera full screen. The away sites sit far apart on the deck grid, and only the area the
  camera is in is drawn (every deck view sits in a holder toggled by area).
- **The same panel for three kinds of player.** A phone at a station, a desktop at a station and a crew member sitting at a
  bridge console all use `StationPanel`, which only reads replicated state and gives `ConsoleAct`s. The officer role and the
  crew role both turn those into `Console` commands to the ship's owner.
- **Wide entities.** The ship has 46 replicated fields; schemas were capped at 30 because masks used 32-bit bit operations.
  Masks are plain numbers now (up to 52 fields), tested and set arithmetically past the 31st, with the same wire format.
- **Ownership settling in tests.** Rules tests that write the ship's state directly wait for the singleton's owner to settle
  (a rebalance can hand it over a few seconds in), or the write is lost with the handoff.

Open questions:

- Balance is guessed: raider waves, weapon damage, drone lethality, power effects and repair times. A real crew will say.
- VR crew can't use bridge consoles yet (the panel is DOM); a painted, touchable panel like `VrSettings` would do it.
- Checked in the browser pane one role per tab (viewer, each station on desktop and phone sizes, desktop crew aboard and on
  a planet, `?xrsim` crew, touch crew), with stand-ins spawned from the console. Not tried with several real devices at once.

## Later: mobile

- Detection is done (`isTouchDevice()`), and the lobby's PLAY starts the touch frontend on a phone. The lobby can also
  offer a choice of role (`LobbyOptions.roles`), which Peer Haunt uses.
- Performance budget on a mid-range phone, untouched so far. Likely levers: `renderer.setPixelRatio` cap,
  fog distance, NPC and car counts in `Spawner`, fewer building window meshes, the engine's
  `interestRadius`. Nothing here has been measured on real hardware yet.

## Parked: fairness

Not a priority. If mixed-platform combat ever needs it: aim assist in touch frontends (the rules still get
a plain aim), per-platform balance knobs on the tools in `arsenal.ts`, and sanity checks (distance,
line of sight, fire rate) in the victim owner's `Damage` handler in `combat.ts`.

## Open questions for the project owner

- Should desktop movement ease up to speed like VR (currently walk, plus Shift to run)?

## Checklist for new features

- Which roles does it affect? For each platform playing those roles, how is it triggered, and how is it seen?
- Is the replicated state a body or world fact (hand position, what's held), not a control (button pressed)?
- Does device reading stay in a frontend's `read`, drawing in `present`, and device effects go through
  the role's callbacks?
- Is there a headless test for the rules, and was it checked in the browser on desktop and `?xrsim`?
