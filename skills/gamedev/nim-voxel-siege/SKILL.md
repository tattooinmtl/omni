---
name: nim-voxel-siege
command: /voxelsiege
description: Extend NimVoxelEngine/NimVoxelEditor with a castle-siege voxel game — biome+castle world generation, wire/power contraptions, physics-based projectiles and cannons, and an AI-driven workbench block mixer that can create new block types on demand.
---

# NimVoxelEngine — Castle Siege Extension

## Purpose
Use this skill when the user asks to extend `NimVoxelEditor`/`NimVoxelEngine`
(`NimProjects/mineblocks/`) toward a Minecraft-like castle-siege game: two
castles separated by generated biomes/mountains, redstone-style wiring,
physics-based cannons/projectiles, and a workbench where blocks can be mixed —
including AI-generated custom blocks — into new placeable block types.

This is a large feature set built in phases on top of the existing engine.
Do not attempt all phases in one pass unless asked; confirm which phase to
build, then implement that phase fully (playable/testable) before moving on.

## Current Engine State (verified — re-check before building, it may have moved)
- Real engine lives in `apps/runtime/game.js` (play) and
  `apps/editor/renderer.js` (edit) — both self-contained, ~800 lines each.
- Block registry today is the `MAT` object in `game.js`: `id -> { name, color,
  emissive, water? }`. `shared/voxel.js` is a separate legacy stub with its own
  `Chunk`/`World` classes and is NOT what `game.js` actually uses — don't split
  work across both without checking which one a given app file imports.
- Voxel storage: `Map` of chunk key `"cx,cy,cz"` -> `Uint8Array` of block ids,
  16^3 per chunk.
- `package.json` already lists `three`, `cannon-es`, and `electron` as
  dependencies — `cannon-es` is present but currently unused by any app file.
  Use it for the physics phase rather than adding a new physics dependency.
- Launch via NimAgent's `/NimEditor` and `/NimEngine` commands, which run
  `npm run NimVoxelEditor` / `npm run NimVoxelEngine` in this project's
  directory (electron entry points `apps/editor/main.js` /
  `apps/runtime/main.js`).

## Phase Overview
1. **World/biome + castle generator** — procedural terrain, named biomes,
   two fixed castles with buildable space between them. Not yet built.
2. **Wiring & power** — wire blocks conduct current from generator blocks to
   action blocks (the redstone-equivalent circuit layer). Not yet built, but
   the block behavior DSL below (Phase 4) already reserves `onPowered` /
   `onUnpowered` triggers so nothing built now has to be reworked later.
3. **Physics & projectiles** — gravity, rigid-body cannonballs/soccer balls,
   a pushable wheeled cannon that can be loaded and fired, and voxel damage
   from projectile impacts. Detailed below.
4. **Workbench + Block Mixer + AI custom blocks** — the crafting/creation
   loop: mix existing blocks into new ones, or describe a new block in
   natural language and have the AI generate its behavior. Detailed below.
   Phases 3 and 4 are designed together because the flagship AI use case
   ("an AI-made cannon on wheels you can push and load) is a mixer output
   whose behavior is expressed in physics terms.

Build order for phases 3+4 (the requested starting point):
block registry extension -> physics world -> projectile + voxel damage ->
workbench block + mixer UI -> recipe table -> AI custom-block generation ->
persistence/reuse of AI blocks as future mixer ingredients.

## Phase 3 — Physics, Projectiles, and the Wheeled Cannon

### Physics world
- Add one `CANNON.World` (from `cannon-es`) to `apps/runtime/game.js`, with
  standard gravity (`-9.82` on the vertical axis matched to `BSIZE`/block
  scale) and a fixed timestep stepped from the existing render loop
  (accumulate `dt`, step in fixed increments, never a variable step — avoids
  tunneling through voxel faces at low framerate).
- Do **not** give every static terrain voxel its own rigid body — that
  explodes body count. Terrain collision should be a lightweight custom
  check: sample the voxel grid directly (the game already has `getVoxel`) for
  AABB-vs-voxel collision, used by anything that needs to collide with
  terrain (projectiles, the cannon, the player).
- Only give real `cannon-es` rigid bodies to *movable* things: cannonballs,
  soccer balls, the wheeled cannon itself, and any future AI-block that
  declares itself physics-driven (see Phase 4 DSL `physics: "dynamic"`).

### Throwable/rounded projectiles
- Projectile entity: `{ id, kind, position, velocity, radius, mass,
  restitution, spawnedAt, ownerId }`. Represent as a `CANNON.Body` with a
  `CANNON.Sphere` shape; render as an instanced sphere mesh (reuse geometry
  per `kind`, e.g. cannonball vs soccer ball get different radius/mass/color
  but share the sphere mesh path).
- Voxel collision for projectiles: on each physics step, check the body's
  swept AABB against `getVoxel` along its path (not just its end position —
  fast cannonballs can pass through a 1-voxel-thick wall in a single step
  otherwise). On hit:
  - Compute impact energy from `mass * |velocity|^2` (or similar) and compare
    against each candidate block's `hardness` (add `hardness` to the block
    registry entry, default `1`; bedrock-equivalent blocks should be
    unbreakable — use `Infinity`).
  - If impact energy clears the hardness threshold, remove/replace the
    voxel(s) in a small radius around the impact point (a blast radius, not
    just the single voxel hit, so cannonballs feel like siege weapons) and
    trigger a mesh rebuild for the affected chunk(s).
  - Always destroy or bounce the projectile body according to its
    `restitution`; never leave dead projectile bodies in the physics world —
    cap total active projectile bodies the same way the tower-defense skill
    caps active projectiles, for the same performance reason.
- Bounded lifetime: give every projectile a `ttl`; despawn (and remove its
  `CANNON.Body` from the world) on `ttl` expiry even if it never hits
  anything, so a ball flying off the map doesn't simulate forever.

### Wheeled cannon
- The cannon is a placeable, pushable block/entity, not a static block:
  - `push`: player interacts while facing a horizontal direction near the
    cannon -> apply a capped impulse to its `CANNON.Body` (or, simpler and
    more voxel-game-appropriate, move it one voxel cell at a time along the
    grid like a pushed block, snapping position — pick whichever matches how
    the existing player-movement/interaction code already works, don't
    introduce a second movement paradigm for one object).
  - `load`: player interacts while holding a cannonball item and the cannon
    has no ball loaded -> consume one cannonball item, set `loaded: true`.
  - `aim`: cannon orientation follows the direction it was last pushed from,
    or an explicit aim key if the player-control scheme already has one for
    tools — reuse whatever aiming convention already exists rather than
    inventing a new one.
  - `fire`: player interacts while loaded -> spawn a cannonball projectile
    at the cannon's muzzle offset with velocity along its aim direction
    scaled by a `power` stat, set `loaded: false`, play a fire
    animation/sound consistent with the tower-defense skill's Web Audio SFX
    approach (short procedural sound, no external audio files required).
- The cannon itself should be defined as a regular block-registry entry with
  `category: "contraption"` and a `behavior` object (see Phase 4 DSL) so a
  user-requested "AI-made cannon on wheels" is not a special case in the
  engine — it's just a mixer-generated block instance whose DSL declares
  `pushable`, `loadable`, and a `fire` action. Build the DSL expressive
  enough that the hand-built cannon above is itself expressible as data in
  that DSL, not hardcoded engine logic. That's what lets the AI later
  generate cannon-like contraptions without engine changes.

## Phase 4 — Workbench, Block Mixer, and AI-Generated Blocks

### Block registry extension
Extend each `MAT` entry (and every future block) to this shape:
```js
{
  id, name, color, emissive,
  category,       // "terrain" | "wire" | "power" | "action" | "contraption" | "custom"
  tags: [],       // e.g. ["explosive","structural","power-consumer"] — drives mixer recipe matching
  hardness: 1,    // resistance to projectile/tool damage; Infinity = indestructible
  physics: "static" | "dynamic", // static = voxel grid; dynamic = real cannon-es body
  behavior: null | { ... }        // see DSL below; null for plain terrain blocks
}
```
Keep built-in blocks (`stone`, `dirt`, etc.) as `behavior: null` — the DSL
only matters for wire/power/action/contraption/custom blocks.

### Workbench block + Block Mixer UI
- New placeable block: `Workbench` (`category: "action"`, plain static block,
  no special physics).
- Proximity prompt: when the player is within N voxels of a placed
  Workbench, show a "Press E — Block Mixer" hint; `E` opens the mixer as a
  UI overlay and should pause player movement input the same way any other
  modal UI in the editor/runtime already does (check `renderer.js`/`game.js`
  for the existing pause/modal pattern before adding a second one).
- Mixer UI has two panes:
  1. **Recipe mixing** — 2-4 ingredient slots (drag existing inventory
     blocks in) plus an output preview. Match ingredient tag-sets against a
     small deterministic recipe table (data file, not code, so it's easy to
     extend) to produce a known new block. No AI call for this path — it's
     for predictable, repeatable crafting.
  2. **Custom (AI) block** — a natural-language text field plus 0-3 optional
     ingredient slots for stylistic/behavioral inspiration. Submitting calls
     the AI generation contract below.

### AI custom block generation contract
Reuse NimAgent's existing provider/model call path (same one `runTurn` uses)
rather than building a second LLM client. Send a constrained prompt that asks
for **structured JSON only**, in this exact shape:
```json
{
  "name": "string",
  "color": "#rrggbb",
  "category": "wire|power|action|contraption|custom",
  "tags": ["..."],
  "hardness": 1,
  "physics": "static|dynamic",
  "behavior": {
    "onPlaceholderTriggerName": [
      { "effect": "effectName", "params": { } }
    ]
  }
}
```
Fixed trigger vocabulary (extend deliberately, don't let the model invent new
trigger/effect names): `onPlayerInteract`, `onPowered`, `onUnpowered`,
`onNeighborChange`, `onProjectileImpact`, `onPushed`.
Fixed effect vocabulary: `setVoxel`, `spawnProjectile`, `applyImpulse`,
`damageVoxel`, `emitCurrent` (reserved for Phase 2), `playSound`,
`openGate`/`closeGate`.

**Hard safety rule: never `eval()` or otherwise execute AI-returned code.**
The whole point of the fixed trigger/effect vocabulary is that the engine's
existing interpreter runs it, exactly like the recipe-mixing path — an
AI-generated block is data, not a script, even though the user experience is
"the AI wrote this block's behavior." This matters more than usual here
because NimVoxelEditor/Engine are Electron apps with full Node access in the
main process; arbitrary generated code executing there is a real sandbox
escape, not just a game bug. If a requested behavior can't be expressed with
the current vocabulary, extend the vocabulary deliberately (as an engine
change reviewed like any other code change) — don't add a fallback that runs
free-form generated code to "still satisfy the prompt."
- Validate the model's JSON against the fixed vocabulary before accepting it;
  on an unknown trigger/effect name or malformed shape, retry once with the
  error fed back, then fall back to rejecting the request with a clear
  in-game message rather than silently accepting something unvalidated.

### Recursive reuse and persistence
- Every accepted custom block (recipe-made or AI-made) gets an id allocated
  above the built-in range (e.g. starting at 1000) and is appended to a
  per-project registry file, e.g.
  `NimProjects/mineblocks/projects/<world>/custom-blocks.json`, storing the
  full block object plus `ingredients` (the input block ids/tags used) and,
  for AI blocks, the original prompt.
- On world load, merge this file's blocks into the runtime registry after
  the built-ins, then they become placeable and themselves usable as future
  mixer ingredients — this is what makes the system "never-ending" per the
  request: nothing is a dead end, every created block re-enters the pool.
- Consider a simple crafting cost (a consumed resource per mix) so the loop
  has a pace to it rather than unlimited free generation — a balance choice
  to confirm with the user, not an assumed requirement.

## Phase 1/2 (not yet designed in detail)
World/biome/castle generation and the wiring/power layer are intentionally
left for their own pass — ask which to tackle next once Phase 3/4 is
playable. The DSL above already reserves `onPowered`/`onUnpowered` and
`emitCurrent` so Phase 2 slots in without reworking Phase 4's output format.

## Current Controls (keep this in sync when rebinding)
- `WASD` move, `Space` jump, mouse look.
- Left click break, right click place. Breaking any block has a ~7% chance to
  drop a potion (`items.js`).
- `1`-`0` select from the block hotbar; `Z` `X` `C` select from the separate
  siege-weapon bar (Cannon / Catapult / Ram).
- **Hold `F`** on a siege engine to grab and roll it along with you; release to
  park it. Engines have zero horizontal velocity unless held, so they never
  drift from where they were left.
- **Tap `E`**: load ammo, or swing the ram into whatever it faces. Also opens
  the Block Mixer when looking at a Workbench.
- **Hold `E`**: aim mode — the mouse steers the *engine* (not the camera) and a
  ballistic arc is drawn from the muzzle.
- **`R`**: fire the loaded engine.
- Player has 100 HP shown as 5 hearts (10 HP = half a heart); potions heal,
  cannonball blasts hurt, and death respawns at castle A.

## Verification
Before declaring any phase done:
- Launch via `/NimEditor` or `/NimEngine` (or `npm run NimVoxelEditor` /
  `npm run NimVoxelEngine` directly in `NimProjects/mineblocks/`) and confirm
  the window actually opens and the new mechanic works — this is an Electron
  desktop app, so it can't be verified through a headless browser check.
- For physics: confirm cannonballs fall under gravity, collide with terrain,
  and destroy/damage blocks within their blast radius without leaving dead
  bodies in the `CANNON.World` (check body count doesn't grow unbounded over
  a play session).
- For the mixer: confirm at least one recipe-mixing result and one AI-mixing
  result both end up placeable, persist across a world reload, and can be
  fed back into the mixer as ingredients.
