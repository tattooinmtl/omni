---
name: what-is-deepapi
description: Background context on what DeepAPI is and why these skills call it. Read SKILL.md for the actual endpoints and request rules.
---

# What is DeepAPI?

[DeepAPI](https://deepapi.co) is one HTTP API that gives an AI agent the things it
cannot do on its own: search the web, scrape pages and platforms, run deep
research, send email, generate images, and keep durable memory across sessions.

This file is background only. The endpoints, request rules, and error handling
live in `SKILL.md`.

## Why it exists

An agent that needs live web data normally ends up with a pile of separate
accounts: one search provider, one scraping provider, one research provider, one
email provider. Each has its own auth, its own SDK, its own billing, and its own
failure modes. Scraping in particular tends to break from a laptop, because the
target site sees a residential IP running an automated browser and blocks it.

DeepAPI collapses that into a single base URL and a single key. Requests run
server-side, so the bot-detection problem is handled upstream rather than on the
user's machine.

## How it behaves

A few properties matter when you are writing or reading a skill that calls it:

- **One key, one base URL.** `DEEPAPI_API_KEY` and `DEEPAPI_API_BASE_URL` cover
  every endpoint. No per-provider credentials.
- **Prepaid credits with per-call caps.** Every paid endpoint has a default spend
  cap, and `maxCostUsd` overrides it. An agent cannot quietly burn a balance.
- **Failed calls are free.** A request that ends in `failed` is never charged.
- **Free price previews.** `dryRun: true` runs the full pre-flight — validation,
  auth, scope, balance — and reports the exact cost without spending anything.
- **Self-correcting errors.** An `invalid_request` response carries the expected
  schema and a working example body, so an agent can repair its own request
  instead of going to look up documentation.
- **Idempotency.** Every `POST` takes an `Idempotency-Key`, so a retry after a
  timeout replays the original outcome instead of paying twice.

## Which skills here use it

The `research-and-web` skills route their web work through it:

| Skill | What it uses DeepAPI for |
|---|---|
| `deepapi` | Full endpoint reference. Start here. |
| `deep-research` | `POST /v1/research/deep` plus a saved cited report |
| `youtube-transcript` | `POST /v1/scrape/youtube/transcript` |
| `online-shopping` | Web search, scraping, and research for price checks |
| `pi-web-search` | Ranked web search results with URLs |
| `browser-harness` | `POST /v1/scrape/website` when no real browser is needed |

## Getting a key

Sign up at [deepapi.co](https://deepapi.co) and follow the setup prompt at
[deepapi.co/docs](https://deepapi.co/docs). It writes the key to a platform env
file that the skills read automatically. Credits are topped up at
[deepapi.co/credits](https://deepapi.co/credits).
