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
- **`Game.ts`** picks a frontend for how the page is being played (a presenting headset, `?xrsim`, touch or
  desktop) at start and again whenever an XR session starts or ends.
  Only the global debug keys (`` ` ``, N) are read outside a frontend, and touch has no keyboard to press
  them with.
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
4. In `Game`, pick it. Touch is chosen by `isTouchDevice()` in `main.ts`, and `?touch` / `?desktop` force
   either one, which is how it's tested with a mouse.

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

## Later: mobile

- Detection is done (`isTouchDevice()`), and the lobby's PLAY starts the touch frontend on a phone. A
  lobby that also lets a phone pick a different *role* is still to come.
- Performance budget on a mid-range phone, untouched so far. Likely levers: `renderer.setPixelRatio` cap,
  fog distance, NPC and car counts in `Spawner`, fewer building window meshes, the engine's
  `interestRadius`. Nothing here has been measured on real hardware yet.

## Parked: fairness

Not a priority. If mixed-platform combat ever needs it: aim assist in touch frontends (the rules still get
a plain aim), per-platform balance knobs on the tools in `arsenal.ts`, and sanity checks (distance,
line of sight, fire rate) in the victim owner's `Damage` handler in `combat.ts`.

## Open questions for the project owner

- How should an overseer appear to players in the street, and what limits what it can spawn?
- Should desktop movement ease up to speed like VR (currently walk, plus Shift to run)?

## Checklist for new features

- Which roles does it affect? For each platform playing those roles, how is it triggered, and how is it seen?
- Is the replicated state a body or world fact (hand position, what's held), not a control (button pressed)?
- Does device reading stay in a frontend's `read`, drawing in `present`, and device effects go through
  the role's callbacks?
- Is there a headless test for the rules, and was it checked in the browser on desktop and `?xrsim`?
