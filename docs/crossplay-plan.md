# Extreme crossplay plan

Status: phase 1 done (2026-09-15): input and presentation are split from the rules into per-platform
frontends. Priorities below were set by the project owner the same day.

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
- **Eventually:** a mobile interface. Keep room for it; don't build its UI yet.
- **Not now:** crossplay fairness (aim assist, per-platform balance, hit validation).

## How it's built

```
 device ──> Frontend.read() ──> intent ──> Role.update() ──> replicated state
 (keyboard/mouse,                (plain data)   (headless)         │
  WebXR, touch)                                     │               ▼
                              role callbacks <──────┘       other peers' views
 camera, HUD, models <── Frontend.present()   (e.g. AvatarBody: moved, placed, hurt, fired)
```

All in `src/fps/`:

- **`role.ts`**: the contracts. A `Role<Intent>` owns the rules and only sees its intent. A
  `Frontend<Intent>` is one platform's take on a role: `read(dt)` turns the device into an intent (every
  simulation step, background tab included), and `present(dt)` draws the result (rendered frames). A
  `Seat` is the local player: a role and its current frontend. A frontend only exists while its platform
  is playing: `seat.use(create)` disposes of the old one, then builds the new one and attaches it to the
  role. So a frontend may add models to the rig when it's built, but `dispose()` must take every one back
  out (`tests/presentation.test.ts`).
- **`platform.ts`**: `Platform` (desktop, vr, touch), replicated as `Player.platform` so peers can draw
  device cues. Headset players' empty hands are drawn tracked.
- **The avatar role**
  - `intent.ts`: `AvatarIntent`. A head is either tracked (`head`: room-scale, the device owns where it
    faces) or virtual (`turn`, `lookUp`: the rules own the heading, since cars carry it round). Hands are
    either tracked (`hands`: each fires what it holds, where it points) or a crosshair (`fire`,
    `cycleWeapon`, `selectWeapon`). Movement, run, jump, brake, horn and interact are shared.
  - `avatar.ts`: `AvatarSim`, the rules: walking (including tracked-head room-scale following and eased
    stick locomotion), cars, firing, pickups, wanted level, death and arrest. `AvatarBody` is how it reaches
    back to the device: `moved`, `placed`, `seated`, `hurt`, `fired`, `died`. Combat calls `hurt`,
    `nudge`, `die`, `busted` and `crime` on it.
  - `desktopAvatar.ts`: `DesktopAvatar`. Keys and mouse, crosshair with tracers leaving the gun model
    (`desktopGun.ts`), chase camera, death orbit, DOM HUD, camera shake.
  - `vrAvatar.ts`: `VrAvatar`. Snap turn and seat recentering (device-only, so the rules never see
    them), holsters deciding what each hand holds, play space moved by `AvatarBody` callbacks, seat
    calibration, tint and haptics instead of shake, wrist HUD. Poses come from an `XrPoseSource`:
    `WebXrPoses` (`rig.ts`) or `SimulatedXr` (`xrsim.ts`, `?xrsim`).
- **`Game.ts`** picks a frontend for how the page is being played (a presenting headset, `?xrsim`, or
  desktop) at start and again whenever an XR session starts or ends.
  Only the global debug keys (`` ` ``, N) are read outside a frontend.
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

## Adding a platform to a role (e.g. touch for the avatar)

1. Write a frontend implementing `AvatarFrontend`, with `platform = Platform.Touch`.
2. `read`: drags become `turn` / `lookUp` (virtual head), a virtual stick becomes `strafe` / `forward`,
   buttons become `fire`, `jump`, `interact`, `selectWeapon`; `hands` stays null (crosshair).
3. `present`: camera (first or third person), a touch HUD, and the `AvatarBody` callbacks it cares about.
4. In `Game`, pick it from the lobby (or a `?touchsim` flag for testing with a mouse).

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

## Later: mobile

- Detection and lobby: "Play on phone" when a coarse pointer or touch is detected.
- Performance budget on a mid-range phone. Likely levers: `renderer.setPixelRatio` cap, fog distance,
  NPC and car counts in `Spawner`, fewer building window meshes, the engine's `interestRadius`.

## Parked: fairness

Not a priority. If mixed-platform combat ever needs it: aim assist in touch frontends (the rules still get
a plain aim), per-platform balance knobs next to `WEAPONS` in `arsenal.ts`, and sanity checks (distance,
line of sight, fire rate) in the victim owner's `Damage` handler in `combat.ts`.

## Open questions for the project owner

- Should a touch avatar be first-person like desktop, or third-person?
- How should an overseer appear to players in the street, and what limits what it can spawn?
- Should desktop movement ease up to speed like VR (currently walk, plus Shift to run)?

## Checklist for new features

- Which roles does it affect? For each platform playing those roles, how is it triggered, and how is it seen?
- Is the replicated state a body or world fact (hand position, what's held), not a control (button pressed)?
- Does device reading stay in a frontend's `read`, drawing in `present`, and device effects go through
  the role's callbacks?
- Is there a headless test for the rules, and was it checked in the browser on desktop and `?xrsim`?
