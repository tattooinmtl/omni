---
name: threejs-3d-model-editor
command: /3d-edit
description: Isolate and tweak one generated Three.js model module by name.
---

# Three.js 3D Model Editor

## Purpose
Edit one generated Three.js model at a time. Use this skill when the user runs:

`/3d-edit <model name>`

or asks to tweak, recolor, resize, isolate, inspect, rename, add, or remove a
part from a specific 3D model.

## Workflow
1. Identify the project folder under `NimProjects/`. If the user did not name
   it, infer the most likely current project from the conversation.
2. Call `inspect_threejs_model_module` with `project_name` and `model_name`.
3. Report the isolated model file, export name, materials, and named parts.
4. Apply focused edits with `edit_threejs_model_module`.
5. Inspect again after editing and summarize the exact changes.

## Supported Edits
- `set_group_scale`: resize the whole model.
- `set_material_color`: recolor `primary`, `secondary`, `accent`, `danger`, or
  `dark`.
- `set_part_position`: move one named part.
- `set_part_rotation`: rotate one named part.
- `set_part_scale`: scale one named part.
- `rename_part`: rename one mesh part.
- `remove_part`: remove one mesh part.
- `add_part`: add a primitive part using `box`, `sphere`, `cylinder`, `cone`, or
  `torus`.
- `set_user_data`: add or update metadata on `group.userData`.

## Editing Rules
- Work on one model module only unless the user asks for a set-wide edit.
- Do not rewrite the whole file for a small tweak.
- Preserve the exported function name unless the user asks to rename the model.
- Keep part names descriptive because game code can target them later.
- Prefer readable proportions over tiny decorative details.
- For tower-defense models, check the silhouette from an isometric camera:
  the model should be recognizable when small.

## Examples
- `/3d-edit Frost Tower make the crystal taller and blue`
- `/3d-edit Shield Tank scale it 20 percent bigger`
- `/3d-edit Dragon Boss add glowing weak point on the chest`
- `/3d-edit Laser Prism change accent to cyan`

## Output Requirements
After editing, report:

- Model file edited.
- Operation applied.
- Materials or parts changed.
- Any import name that game code should use.
