# "Who's That?" — plan

## Context
Abby often sees a face or hears a name and can't place it. Usually she's mixing the person up with someone else:
- She sees Will Ferrell, but she's thinking of Chad Smith.
- She hears "Josh Allen" and doesn't know whether it's the Bills QB or the pass rusher.

Google and IMDb can tell her who one person is. They can't show her the people she's probably mixing them up with, and that's usually where her real answer is.

The tool answers **two questions, as two equal ways in:**
1. **"Why do I know that face?"** She drops in a photo.
2. **"Why do I recognize that name?"** She types a name.

Both lead to the same kind of result: who it is, what they're known for, and the people she's most likely confusing them with.

This is a **new, separate project**. It does not touch the NFL forecast repo.

## Decisions (from Ben)
| Question | Answer |
|---|---|
| Ways in | **Photo or name.** Both are equal, side by side on the home screen. |
| How she opens it | Free website (GitHub Pages), saved to her iPhone home screen |
| Where the photo is checked | **On her phone only.** It is never uploaded anywhere. |
| Who it covers | Movies & TV, music, NFL, NBA, MLB, NHL, soccer (Premier League + US national teams), and Power-4 college (Big Ten, Big 12, SEC, ACC). **Nebraska is a priority.** |
| Photo sources | **Free-license photos only** (Wikipedia / Wikimedia Commons). No ESPN, team-site or TMDB photos. |

**What the free-license choice costs.** The photo side only knows people who have a Wikipedia photo. Most Nebraska and college players won't have one. The **name side doesn't need photos**, so it covers everyone with a Wikipedia article, including Nebraska players without a photo. A coverage report (e.g. "Nebraska football: 14 of 120 have photos, 38 have articles") shows the exact gaps.

## What Abby sees

**Home screen:** two big buttons, **"Who's that face?"** (camera / photo / paste screenshot) and **"Who's that name?"** (search box).

**Photo path:**
1. If the photo shows several faces, she taps the one she means.
2. **Best match:** "Strong match," "Possible," or "Probably not in the database."
3. **Similar faces:** about 10 lookalikes from any field, each with a photo and a known-for line.

**Name path:**
1. She types a name. Spelling mistakes are fine.
2. **Everyone famous with that name**, for example:
   - Josh Allen, Bills QB
   - Josh Allen, Steelers pass rusher
   - Michael Jordan, NBA vs. Michael B. Jordan, actor
3. **Names that sound or look similar**, for example Will Ferrell, Colin Farrell, Will Forte. Ranked by how alike the names are and how famous the person is.

**Person page (where both paths end):**
- Photo and a "known for" line, e.g. "Drummer, Red Hot Chili Peppers" or "Nebraska volleyball outside hitter."
- **Often mistaken for:** hand-checked, well-documented mix-ups, both face pairs (Ferrell / Chad Smith, Bardem / Jeffrey Dean Morgan) and name pairs (Will Ferrell / Colin Farrell).
- **Similar faces:** shown when the person has a photo.
- **Similar names.**
- Every person in every list can be tapped to open their own page, so she can keep hopping until "THAT's who I was thinking of."

**Filters:** All / Movies & TV / Music / Pro sports / College / Nebraska. Lists favour people she has plausibly heard of. A "show lesser-known" switch shows everyone.

## How it works (technical)

### Repo
New public repo `bdn723/whos-that-face`, local folder `~/whos-that-face`. It gets its own CLAUDE.md and `docs/session_notes.md`, in the same style as the NFL project.

```
app/      index.html, app.js, face-search.js, name-search.js, sw.js (offline cache), manifest
shared/   face.js — detect, align, embed, quantize (same code in browser and build)
          names.js — normalize, phonetic keys, fuzzy score (same code in browser and build)
build/    sources/{wikidata,wikipedia}.js, merge.js, embed.js, pack.js, eval.js, coverage.js
data/     mistaken-for.json (face + name pairs, each with a source URL), overrides.json, eval-set.json
models/   YuNet + SFace .onnx files with their LICENSE files
.github/workflows/build.yml   monthly run + manual "Run workflow" button
```

### Face model
- Runtime: `onnxruntime-web@1.30.0`, WebAssembly backend, single-threaded. This keeps iPhone memory use safe and needs no special server headers.
- Face detector: OpenCV **YuNet** (`face_detection_yunet_2023mar.onnx`). MIT licence, 233 KB.
- Face fingerprint: OpenCV **SFace** (`face_recognition_sface_2021dec_int8.onnx`). Apache-2.0, 9.9 MB, 128 numbers per face.
- Each face is aligned to a 112×112 crop on 5 landmarks, then compared by cosine similarity.
- Rejected:
  - Human: its index would be too big.
  - face-api: archived.
  - InsightFace: its licence forbids this use.

### Name matching
Runs entirely on the phone. For each person, the build stores:
- a normalized name (lowercase, no accents or punctuation),
- Wikidata aliases and nicknames (e.g. "The Rock," "Shaq"),
- Double Metaphone sound-alike keys for each part of the name.

The search score combines:
- exact or prefix matches, ranked top,
- same-sounding first or last name,
- small spelling differences (Damerau–Levenshtein distance),
- a fame bonus.

Results are grouped into "Same name" and "Similar names."

### Who's in it
All data comes from Wikidata and Wikipedia, so there are no API keys or accounts.
- **Wikidata SPARQL**, one query per occupation or league, for people with an English Wikipedia article.
  - College uses team membership (P54) in Power-4 programs.
  - A photo (P18) is only needed for the face index.
- **Wikipedia Action API**, batched 20 at a time, for each person's short description, first sentence, Wikidata ID and 60-day pageviews.
- **Known-for line:** description plus notable works (P800), band, or team and position.
- **Wikimedia etiquette:** a User-Agent naming the repo, at most 2 downloads at a time, standard 500 px thumbnails.

### Fame rule
- Fame score = log10 of English Wikipedia 60-day pageviews.
- Default lists show people with roughly ≥1,500 views per 60 days, plus anyone tied to Nebraska.
- The name index uses a lower cutoff, so it is bigger.
- Face ranking = similarity + a small fame bonus (starting weight 0.02, tuned by the accuracy test).

### Build pipeline
Runs in GitHub Actions. The big index is never committed to git.
1. Collect people.
2. Merge duplicates by Wikidata ID.
3. Enrich with Wikipedia text and pageviews.
4. **Names:** compute normalized names and sound-alike keys. Write `names.json`, sorted for fast lookup.
5. **Faces:** download 1–2 Commons photos per person and keep the largest face. If two photos disagree (cosine < 0.3), drop the outlier.
6. Compute face vectors. They are cached as a GitHub Release asset, so monthly runs only process new photos.
7. Pack these files, all with content-hashed file names:

   | File | Contents | Size |
   |---|---|---|
   | `vectors.i8` | ~35k faces | ~4–6 MB |
   | `people.json` | everyone, ~60–80k | ~2–3 MB compressed |
   | `mistaken-for.json` | curated pairs | small |

8. Run the accuracy tests and the coverage report. The build fails if accuracy drops.
9. Deploy to GitHub Pages (`upload-pages-artifact` + `deploy-pages@v4`).

### App details
- **Loading:** the name path loads its small file first, so typing a name works within a second or two. The face model and face index load in the background and are only needed for photos.
- **Photo handling:** photos are decoded through `<img>` and a canvas so iPhone rotation is handled, then shrunk to ≤1280 px. If no face is found, the app retries at 90° turns.
- **Offline:** the first load is about 25–30 MB. A service worker caches it, so later opens are instant and work offline. If iOS clears the cache, the app downloads it again.
- **About page:** data credits (Wikipedia/Wikimedia, CC licences) and the model licences.

## Build order
Each step ends with something Ben can check.
0. **Feasibility check (one session):**
   - A test page with about 500 famous people, opened on Abby's iPhone.
   - Checks:
     - photo speed;
     - a Will Ferrell photo brings up Chad Smith;
     - typing "Josh Allen" shows both players;
     - typing "Will Farrel" finds both Ferrell and Colin Farrell.
   - **Go / no-go.**
1. **MVP:**
   - Coverage: actors/TV, musicians, hosts, NFL, and all Nebraska people.
   - Features: both ways in (photo and name), the person page, and the curated "often mistaken for" pairs.
   - Checks: accuracy tests and the coverage report.
   - Live on GitHub Pages.
2. **Expand:** NBA, MLB, NHL, soccer, Power-4 notables, the filter buttons, and the monthly automatic refresh.
3. **Polish:** self-hosted thumbnails (no hotlinking) and a small "how accurate is it" page.

## What Ben has to do
1. Approve folder access to `~/whos-that-face` when the app asks.
2. At step 0, open the test link on Abby's iPhone and tell me how it went.
3. When it's live, add it to Abby's home screen:
   1. On Abby's iPhone, open the link in **Safari**.
   2. Tap **Share** (the square with an arrow).
   3. Tap **Add to Home Screen**, then **Add**.
4. Optional, for a real-world test: take 20–30 iPhone photos of famous faces on the TV and AirDrop them to the Mac. I'll give exact steps.

## Verification
- **Face accuracy:**
  - 200 people across categories, each with a second Commons photo that isn't in the index.
  - Measures: right person first (top-1) and in the top 10, with 95% confidence intervals, overall and by category.
  - Also measured: how often curated face pairs appear in each other's top 10.
- **Name accuracy:** a test list of about 150 queries, checking that the intended person appears in the results.
  - Exact names.
  - Misspellings ("Will Farrel," "Patrik Mahomes").
  - Nicknames ("Shaq").
  - Shared names ("Josh Allen," "Chris Evans," "Michael Jordan").
  - Curated name pairs.
- **Real-world:** Ben's TV photos (optional step 4).
- **Technical:**
  - Compressed vs. full face vectors: the top-10 lists must overlap ≥98%.
  - The iPhone and the build must give the same result for the same photo (cosine ≥0.99).
- **Coverage report:** share of people with a usable photo and with an article, by category and for each Nebraska roster.
- **End-to-end on Abby's iPhone:**
  - Photo inputs: camera, camera roll, screenshot, a photo with several faces.
  - Name search: exact name and a misspelled name.
  - Tapping from list to list.
  - Reopening offline.

## Honest limits and risks
- **Coverage:** the photo side will be thin for Nebraska and college players. The name side covers anyone with a Wikipedia article. Players without an article are in neither (see Later idea 2).
- **Photos of a TV screen** may match less reliably than clean headshots. The step-0 check and the TV-photo test measure this, and the lookalike list still helps when the top match is wrong.
- **iPhone storage:** iOS may clear the cached files if the app goes unused for weeks. It re-downloads them automatically.
- **Made-up "mistaken for" pairs:** every pair needs a source URL, and the build checks that both names appear on that page.
- **Privacy:**
  - Only public figures with a Wikipedia article are included.
  - The app never searches the web for faces.
  - Her photo never leaves her phone.

## Later ideas (not in this plan)
1. **"Save this face":** once Abby works out who someone is, she can add them from her own photo. It is stored **only on her phone**.
2. **Nebraska roster names (text only)** from huskers.com, so every current Husker is in name search even without a Wikipedia article. Names and positions are public facts, not photos.
3. **Share-sheet button:** iOS doesn't allow this for websites. It would need a real App Store app.
