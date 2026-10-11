// Build the one-line "known for" text and chips for a person.

const MAX_LINE = 150;

function stripParens(s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/\s*\([^()]*\)/g, '');
  } while (s !== prev);
  return s.replace(/\s+/g, ' ').replace(/\s+([,.;])/g, '$1').trim();
}

// First sentence, without splitting on "Jr." or "U.S.".
export function firstSentence(text) {
  const t = stripParens(text || '');
  const m = t.match(/^(.*?[a-z\d)"”’]{2}\.)\s+(?=[A-Z"“])/);
  return (m ? m[1] : t).trim();
}

// "Chad Gaylord Smith is an American musician who ..." -> "American musician who ..."
export function predicate(sentence) {
  const m = sentence.match(/\b(?:is|was|are|were)\s+(?:an?\s+|the\s+)?(.+)$/);
  let s = (m ? m[1] : sentence).replace(/\.$/, '').trim();
  if (!s) return '';
  s = s[0].toUpperCase() + s.slice(1);
  if (s.length > MAX_LINE) {
    const cut = s.slice(0, MAX_LINE);
    const at = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf(' and '), cut.lastIndexOf(' who '));
    s = (at > 60 ? cut.slice(0, at) : cut.slice(0, cut.lastIndexOf(' '))) + '…';
  }
  return s;
}

export function cleanDescription(desc) {
  const d = stripParens(desc || '');
  return d ? d[0].toUpperCase() + d.slice(1) : '';
}

const SCREEN_WORDS = /\b(actor|actress|comedian|presenter|host|filmmaker|director|personality|anchor|broadcaster|commentator)\b/i;
const MUSIC_WORDS = /\b(singer|rapper|musician|drummer|guitarist|bassist|songwriter|band|composer|DJ|pianist|vocalist)\b/i;
const SPORT_WORDS = /\b(football|basketball|baseball|hockey|soccer|volleyball|coach|quarterback|player|athlete|pitcher|goalkeeper)\b/i;

// What the person is mainly known as, from their description.
export function primaryKind(desc, tags) {
  const d = desc || '';
  const order = [
    ['sport', SPORT_WORDS],
    ['music', MUSIC_WORDS],
    ['screen', SCREEN_WORDS],
  ].map(([k, re]) => [k, d.search(re)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  if (order.length) return order[0][0];
  if (tags.has('music')) return 'music';
  if (tags.has('screen') || tags.has('hosts')) return 'screen';
  return 'sport';
}

// Current team if they have one, else the team they spent longest with;
// prefer teams in the person's leagues.
function mainTeam(teams, leagues) {
  const inLeague = teams.filter((t) => t.league && leagues.has(t.league));
  const pool = inLeague.length ? inLeague : teams;
  if (!pool.length) return null;
  const current = pool.filter((t) => t.start && !t.end);
  if (current.length) return current.sort((a, b) => b.start.localeCompare(a.start))[0];
  const years = (t) => (t.start && t.end ? new Date(t.end) - new Date(t.start) : 0);
  return [...pool].sort((a, b) => years(b) - years(a))[0];
}

export function knownFor({ desc, extract, details, tags, leagues, labels }) {
  const line = predicate(firstSentence(extract)) || cleanDescription(desc);
  const kind = primaryKind(desc || line, tags);
  const lower = line.toLowerCase();
  const chips = [];
  const add = (s) => {
    if (s && !chips.includes(s) && !lower.includes(s.toLowerCase())) chips.push(s);
  };
  // College program labels ("Ohio State football"), Nebraska first.
  const sorted = [...(labels || [])].sort((a, b) => /nebraska/i.test(b) - /nebraska/i.test(a));
  for (const n of sorted.slice(0, 2)) add(n);
  if (kind === 'music') {
    for (const b of details.bands.slice(0, 1)) add(b.label);
  }
  if (kind === 'screen' || (kind !== 'music' && kind !== 'sport' && details.works.length)) {
    for (const w of details.works.slice(0, 3)) add(w.label);
  }
  // Team memberships on Wikidata are playing careers, so skip them for coaches.
  if (kind === 'sport' && !/\bcoach\b/i.test(line)) {
    const t = mainTeam(details.teams, leagues);
    // Skip the team if a college label already names it.
    const schools = (labels || []).map((l) => l.split(' ')[0].toLowerCase());
    if (t && !schools.some((w) => t.label.toLowerCase().includes(w))) add(t.label);
  }
  return { line, chips: chips.slice(0, 3), kind };
}
