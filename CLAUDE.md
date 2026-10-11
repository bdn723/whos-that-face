# Who's That? — instructions for Claude

A phone web app for Ben's wife, Abby. It answers two questions:
1. **"Why do I know that face?"** She drops in a photo and gets the best match plus about 10 famous lookalikes.
2. **"Why do I recognize that name?"** She types a name and gets everyone with that name plus similar-sounding names.

Both lead to a person page with "known for," "often mistaken for," similar faces and similar names.

This file holds **durable** instructions. Session-by-session state goes in `docs/session_notes.md`: append a dated section at the end of each session and never rewrite earlier ones. The approved plan is in `docs/plan.md`.

## Who you're working with
- Ben does **not code and won't use Terminal**. Do all coding and command-running yourself.
- When you need something from him, give **numbered click-by-click steps**. No code, no commands.
- Keep explanations short and plain: lead with the answer, then a small table or a few bullets.
- Abby uses an iPhone (Safari, home-screen web app). She's a big Nebraska fan.

## Owner decisions (11 Oct 2026). Do not change without asking Ben.
- **Photos are processed on the phone only.** Nothing she photographs is ever uploaded. No cloud face APIs, no server.
- **Free-license photos only.** Face fingerprints come only from Wikimedia Commons. Never use ESPN, team-site (huskers.com), TMDB, IMDb or other photos. Names, positions and other facts are fine.
- **Only public figures with an English Wikipedia article.** Never add a way to search the web for faces.
- **Hosting:** free GitHub Pages from the public repo `bdn723/whos-that-face`.
- **Coverage:** movies & TV, music, NFL, NBA, MLB, NHL, soccer (Premier League + US national teams), and Power-4 college. Nebraska is a priority.

## How it works
- `shared/face.js`: YuNet face detector + SFace fingerprints (onnxruntime-web, WASM, single-threaded). The same file runs in the browser and in the Node build, so fingerprints match.
- `shared/names.js`: name normalisation, Double Metaphone sound-alikes, and edit distance.
- Build steps (run in order):

  | Step | What it does | Writes |
  |---|---|---|
  | `node build/collect.js <step0\|full>` | picks people | `build/out/people.json` |
  | `node build/embed.js` | fingerprints faces (cached per photo in `build/cache/`) | `build/out/faces.json` |
  | `node build/eval.js` | accuracy test | `build/out/eval.json` |
  | `node build/pack.js` | assembles the site | `dist/` |

- `node build/verify-pairs.js` checks the sources of the "often mistaken for" pairs in `data/mistaken-for.json`. Run it locally after adding pairs.
- **Publishing:** the GitHub Action "Build and publish" (`.github/workflows/build.yml`) runs all four steps and deploys `dist/` to Pages. The index is never committed to git.
- **Local preview:** the `whos-that-dist` entry in `.claude/launch.json` serves `dist/` on port 8765.

## Gotchas
- **QLever** (`qlever.dev`), the fast Wikidata mirror used for the big people lists, intermittently returns zero rows for queries with a FILTER on `wikibase:sitelinks`. Filter in JS instead; an empty pool counts as a failure. Small per-person batches go to the official query service.
- **Wikimedia etiquette:** a User-Agent naming the repo (`build/lib/http.js`), API calls one at a time, at most 2 photo downloads at once, and standard thumbnail widths only (250/330/500/960).
- **Lookalikes:** face fingerprints measure identity, not "looks like." Famous lookalike pairs (e.g. Will Ferrell / Chad Smith) can score low, which is why the hand-checked pairs exist. Every face pair needs a source naming both people.
- `gh` is authenticated as **bdn723**.
