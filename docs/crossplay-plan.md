# Extreme crossplay plan

Status: planned, not started (written 2026-09-15, after commit `475a83c` on `weapon-pickups`).

## Goal

Peer City began as a GTA-style demo. The aim now is a framework for **extreme crossplay**: VR, desktop
and mobile players in the same peer-to-peer world at once, each with an experience designed for their
device rather than a port. A VR player draws guns from holsters on their body; a desktop player
mouse-aims; a phone player gets touch controls built for a phone, not a desktop layout with buttons
drawn on top.

The rule that makes this possible: **simulation and replicated state describe the player's body and
intent, never one device's controls.** Input and presentation are per-platform layers around a shared
core.

## Where things stand

Already platform-neutral:

- The engine (`src/engine/`): transports, zones, interest management, ownership, actions. It knows
  nothing about devices.
- Player replication (`src/fps/defs.ts`, `Player`): head (`yaw`, `pitch`, `head`), right hand
  (`hx/hy/hz`, `aimYaw/aimPitch`, `weapon`) and left hand (`lhx/lhy/lhz`, `laimYaw/laimPitch`,
  `lweapon`, 255 = empty). Other peers render that body the same way whatever device sent it
  (`holdGun` in `src/fps/views.ts`).
- Game rules: `Inventory` and weapon stats (`src/fps/arsenal.ts`), bullets (`src/fps/weapons.ts`),
  combat, NPCs, cars, pickups.

Still tied to a platform:

- **`PlayerController` (`src/fps/player.ts`, ~740 lines) mixes input, movement, aiming and firing for
  both desktop and VR**, branching on `rig.xr` throughout: `update` (line ~113), `interactPressed`
  (~174), `walkDesktop` / `walkVR` (~196 / ~215), `drive` (~294), `switchWeapon` / `showWeapon`
  (~359 / ~370), `aimAndFire` (~393), `updateView` (~481), plus `leaveCar`, `nudge` and `teleport`
  moving the VR play space directly. This is the main thing to untangle.
- Input: `DesktopInput` (`src/fps/input.ts`) is passed straight into the controller; VR input lives on
  `Rig`'s `XRHand`s (`src/fps/rig.ts`); `?xrsim` is `Rig.readSim`, which fakes a headset from the
  keyboard.
- Presentation: two HUDs (`Hud` drives the DOM, `VrHud` paints panels in the scene), two sets of
  first-person guns (`Hands` for desktop, `Holsters` + `Torso` for VR), and camera placement split
  between `Rig` and `PlayerController.updateView`.
- `Game` (`src/fps/Game.ts`) wires all of it by hand and switches on `rig.mode`.
- `Player.vr` is a boolean, so there's no room for a third platform.
- Mobile: nothing yet. No touch input, no phone HUD, no performance budget.

## Target design

```
 device ──> InputAdapter ──> PlayerIntent ──> PlayerSim ──> replicated Player state
  (keyboard/mouse,            (shared shape)   (shared)          │
   WebXR, touch)                                    │            ▼
                                                    └──> Embodiment callbacks
                                                         (camera / play space / hands / HUD,
                                                          one Presenter per platform)
```

- **`InputAdapter`** per platform (`DesktopAdapter`, `XrAdapter`, `TouchAdapter`, and `SimXrAdapter`
  replacing `Rig.readSim`). Each frame it produces a `PlayerIntent`. All device reading lives here.
- **`PlayerIntent`**, a plain object with no DOM or three.js types, so the sim can be tested headless.
  A starting sketch:

  ```ts
  interface HandIntent {
    tracked: boolean;          // a real hand pose (VR) rather than a derived gun position
    grip: Vec3;                // world position of the hand/grip
    aim: Vec3;                 // unit direction the hand points
    trigger: boolean;
    squeeze: number;           // 0..1, for holsters
  }
  interface PlayerIntent {
    move: { strafe: number; forward: number; heading: number }; // stick/keys relative to a heading
    look: { heading: number; pitch: number };                   // where the head faces
    head?: Vec3;               // tracked head position (room-scale); absent = eye height above feet
    aimFromEye?: boolean;      // crosshair platforms shoot from the eye through the reticle
    hands: [HandIntent, HandIntent];                            // right, left
    jump: boolean;
    interact: boolean;         // enter/exit car
    switchWeapon: -1 | 0 | 1;
    selectWeapon: number | null;
    drive: { throttle: number; steer: number; handbrake: boolean; horn: boolean };
    recenter: boolean;
  }
  ```

- **`PlayerSim`**: today's `PlayerController` rules with the `rig.xr` branches replaced by intent
  fields: movement (including VR acceleration and room-scale head following), cars, firing per hand,
  pickups, wanted level, death and arrest. It never touches `Rig`, `DesktopInput` or the DOM.
- **`Embodiment`** callbacks for sim effects that a platform has to reflect, e.g. `teleported(x, y)`,
  `pushed(dx, dy)` (knockback or walls pushing a VR play space back), `seated(car)` / `unseated()`,
  `recoil(hand)`. The VR presenter moves the play space; the desktop presenter ignores most of them.
- **`Presenter`** per platform: camera, first-person hands (`Hands`, `Holsters`), HUD (`Hud`, `VrHud`,
  a future `TouchHud`) and comfort rules (no camera shake in VR).
- **Holsters stay VR-only presentation plus VR input**, feeding the shared `Inventory`: `Holsters` turns
  grips into which gun each hand holds, and the sim only sees `hands[i]` holding weapon N.
- Replace `Player.vr: bool` with **`platform: uint8`** (desktop, vr, mobile) so peers can render device
  cues (e.g. a headset on the avatar) and so fairness rules can tell players apart.

## Phase 1: split `PlayerController` (no behavior change)

1. Add `src/fps/intent.ts` with `PlayerIntent`, `HandIntent` and a neutral default.
2. Move desktop reading (`mouseLook`, WASD/Shift/Space, wheel and number keys, F/E, V, H, click) into
   `DesktopAdapter`. Move VR reading (`XRHand` sticks and buttons, head pose, snap turn, `Holsters`
   grip handling) into `XrAdapter`. Turn `Rig.readSim` into `SimXrAdapter` so `?xrsim` stays a drop-in
   headset stand-in.
3. Rename `PlayerController` to `PlayerSim` and make `update(dt, intent)` consume only the intent.
   Replace direct `rig.shift` / `placeHeadAt` / `seatIn` / `leaveSeat` calls with `Embodiment`
   callbacks.
4. Move `updateView` and the HUD calls (`setStatus`, `setHint`, `setWeapon`, hit markers, hurt flash)
   into per-platform presenters. Game code reports events; presenters decide how to show them.
5. `Game` picks an adapter and presenter from the mode (desktop, vr, sim) and swaps them on XR session
   start and end, instead of switching on `rig.mode` inline.
6. Tests: keep the current suite green (`npm test`). Add `PlayerSim` tests that feed intents with no
   DOM or WebGL, e.g. walking into a wall, VR speed ramp, two-handed firing spending shared ammo,
   entering a car.
7. Check `/fps.html` on desktop and with `?xrsim` (G/B reach the hip and shoulder, Space/Shift are
   the grips) before merging.

## Phase 2: mobile prototype

- Detection and lobby: a "Play on phone" path chosen when a coarse pointer or touch is detected, plus
  a `?touchsim` query flag for testing with a mouse.
- `TouchAdapter`: left virtual stick to move, right-side drag to look, fire button, interact/jump
  buttons, weapon wheel or swipe to switch, and driving controls (stick steer, pedals, handbrake).
  Landscape first.
- Aim assist tuned for touch: gentle slowdown and snap toward targets near the reticle. Assist
  happens in the adapter, so the sim still receives a plain aim direction.
- `TouchHud`: large tap targets, safe-area insets, minimap and status laid out for small screens.
- Performance budget: measure on a mid-range phone. Likely levers: `renderer.setPixelRatio` cap, fog
  distance, NPC and car counts in `Spawner`, fewer building window meshes, and the engine's
  `interestRadius`.
- Optional: gyro aiming.

## Phase 3: crossplay fairness and presence

- Replicate `platform`; show device cues on avatars.
- Decide per-platform balance knobs: aim assist strength (touch high, desktop none, VR low or none),
  and whether weapon spread or recoil should differ by platform. Keep them in one table next to
  `WEAPONS` in `arsenal.ts`.
- Hit validation today trusts the shooter (victim owners apply `Damage`). Before mixing platforms with
  different aim quality, consider sanity checks in the victim owner's `Damage` handler
  (`src/fps/combat.ts`): distance, line of sight, fire rate.
- Social presence: VR hands already replicate. Consider a small emote or point gesture for desktop and
  mobile so they can communicate with VR players.

## Open questions for the project owner

- Should mobile be first-person like desktop, or a third-person view that suits touch better?
- How strong should aim assist be for touch, and should desktop and VR players be told it exists?
- Should desktop movement get the same accelerate-to-top-speed feel as VR (currently walk plus Shift
  to run)?
- Should the three platforms ever be matched separately (e.g. a "no aim assist" shard)?

## Checklist for new features

- What does each platform (VR, desktop, mobile) do to trigger it, and see it happen?
- Is the replicated state a body or world fact (hand position, what's held), not a control
  (button pressed)?
- Does input reading stay in an adapter and drawing in a presenter?
- Does any platform get an unfair advantage, and is that intended?
- Is there a headless test, and was it checked in the browser on desktop and `?xrsim`?
