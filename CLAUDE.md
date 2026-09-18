# p2p-game-engine — orientation for Claude Code

Full architecture and per-game docs live in [README.md](README.md) — read the relevant
section there before making non-trivial changes; this file is just a map so you know
where to look and don't have to read all 53KB of it up front.

## Setup

```bash
nvm use             # repo pins Node 22 — the default `node` on PATH is v10 and breaks npm scripts
npm install
npm run dev          # vite dev server, http://localhost:5173 (index of all games)
npm test             # vitest: engine unit + multi-peer simulation tests
npm run typecheck    # tsc --noEmit
npm run sim -- --peers 200 --seconds 40   # headless scale test
```

Use `.claude/launch.json` + the preview tool to run dev servers (`peer-city` on 5173,
`peer-walls` on 5180) rather than shelling out to `vite` directly.

## Repo shape

- `src/engine/` — shared, game-agnostic networking core. Entity schema/replication
  (`net/schema.ts`, `net/entity.ts`, `net/world.ts`), ownership hashing (`net/hash.ts`),
  interpolation (`net/interp.ts`), transports (`transport/trystero.ts` for WebRTC,
  `transport/memory.ts` for local BroadcastChannel testing). Imported via the `@engine/*`
  alias. README §"Using the framework" covers the API (`defineEntity`, `defineAction`,
  `defineCommand`, `NetWorld`, `Singleton`, ownership locks).
- `src/crossplay/` — shared cross-platform player layer (desktop/touch/VR input, avatar
  rig, voice chat, settings menu, minimap, HUD chrome). Used by every game **except**
  `src/game`. README §"The crossplay layer".
- `src/<game>/` — one directory per game, each with its own `<game>.html` entry point and
  README section. Current games: `fps` (Peer City 3D), `wilds`, `derby`, `walls`, `golf`,
  `haunt`, `shinobi`, `starship`, `sewer` (Sewer Lordz). See progress/status notes in memory (auto-loaded) for
  what's built vs. still in progress on each.
- `src/game/` — **legacy** 2D top-down Peer City (`city.html`), frozen, predates the
  crossplay layer. Don't refactor it to match newer games unless specifically asked.
- `scripts/loadsim.ts` — headless multi-peer load simulation (`npm run sim`).
- `tests/` — one `*.test.ts` per game/system, plus `harness.ts` for the simulation harness.

## Per-game file convention

Every game under `src/<game>/` (except legacy `src/game/`) follows roughly this layout —
knowing this means you can jump straight to the right file instead of grepping:

| File | Role |
|---|---|
| `main.ts` | Entry point wired from `<game>.html` |
| `Game.ts` | Phaser scene / top-level game class, wires everything together |
| `context.ts` | Shared per-match context/state object passed around the game |
| `defs.ts` | Networked entity/action/command definitions (`defineEntity` etc.) |
| `actions.ts` | Command/action handlers (server-less "who's allowed to do what") |
| `intent.ts` | Player intent capture, independent of input device |
| `frame.ts` | Per-tick update loop |
| `kit.ts` | Player loadout / tools / equipment |
| `hud.ts`, `wrist.ts` | 2D HUD and VR wrist-menu UI |
| `desktop.ts`, `touch.ts`, `vr.ts` | Per-platform input/rig glue (crossplay roles) |
| `models.ts`, `scenery.ts` | 3D asset loading / world dressing |
| `effects.ts`, `sfx.ts` | Visual/audio feedback |
| `views.ts` | Maps networked entities to renderable views |
| `style.css` | Game-specific UI styling |

Not every game has every file (e.g. `wilds` has no `frame.ts`/`actions.ts`); treat this as
the common shape, not a strict template.

## Conventions worth knowing

- Networked entity fields are quantized types (`t.fixed`, `t.angle`, `t.uint`, `t.enum`, ...)
  — only changed fields are sent. Put anything that must survive ownership migration in the
  schema, not in a closure.
- Ownership is a distributed lock (`world.withLock`, `requestOwnership`) — there's no
  server, so "who's allowed to change this entity" is always "its current owner."
- `?debug` on any game URL shows live network stats (toggle with `` ` ``).
