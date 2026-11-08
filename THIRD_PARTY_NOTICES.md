# Third-party notices

Omni's own code is MIT-licensed (see [LICENSE](LICENSE)). Many of the skills
bundled under [`skills/`](skills/) were written by other people and ported
into Omni. They keep their original licenses, reproduced or referenced
below. A skill's `author:` line in its `SKILL.md` says where it came from.

## Hermes Agent

Most bundled skills (those whose `SKILL.md` carries `hermes` metadata or an
`author:` naming Hermes Agent, Teknium, Nous Research, or an individual
Hermes contributor) come from Hermes Agent, including the ports it made of
the projects listed further down.

- Source: https://github.com/NousResearch/hermes-agent
- License: MIT
- Copyright (c) 2025 Nous Research

These skills were written for Hermes's tools. Omni leaves their text as
written and, when one loads, adds a short note telling the model which Omni
tool to use for each Hermes tool it names.

## Projects ported through Hermes Agent or directly

| Project | Bundled as | License | Copyright |
|---|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers) | `skills/superpowers/` and skills marked "adapted from obra/superpowers" | MIT | (c) 2025 Jesse Vincent |
| [JimLiu/baoyu-skills](https://github.com/JimLiu/baoyu-skills) | `skills/creative/baoyu-*` (see each folder's `PORT_NOTES.md`) | MIT | (c) 2026 Jim Liu |
| [gsd-build/get-shit-done](https://github.com/gsd-build/get-shit-done) | skills marked "adapted from gsd-build/get-shit-done" | MIT | (c) 2025 Lex Christopherson |
| [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | the design systems in the skill that names it | MIT | (c) 2026 VoltAgent |
| [Orchestra-Research/AI-research-SKILLs](https://github.com/Orchestra-Research/AI-research-SKILLs) | skills with `author: Orchestra Research` | MIT | (c) 2025 Claude AI Research Skills Contributors |
| [blader/humanizer](https://github.com/blader/humanizer) | `skills/creative/humanizer/` (its `LICENSE` is included there) | MIT | (c) 2025 Siqi Chen |
| [Synero/pixel-art-studio](https://github.com/Synero/pixel-art-studio) | palettes in `skills/creative/pixel-art/` (see its `ATTRIBUTION.md`) | MIT | (c) Synero and contributors |

## Conference LaTeX templates

`skills/research/research-paper-writing/templates/` contains the official
author kits (`.sty`, `.bst`, `.cls` files) of AAAI, ACL, COLM, ICLR, ICML
and NeurIPS. They are distributed by those conferences for authors to use
and keep the terms stated inside each file.

## The MIT License

The MIT-licensed works above are provided under these terms, with the
copyright line given for each:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

If you are the author of a bundled skill and something here is wrong or
missing, please open an issue: https://github.com/tattooinmtl/omni/issues
