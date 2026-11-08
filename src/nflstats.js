// Reading nflverse's season stat files, shared by the site (this season's
// leaders) and scripts/build-honors.js (past seasons' league leaders).

// The stats that matter, as nflverse names them: [column, label, side].
export const STATS = [
  ['passing_yards', 'Pass yds', 'O'], ['passing_tds', 'Pass TD', 'O'], ['rushing_yards', 'Rush yds', 'O'], ['rushing_tds', 'Rush TD', 'O'],
  ['receptions', 'Rec', 'O'], ['receiving_yards', 'Rec yds', 'O'], ['receiving_tds', 'Rec TD', 'O'],
  ['tackles', 'Tackles', 'D'], ['def_sacks', 'Sacks', 'D'], ['def_tackles_for_loss', 'TFL', 'D'], ['def_interceptions', 'INT', 'D'],
  ['def_pass_defended', 'PD', 'D'], ['def_fumbles_forced', 'FF', 'D'],
];

// One CSV line, with quoted fields that may hold commas (nflverse's headshot links do).
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out;
}
export function parseCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = splitCsvLine(head);
  return lines.map((l) => Object.fromEntries(splitCsvLine(l).map((v, i) => [cols[i], v])));
}

// A season's stat lines -> [{ name, group, team, stats: { column: value } }].
export function parseStats(text) {
  return parseCsv(text).map((r) => ({
    name: r.player_display_name, group: r.position_group, team: r.recent_team,
    stats: Object.fromEntries(STATS.map(([k]) => [k, (k === 'tackles' ? Number(r.def_tackles_solo) + Number(r.def_tackle_assists) : Number(r[k])) || 0])),
  }));
}
// Offense, defense or special teams, from nflverse's position group.
export const sideOf = (group) => (['QB', 'RB', 'WR', 'TE', 'OL'].includes(group) ? 'O' : ['DL', 'LB', 'DB'].includes(group) ? 'D' : 'S');
