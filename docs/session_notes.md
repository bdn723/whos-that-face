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

## 11 Oct 2026 (later): full version

### Owner decision
- Ben, after testing step 0 on Abby's iPhone: "it works on her phone, build the full version." Step 0 counted as a go.
- The #/check screenshot wasn't sent, so iPhone fingerprint parity is still unmeasured. The desktop browser matches Node (cosine 1.0000).

### What changed
- **Coverage = the plan:**
  - movies & TV, hosts, music;
  - NFL, NBA, MLB, NHL, WNBA, Premier League, US national teams;
  - Power-4 college: 67 schools × football/basketball players and coaches (402 Wikipedia categories; 5 schools use different basketball names, e.g. "Tennessee Lady Volunteers");
  - Nebraska.
- **Fame bars:** estimated views per 60 days of at least 900 (screen, music), at least 600 (sports, college), or tied to Nebraska. Lesser-known people (under 1,500 views / 60 days) appear only with the toggle.
- **Following Wikimedia's robot policy** (wikitech Robot_policy):
  - pageviews come from the daily dumps (3 sampled days, about 2½ minutes each locally), not the live API;
  - the Action API pauses 5 s after any request slower than 1 s;
  - photo downloads are paced (2 at a time, obeying 429 Retry-After).
  - Commons replies "Your bot is making too many requests" if we go faster than about 1 photo per second.
- **Group photos:** up to 3 faces are kept per photo; a second photo decides which face is the person.
- **Accuracy test:** a fixed 1-in-25 sample whose main photo shows only them.
- **Name search rebuilt for scale:**

  | | Before | After |
  |---|---|---|
  | Index build (desktop) | 2.1 s | 0.22 s |
  | Per search | 67 ms | 9.5 ms |

  Legal-name aliases are dropped. Hand-checked name pairs follow the closest match.

### Numbers (local collection, 11 Oct)

| | Count |
|---|---|
| Candidates | 301,918 titles |
| Kept people | 114,954 |
| With a free photo | 75,235 |

| Group | People | With photo |
|---|---|---|
| Movies & TV | 61,957 | 38,042 |
| Music | 31,442 | 23,512 |
| Pro sports | 23,919 | 17,722 |
| College | 16,431 | 9,922 |
| Nebraska | 816 | 325 |

- Collection took about 70 min locally from scratch:

  | Stage | Time |
  |---|---|
  | Pageview dumps | 7½ min |
  | Page info | 11 min |
  | Wikidata facts | 27 min |
  | Lead sentences | 23 min |

  It's cached in the `build-cache` release (29 MB) and reused for 30–120 days.
- The people file is 20.4 MB (6.6 MB gzipped), bigger than the plan's 60–80k people. Kept because load and search times are fine. If Abby finds it slow, raise the screen/music bars first.
- Fingerprinting runs at about 65 photos/min, so the first full pass is about 20 h. GitHub runs chain themselves (up to 8), publishing after each run, most-viewed people first.

### Open
- Watch the chained runs to completion; then check the accuracy report on the full index.
- iPhone #/check screenshot (parity, load and search timings on the real phone).
- Later ideas from the plan are unchanged: "save this face" on the phone, Nebraska roster names, self-hosted thumbnails.
