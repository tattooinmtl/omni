---
name: tower-defense-map-editor
command: /mapeditor
description: Launch the visual tower-defense map, content, and modular tower editor.
---

# Tower Defense Map Editor

Immediately call `launch_tower_defense_map_editor`. Do not create a replacement page and do not ask for a project name. This opens the purple-themed Nim TD Engine (`NimProjects/TowerDefenseEngine/index.html`, served by `editor/server.mjs`) with five tabs: Play, Map Editor, Tower Editor, AI TD Maker, and Game Creator (scenario editor). After it opens, briefly tell the user that Map/Tower state autosaves to browser localStorage (Save/Load buttons plus Export/Import JSON for files), the Map Editor has explicit Set Start / Set End tools so path direction is unambiguous, the Tower Editor lists both built-in and custom towers (click a built-in to clone & edit it), and every tab's AI assist calls NimAgent's own configured model via `/api/ai` (domain `tower` | `map` | `scenario`) rather than a canned response.
