# Session notes

Append a new dated section at the end of each session. Never rewrite earlier sections.

## 11 Oct 2026: project start and step 0 (feasibility build)

### Owner decisions (Ben, 10–11 Oct 2026)
- Two ways in, equal weight: photo ("Why do I know that face?") and name ("Why do I recognize that name?").
- Hosting: free phone website on GitHub Pages (public repo `bdn723/whos-that-face`), saved to Abby's home screen.
- Photos are checked on the phone only; nothing is uploaded.
- **Free-licence photos only** (Wikimedia Commons). Ben chose this over ESPN, team-site and TMDB photos, knowing it leaves most Nebraska and college players without a face match.
- Coverage: movies & TV, music, NFL, NBA, MLB, NHL, soccer (Premier League + US national teams), Power-4 college. Nebraska is a priority: Abby is a fan.

### What was built
- Face pipeline: YuNet detector + SFace fingerprints on onnxruntime-web 1.30.0 (WASM, single-threaded). The same `shared/face.js` runs in Node and in the browser. Detection and embedding take about 0.17 s per photo in a desktop browser.
- Name search: `shared/names.js` (normalise, Double Metaphone, edit distance, nickname prefixes).
- Data from Wikidata and Wikipedia only; no API keys.
  - Big people lists come from QLever. It intermittently returns zero rows when a query filters on sitelinks, so filtering is done in JS.
  - Per-person facts come from the official query service.
  - Nebraska people come from Wikipedia categories plus Wikidata team links (the category for coaches misses Matt Rhule).
- "Known for" line: the predicate of the first sentence of the Wikipedia lead, plus chips (top films/series, band, main team, Nebraska team).
- 14 "often mistaken for" pairs in `data/mistaken-for.json`. Every face pair's source was checked to name both people (`build/verify-pairs.js`, all OK 11 Oct).
- App: home screen with both ways in, face results (best match + label, often mistaken for, 10 similar faces), name results (same name / similar names), person page (live Wikipedia summary, pairs, similar faces, similar names), filters, "include lesser-known" switch, About page. Tested in the desktop browser pane at phone size, in light and dark mode.

### Step 0 index and results (`step0` profile)
- People:

  | | Count |
  |---|---|
  | Total | 1,172 |
  | With a free photo | 681 |
  | With a usable face | 649 |
  | Tied to Nebraska | 816 (most are historical football players) |

- Accuracy test: the right person is found from their second Commons photo, among 649 faces.

  | Group | n | Ranked first (95% CI) | In top 10 |
  |---|---|---|---|
  | All | 220 | 78.6% (72.8–83.5) | 85.5% |
  | Movies & TV | 56 | 98.2% | 98.2% |
  | Music | 56 | 92.9% | 98.2% |
  | Pro sports | 56 | 60.7% | 73.2% |
  | Nebraska | 52 | 61.5% | 71.2% |

  Sports misses are mostly test-photo problems: helmets and action shots, parades and group photos, very old pictures.
- Compressed (int8) vs full precision: top-10 lists overlap 99.4%.
- Curated face pairs in face space: only Chastain/Howard (rank 1) and Reynolds/Gosling (rank 5) are close. Ferrell/Smith is rank 71 of 648. **Face fingerprints measure identity, not human-perceived resemblance**, so the curated pairs are essential.
- Plan checks:

  | Check | Result |
  |---|---|
  | Will Ferrell photo → Chad Smith | ✓ via the curated pair |
  | "Josh Allen" → both players | ✓ |
  | "Will Farrel" → Ferrell + Colin Farrell | ✓ |

### Open issues / next steps
- **Step 0 go/no-go needs Ben:** open the site on Abby's iPhone and report speed and how it feels. iPhone parity (cosine ≥ 0.99 vs Node) is not yet measured on a real phone.
- The service worker (offline cache) couldn't register inside the desktop app's browser pane. Check it in Safari on the live site.
- **Full-scale build:** fingerprinting runs about 1 s per photo (download-bound), so ~50k photos would take ~15 h, longer than one GitHub Actions run. Before the MVP: keep the embedding cache as a Release asset and let runs resume.
- When a person's main photo is a group shot, the largest face may be someone else (e.g. Maria Bartiromo's photo is a Pompeo interview). Prefer single-face photos, and use the second and third photos to settle disagreements (31 people flagged).
- Similar-faces lists include some odd picks (e.g. Zoe Saldaña for Will Ferrell). Consider tuning the fame bonus with the accuracy test.
- Screen and music pools include many non-US actors with high English Wikipedia pageviews. Probably fine; revisit if Abby finds the lists unfamiliar.
