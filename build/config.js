// Who goes into the index, and how many.
//
// Groups map to the app's filter buttons via CAT bits. A person can be in
// several groups (e.g. an actor who is also a singer).

export const CAT = { screen: 1, music: 2, pro: 4, college: 8, nebraska: 16 };

// Wikidata occupation IDs (checked 11 Oct 2026).
const OCC = {
  actor: 'Q33999',
  filmActor: 'Q10800557',
  tvActor: 'Q10798782',
  comedian: 'Q245068',
  standUp: 'Q18545066',
  tvPresenter: 'Q947873',
  talkShowHost: 'Q18668527',
  newsPresenter: 'Q270389',
  sportsCommentator: 'Q2986228',
  singer: 'Q177220',
  musician: 'Q639669',
  rapper: 'Q2252262',
  singerSongwriter: 'Q488205',
  drummer: 'Q386854',
  guitarist: 'Q855091',
  bassist: 'Q584301',
  countrySinger: 'Q66763708',
};

// Wikidata league / team IDs.
export const LEAGUE = {
  NFL: 'Q1215884',
  NBA: 'Q155223',
  MLB: 'Q1163715',
  NHL: 'Q1215892',
  WNBA: 'Q2593221',
  PremierLeague: 'Q9448',
};
const NATIONAL_TEAMS = ['Q164134', 'Q334526']; // US men's and women's soccer

const NEBRASKA_CATEGORIES = [
  ['Nebraska Cornhuskers football players', 'Nebraska football'],
  ['Nebraska Cornhuskers football coaches', 'Nebraska football coach'],
  ["Nebraska Cornhuskers men's basketball players", 'Nebraska basketball'],
  ["Nebraska Cornhuskers men's basketball coaches", 'Nebraska basketball coach'],
  ["Nebraska Cornhuskers women's basketball players", "Nebraska women's basketball"],
  ["Nebraska Cornhuskers women's basketball coaches", "Nebraska women's basketball coach"],
  ["Nebraska Cornhuskers women's volleyball players", 'Nebraska volleyball'],
  ["Nebraska Cornhuskers women's volleyball coaches", 'Nebraska volleyball coach'],
  ['Nebraska Cornhuskers football announcers', 'Nebraska football broadcaster'],
];
// Wikipedia's categories miss some people (e.g. Matt Rhule, Oct 2026), so
// Wikidata's team links (players and head coaches) are used as well.
const NEBRASKA_TEAMS = [
  ['Q6984693', 'Nebraska football'],
  ['Q6984696', 'Nebraska basketball'],
  ['Q6984699', "Nebraska women's basketball"],
  ['Q4005862', 'Nebraska volleyball'],
];

// Each group: how to find candidates, which filter bits they get, and
// per-profile limits. `minSitelinks` trims the candidate pool before the
// pageview lookup; `keep` is how many of the most-viewed to keep.
export const GROUPS = [
  {
    key: 'screen', cat: CAT.screen,
    occupations: [OCC.actor, OCC.filmActor, OCC.tvActor, OCC.comedian, OCC.standUp],
    step0: { minSitelinks: 30, keep: 170 },
  },
  {
    key: 'hosts', cat: CAT.screen,
    occupations: [OCC.tvPresenter, OCC.talkShowHost, OCC.newsPresenter, OCC.sportsCommentator],
    step0: { minSitelinks: 15, keep: 40 },
  },
  {
    key: 'music', cat: CAT.music,
    occupations: [OCC.singer, OCC.musician, OCC.rapper, OCC.singerSongwriter, OCC.drummer, OCC.guitarist, OCC.bassist, OCC.countrySinger],
    step0: { minSitelinks: 30, keep: 110 },
  },
  { key: 'nfl', cat: CAT.pro, league: LEAGUE.NFL, sport: 'NFL', step0: { minSitelinks: 6, keep: 90 } },
  { key: 'nba', cat: CAT.pro, league: LEAGUE.NBA, sport: 'NBA', step0: null },
  { key: 'mlb', cat: CAT.pro, league: LEAGUE.MLB, sport: 'MLB', step0: null },
  { key: 'nhl', cat: CAT.pro, league: LEAGUE.NHL, sport: 'NHL', step0: null },
  { key: 'wnba', cat: CAT.pro, league: LEAGUE.WNBA, sport: 'WNBA', step0: null },
  { key: 'epl', cat: CAT.pro, league: LEAGUE.PremierLeague, sport: 'Premier League', step0: null },
  { key: 'usnt', cat: CAT.pro, teams: NATIONAL_TEAMS, sport: 'US Soccer', step0: null },
  {
    key: 'nebraska', cat: CAT.college | CAT.nebraska,
    categories: NEBRASKA_CATEGORIES,
    labelledTeams: NEBRASKA_TEAMS,
    // Everyone tied to Nebraska is kept, whatever their pageviews.
    step0: { keep: Infinity },
  },
];

// Always included in the feasibility test: the test cases from the plan.
export const STEP0_FORCED = [
  'Will Ferrell', 'Chad Smith', 'Colin Farrell', 'Will Forte',
  'Javier Bardem', 'Jeffrey Dean Morgan', 'Isla Fisher', 'Amy Adams', 'Katy Perry', 'Zooey Deschanel',
  'Josh Allen', 'Josh Hines-Allen', 'Michael Jordan', 'Michael B. Jordan',
  'Chris Evans (actor)', 'Chris Evans (presenter)', 'Chris Pratt', 'Chris Pine', 'Chris Hemsworth',
  'Patrick Mahomes', 'Travis Kelce', 'Taylor Swift', 'Andy Reid',
  "Shaquille O'Neal", 'Dwayne Johnson', 'Matt Rhule', 'John Cook (coach)', 'Dani Busboom Kelly',
];

// People born before this are left out (portraits, paintings, silent film).
export const MIN_BIRTH_YEAR = 1900;

// Fame: log10 of 60-day English Wikipedia pageviews, mapped to 0..1.
export const fameScore = (views60) => Math.max(0, Math.min(1, (Math.log10(Math.max(1, views60)) - 2) / 4));
// Below this, people only show with "show lesser-known" (≈1,500 views / 60 days).
export const KNOWN_FAME = fameScore(1500);
