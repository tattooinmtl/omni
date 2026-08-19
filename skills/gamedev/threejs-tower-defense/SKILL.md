---
name: threejs-tower-defense
command: /td3d
description: Build Three.js tower-defense games with practical gameplay rules, style presets, and model guidance.
---

# Three.js Tower Defense Builder

## Purpose
Build playable browser tower-defense projects with Three.js. Use this skill when
the user asks for a 3D tower defense, asks for `/td3d`, or asks for tower,
enemy, boss, map, wave, or model-set ideas.

Before building, call `threejs_tower_defense_guide` with the project name and
style preset to get the project folder, model set, and gameplay checklist.

## Demo Map Template
Use this full example as the default Three.js tower-defense demo-map template:

`skills/threejs-tower-defense/templates/nim-towerdefence-demo.html`

When the user asks for a tower-defense demo map, start from this template's
structure unless they ask for a different map:

- Single full-screen Three.js HTML prototype with top HUD, bottom tower shop,
  start-wave button, range preview, and sell-on-second-click tower behavior.
- 20x14 grid with `CELL = 2`, `gridToWorld(r, c)`, and a serpentine path.
- Path layout: row 2 left-to-right, right-side drop, row 5 right-to-left,
  left-side drop, row 8 left-to-right, right-side drop, row 11 right-to-left.
- Starter economy: 25 lives, 200 gold, 50 percent tower sell refund.
- Tower set: basic, cannon, tesla, multishot, sniper.
- Enemy set: scout, runner, tank, brute, swarmer, armored, boss.
- Wave shape: 15 waves, scaling count/speed, boss every 5th wave.
- Controls: `WASD` camera pan, mouse wheel zoom, click card then green cell to
  place, click placed tower twice to sell.
- Sounds: Web Audio API procedural SFX for select, place, sell, wave start,
  shoot, cannon, tesla, hit, enemy death, leak, wave clear, victory, and game
  over.

If generating a Vite project instead of one HTML file, preserve the template's
game constants, path builder, HUD layout, shop flow, camera controls, and update
loop semantics while splitting them into modules. Preserve the Web Audio API
SFX system too; do not require external audio files for the first playable demo.

## Default Output Location
Create every new tower-defense project under:

`NimProjects/<project-name>/`

Use a short folder name inferred from the request, for example:

- `NimProjects/CrystalKeepDefense/`
- `NimProjects/NeonGridTD/`
- `NimProjects/PixelSiegeTD/`

## Project Shape
Prefer a small, runnable Vite project when using Three.js:

- `package.json`
- `index.html`
- `src/main.js`
- `src/style.css`
- `src/game/` for towers, enemies, waves, maps, and systems

If the user asks for no install step, make a single `index.html` using the
Three.js CDN, but mention that the Vite structure is better for expansion.

## Core Three.js Rules
- Use Three.js for all 3D rendering.
- Use simple geometry first: boxes, cylinders, cones, planes, instanced meshes,
  and low-poly shapes.
- Keep the main scene full-viewport.
- Use `requestAnimationFrame` with a fixed-step or capped-delta update.
- Make `W`, `A`, `S`, and `D` the default camera pan controls.
- Make the mouse wheel the default zoom control, with min/max zoom clamps.
- Separate game logic from rendering: towers target enemies by game state, then
  meshes mirror that state.
- Use object pools for projectiles, particles, hit sparks, and floating damage
  text.
- Use `InstancedMesh` for repeated enemies, floor tiles, trees, crystals, bolts,
  path markers, and decoration.
- Use `Raycaster` for tile picking, tower placement, hover highlights, and
  selection.
- Avoid loading heavy model files for the first version unless the user asks.

## Tower Defense Gameplay Checklist
Every tower-defense prototype should include:

- The demo-map baseline from `templates/nim-towerdefence-demo.html` unless the
  user asks for a different map.
- A visible path from spawn to base.
- Buildable tiles clearly distinct from blocked/path tiles.
- At least 3 tower types with different roles.
- At least 3 enemy types with different behavior.
- Waves that scale health, speed, count, and reward.
- A base health/lives counter.
- Currency, build cost, sell/refund, and upgrade levels.
- Range preview when hovering or placing a tower.
- Targeting feedback: beams, arcs, muzzle flash, projectile trails, or impact FX.
- Clear win/lose states and a restart control.
- Web Audio API sound feedback for tower selection, placement, selling,
  shooting, hits, wave events, enemy leaks, victory, and game over.

## Practical Systems

### Map
- Represent the map as a grid: `0 = buildable`, `1 = path`, `2 = blocked`.
- For the default demo map, use the template's 20x14 serpentine maze:
- lane 1: row 2, columns 1 through 18.
- right drop: rows 3 through 4 at column 18.
- lane 2: row 5, columns 18 down to 1.
- left drop: rows 6 through 7 at column 1.
- lane 3: row 8, columns 1 through 18.
- right drop: rows 9 through 10 at column 18.
- lane 4: row 11, columns 18 down to 1.
- Store path waypoints as world coordinates.
- Convert tile coordinates to world coordinates with one helper.
- Keep the camera angled enough to read both height and path shape.
- Keep camera movement deterministic and simple:
- `W` pans toward the top/north of the board.
- `S` pans toward the bottom/south of the board.
- `A` pans left/west.
- `D` pans right/east.
- Mouse wheel zooms in and out; clamp zoom so the player cannot clip through the
  board or zoom so far out that selection becomes unreadable.

### Enemies
- Move enemies along waypoint segments.
- Track `distanceTravelled` so towers can target first, last, strongest, weakest,
  or nearest.
- Give each enemy: `hp`, `maxHp`, `speed`, `armor`, `reward`, `radius`,
  `statusEffects`.
- Use status effects: slow, burn, stun, poison, shield-break, reveal.

### Towers
- Give each tower: `range`, `fireRate`, `damage`, `targetMode`, `level`, `cost`.
- Think in roles, not just numbers:
- Arrow/Cannon: reliable starter.
- Frost: slows groups.
- Lightning: chain damage.
- Artillery: splash damage.
- Sniper: long-range boss killer.
- Aura/Support: buffs nearby towers.

### Projectiles
- Every projectile must have a bounded lifetime: `age`, `ttl`, `speed`,
  `travelled`, `maxDistance`, `targetId`, and `active`.
- Update `age += dt` and `travelled += speed * dt` every frame.
- Recycle the projectile immediately when it hits, when `age > ttl`, when
  `travelled > maxDistance`, or when the target is dead/missing.
- Use an object pool with a hard active-projectile cap so many towers cannot
  saturate memory or create thousands of meshes.
- Prefer hitscan beams or reused mesh trails for very high fire-rate towers.

### Sound
- Use the Web Audio API (`AudioContext`, `OscillatorNode`, `GainNode`, and short
  generated noise buffers) for first-version sound effects.
- Unlock/resume audio from user gestures like Start Wave, tower selection, or
  tower placement.
- Add short low-gain SFX for: select, place, sell, wave start, shoot, cannon,
  tesla, hit, enemy death, leak, wave clear, victory, and game over.
- Throttle repeated sounds with last-played timestamps, especially `shoot`,
  `hit`, and rapid-chain tower sounds.
- Keep sounds procedural and optional; gameplay must continue if browser audio
  is suspended or unavailable.
- Avoid creating long-lived audio nodes; start/stop oscillators quickly and let
  them disconnect naturally after their envelope ends.

### Bosses
- Bosses should change decisions, not just have more health.
- Good boss mechanics: shield phases, armor plates, minion spawns, path rush,
  tower disable pulse, split on death, healing aura, decoy clones.
- Telegraph boss abilities with visible rings, warning colors, or charge-up
  animation.

## Style Presets

### Pixel
Visual language:
- Low-poly voxel shapes, blocky towers, square particles, crisp shadows.
- Palette: grass green, dirt brown, sky blue, gold coins, red damage flashes.
- Use nearest-neighbor pixel textures or procedural checker textures.
- Camera: orthographic or near-orthographic isometric.

Model set:
- Towers: cube turret, block cannon, voxel mage, pixel tesla coil, block mortar.
- Enemies: slime cube, skull block, beetle brick, bat wedge, armored cube boss.
- Props: block trees, cube rocks, coin pickups, tile-grid highlights.

### Fantasy
Visual language:
- Warm torches, stone roads, glowing crystals, banners, runes, wooded terrain.
- Palette: moss, stone, amber, royal red, mana blue.
- Use cylinders/cones for towers, crystal meshes for magic, subtle fog.
- Camera: perspective, angled over a winding path.

Model set:
- Towers: archer tower, mage spire, cannon keep, frost crystal, druid grove.
- Enemies: goblin runner, armored knight, wolf pack, wraith, dragon boss.
- Props: castle gate, ruins, mushrooms, trees, braziers, magic sigils.

### Techno
Visual language:
- Grid floor, emissive strips, holograms, drones, lasers, shield rings.
- Palette: black/graphite base with cyan, lime, magenta, and warning orange.
- Use bloom if available, but keep performance sane.
- Camera: lower dramatic angle or top-down tactical view.

Model set:
- Towers: laser prism, railgun pylon, drone bay, pulse tower, EMP dish.
- Enemies: crawler bot, hover drone, shield tank, nanite swarm, core boss.
- Props: neon path rails, hex tiles, data pillars, reactor cores.

### Medieval
Visual language:
- Fortified walls, wood, iron, flags, cobblestone paths, siege weapons.
- Palette: stone gray, timber brown, iron, muted banner colors, fire orange.
- Use chunkier silhouettes and believable mechanical towers.
- Camera: classic strategy angle.

Model set:
- Towers: ballista, catapult, watchtower, oil cauldron, crossbow turret.
- Enemies: footman, shield bearer, cavalry, siege ram, warlord boss.
- Props: walls, tents, crates, hay bales, banners, torches.

### Hybrid Style Ideas
- Pixel fantasy: voxel castles, chunky magic bolts, bright readable tiles.
- Techno medieval: neon runes, railgun towers mounted on stone keeps.
- Dark fantasy: cursed path, bone towers, spectral enemies, low saturation.
- Toy diorama: tabletop bases, rounded miniatures, tilt-shift camera.

## Balance Tips
- Start with enemy speed around `1.5` to `2.5` world units per second.
- Tower range should cover 2 to 4 tiles at level 1.
- Make early waves beatable with 2 starter towers.
- Increase enemy health by 10-25 percent per wave at first.
- Add new enemy types before only raising stats.
- Keep tower upgrades meaningful: damage, range, fire rate, or special effect.
- Give the player interesting tradeoffs: splash vs single-target, slow vs damage,
  cheap coverage vs expensive boss killer.

## UX Tips
- Show build ghosts before placement.
- Use green/red placement preview for valid/invalid tiles.
- Show tower range while hovering build buttons, selected towers, and placement
  ghosts.
- Put wave, lives, coins, and selected tower details in a compact HUD.
- Keep hotkeys simple: `WASD` camera pan, mouse wheel zoom, `1-5` choose tower,
  `Esc` cancel, `Space` start wave.
- Animate feedback: coin gain, damage numbers, tower recoil, enemy hit flash.

## Performance Tips
- Use one geometry/material per repeated family when possible.
- Reuse projectile meshes instead of creating and disposing each shot.
- Give projectile meshes a short `ttl` and recycle them; never leave missed
  shots alive forever.
- Add a max active projectile count and skip, merge, or hitscan extra shots when
  the cap is reached.
- Avoid per-frame allocations inside update loops.
- Throttle Web Audio API SFX so high fire-rate towers do not create too many
  oscillators per frame.
- Keep enemy count readable; make late-wave difficulty come from composition, not
  thousands of meshes.
- Use simple shadow settings or baked-looking fake shadows under units.
- Use `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))`.

## Implementation Order
1. Create the Vite/Three.js project in `NimProjects/<project-name>/`.
2. Build scene, camera, renderer, lights, and resize handling.
3. Build map grid, path tiles, and world/tile conversion helpers.
4. Add enemy movement along waypoints.
5. Add tower placement with raycast picking.
6. Add targeting and projectiles.
7. Add waves, lives, currency, upgrades, and win/lose.
8. Apply the chosen style preset.
9. Verify in browser: scene renders, camera frames the full board, towers place,
   waves run, enemies can win, player can win, restart works.

## Output Requirements
When building a tower-defense project, provide:

- The project folder path.
- How to run it.
- Controls.
- What style preset was used.
- What tower and enemy sets are included.
- Any performance or gameplay limits of the current version.
