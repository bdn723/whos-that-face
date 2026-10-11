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

// Power-4 schools (2026 conference alignment) as [Wikipedia team name, short
// label, optional basketball category names where they differ]. Category names
// checked 11 Oct 2026.
const POWER4 = [
  // Big Ten
  ['Illinois Fighting Illini', 'Illinois'], ['Indiana Hoosiers', 'Indiana'], ['Iowa Hawkeyes', 'Iowa'],
  ['Maryland Terrapins', 'Maryland'], ['Michigan Wolverines', 'Michigan'], ['Michigan State Spartans', 'Michigan State'],
  ['Minnesota Golden Gophers', 'Minnesota'], ['Northwestern Wildcats', 'Northwestern'], ['Ohio State Buckeyes', 'Ohio State'],
  ['Oregon Ducks', 'Oregon'], ['Penn State Nittany Lions', 'Penn State', { mbb: 'Penn State Nittany Lions basketball', wbb: 'Penn State Lady Lions basketball' }],
  ['Purdue Boilermakers', 'Purdue'], ['Rutgers Scarlet Knights', 'Rutgers'], ['UCLA Bruins', 'UCLA'], ['USC Trojans', 'USC'],
  ['Washington Huskies', 'Washington'], ['Wisconsin Badgers', 'Wisconsin'],
  // SEC
  ['Alabama Crimson Tide', 'Alabama'], ['Arkansas Razorbacks', 'Arkansas'], ['Auburn Tigers', 'Auburn'], ['Florida Gators', 'Florida'],
  ['Georgia Bulldogs', 'Georgia', { mbb: 'Georgia Bulldogs basketball', wbb: 'Georgia Lady Bulldogs basketball' }],
  ['Kentucky Wildcats', 'Kentucky'], ['LSU Tigers', 'LSU'], ['Ole Miss Rebels', 'Ole Miss'], ['Mississippi State Bulldogs', 'Mississippi State'],
  ['Missouri Tigers', 'Missouri'], ['Oklahoma Sooners', 'Oklahoma'], ['South Carolina Gamecocks', 'South Carolina'],
  ['Tennessee Volunteers', 'Tennessee', { mbb: 'Tennessee Volunteers basketball', wbb: 'Tennessee Lady Volunteers basketball' }],
  ['Texas Longhorns', 'Texas'], ['Texas A&M Aggies', 'Texas A&M'], ['Vanderbilt Commodores', 'Vanderbilt'],
  // Big 12
  ['Arizona Wildcats', 'Arizona'], ['Arizona State Sun Devils', 'Arizona State'], ['Baylor Bears', 'Baylor'], ['BYU Cougars', 'BYU'],
  ['UCF Knights', 'UCF'], ['Cincinnati Bearcats', 'Cincinnati'], ['Colorado Buffaloes', 'Colorado'], ['Houston Cougars', 'Houston'],
  ['Iowa State Cyclones', 'Iowa State'], ['Kansas Jayhawks', 'Kansas'], ['Kansas State Wildcats', 'Kansas State'],
  ['Oklahoma State Cowboys', 'Oklahoma State', { mbb: 'Oklahoma State Cowboys basketball', wbb: 'Oklahoma State Cowgirls basketball' }],
  ['TCU Horned Frogs', 'TCU'], ['Texas Tech Red Raiders', 'Texas Tech', { mbb: 'Texas Tech Red Raiders basketball', wbb: 'Texas Tech Lady Raiders basketball' }],
  ['Utah Utes', 'Utah'], ['West Virginia Mountaineers', 'West Virginia'],
  // ACC (+ Notre Dame)
  ['Boston College Eagles', 'Boston College'], ['California Golden Bears', 'Cal'], ['Clemson Tigers', 'Clemson'], ['Duke Blue Devils', 'Duke'],
  ['Florida State Seminoles', 'Florida State'], ['Georgia Tech Yellow Jackets', 'Georgia Tech'], ['Louisville Cardinals', 'Louisville'],
  ['Miami Hurricanes', 'Miami'], ['NC State Wolfpack', 'NC State'], ['North Carolina Tar Heels', 'North Carolina'],
  ['Pittsburgh Panthers', 'Pitt'], ['SMU Mustangs', 'SMU'], ['Stanford Cardinal', 'Stanford'], ['Syracuse Orange', 'Syracuse'],
  ['Virginia Cavaliers', 'Virginia'], ['Virginia Tech Hokies', 'Virginia Tech'], ['Wake Forest Demon Deacons', 'Wake Forest'],
  ['Notre Dame Fighting Irish', 'Notre Dame'],
];
const COLLEGE_CATEGORIES = POWER4.flatMap(([team, short, alt = {}]) => {
  const mbb = alt.mbb || `${team} men's basketball`;
  const wbb = alt.wbb || `${team} women's basketball`;
  return [
    [`${team} football players`, `${short} football`],
    [`${team} football coaches`, `${short} football coach`],
    [`${mbb} players`, `${short} basketball`],
    [`${mbb} coaches`, `${short} basketball coach`],
    [`${wbb} players`, `${short} women's basketball`],
    [`${wbb} coaches`, `${short} women's basketball coach`],
  ];
});

// Each group: how to find candidates, which filter bits they get, and
// per-profile limits.
//   step0: `minSitelinks` trims the pool; `keep` = how many of the most-viewed to keep.
//   full:  `minViews60` = estimated views per 60 days needed to be included
//          (from sampled daily pageviews x 60).
export const GROUPS = [
  {
    key: 'screen', cat: CAT.screen,
    occupations: [OCC.actor, OCC.filmActor, OCC.tvActor, OCC.comedian, OCC.standUp],
    step0: { minSitelinks: 30, keep: 170 },
    full: { minViews60: 900 },
  },
  {
    key: 'hosts', cat: CAT.screen,
    occupations: [OCC.tvPresenter, OCC.talkShowHost, OCC.newsPresenter, OCC.sportsCommentator],
    step0: { minSitelinks: 15, keep: 40 },
    full: { minViews60: 900 },
  },
  {
    key: 'music', cat: CAT.music,
    occupations: [OCC.singer, OCC.musician, OCC.rapper, OCC.singerSongwriter, OCC.drummer, OCC.guitarist, OCC.bassist, OCC.countrySinger],
    step0: { minSitelinks: 30, keep: 110 },
    full: { minViews60: 900 },
  },
  { key: 'nfl', cat: CAT.pro, league: LEAGUE.NFL, sport: 'NFL', step0: { minSitelinks: 6, keep: 90 }, full: { minViews60: 600 } },
  { key: 'nba', cat: CAT.pro, league: LEAGUE.NBA, sport: 'NBA', step0: null, full: { minViews60: 600 } },
  { key: 'mlb', cat: CAT.pro, league: LEAGUE.MLB, sport: 'MLB', step0: null, full: { minViews60: 600 } },
  { key: 'nhl', cat: CAT.pro, league: LEAGUE.NHL, sport: 'NHL', step0: null, full: { minViews60: 600 } },
  { key: 'wnba', cat: CAT.pro, league: LEAGUE.WNBA, sport: 'WNBA', step0: null, full: { minViews60: 600 } },
  { key: 'epl', cat: CAT.pro, league: LEAGUE.PremierLeague, sport: 'Premier League', step0: null, full: { minViews60: 600 } },
  { key: 'usnt', cat: CAT.pro, teams: NATIONAL_TEAMS, sport: 'US Soccer', step0: null, full: { minViews60: 600 } },
  {
    key: 'college', cat: CAT.college,
    categories: COLLEGE_CATEGORIES,
    step0: null,
    full: { minViews60: 600 },
  },
  {
    key: 'nebraska', cat: CAT.college | CAT.nebraska,
    categories: NEBRASKA_CATEGORIES,
    labelledTeams: NEBRASKA_TEAMS,
    // Everyone tied to Nebraska is kept, whatever their pageviews.
    step0: { keep: Infinity },
    full: { minViews60: 0 },
  },
];

// Lead-text extracts (for the "known for" line) are fetched for this many of
// the most-viewed people, plus everyone tied to Nebraska; the rest use their
// Wikipedia short description.
export const EXTRACT_TOP = { step0: Infinity, full: 20000 };

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

// Fame: log10 of (estimated) 60-day English Wikipedia pageviews, mapped to 0..1.
export const fameScore = (views60) => Math.max(0, Math.min(1, (Math.log10(Math.max(1, views60)) - 2) / 4));
// Below this, people only show with "show lesser-known" (≈1,500 views / 60 days).
export const KNOWN_FAME = fameScore(1500);
