---
name: threejs-3d-modeler
command: /model3d
description: Create game-ready procedural Three.js models and matching model sets.
---

# Three.js 3D Modeler

## Purpose
Create lightweight game-ready 3D models for Three.js projects. Use this skill
when the user asks for 3D models, model sets, towers, enemies, bosses, props,
tiles, weapons, projectiles, or style-consistent assets.

## Tools
Use `threejs_model_guide` before planning a new model or model set.

Use `create_threejs_model_module` to write reusable procedural model modules to:

`NimProjects/<project-name>/src/models/`

Each module exports a function like:

`createFrostTower(options)`

## Supported Styles
- `pixel`: voxel-like, chunky, crisp, bright, tile-friendly.
- `fantasy`: stone, wood, banners, crystals, runes, magic glow.
- `techno`: neon grids, emissive strips, drones, shield rings.
- `medieval`: timber, iron, stone, flags, siege-machine silhouettes.
- `scifi`: sleek panels, fins, glowing cores, antennae.
- `horror`: asymmetry, spikes, ribs, eerie glow, low saturation.
- `toy`: bright rounded miniatures with simple friendly shapes.
- `lowpoly`: faceted geometry, clean silhouettes, minimal part count.

## Supported Model Types
- `tower`
- `enemy`
- `boss`
- `prop`
- `projectile`
- `tile`

## Modeling Rules
- Build with simple Three.js primitives first: `BoxGeometry`,
  `CylinderGeometry`, `ConeGeometry`, `SphereGeometry`, and `TorusGeometry`.
- Return a `THREE.Group` with named child meshes.
- Keep silhouettes readable from an isometric or strategy-game camera.
- Keep model scale consistent: enemies around 1 unit tall, towers around 1.5
  units tall, bosses 2 to 3 units wide/tall.
- Use shared materials inside each model family.
- Store gameplay metadata in `group.userData`, such as `modelType` and `style`.
- Do not add heavy imported assets unless the user specifically asks.

## Model Set Tips
For tower defense, create model sets in groups:

- 5 towers: starter, splash, slow, chain/lightning, boss killer.
- 5 enemies: swarm, runner, armored, flying/hovering, support/healer.
- 1 boss: larger silhouette, weak point, phase rings or armor plates.
- Props: trees, rocks, crystals, banners, barrels, neon pylons, ruins.
- Tiles: path, buildable, blocked, spawn, base, hover/selection marker.

## Blender / GLB Path
If Blender is available and the user asks for exportable files, generate a
Blender Python script that creates the model and exports `.glb` files into:

`NimProjects/<project-name>/assets/models/`

For normal browser prototypes, prefer procedural Three.js modules first.

## Output Requirements
When making models, report:

- Files created.
- Exported function names.
- Style and model type.
- How to import the model into `src/main.js` or the game's model registry.
- Any suggested next model in the matching set.
