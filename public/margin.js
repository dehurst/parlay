// How many points a bet is winning (+) or losing (-) by, for a score:
// { homeScore, awayScore }. A leg is { key: "gameId|market|side", point }.
// Used to grade final scores (server) and show live ones (page).
export function legMargin(leg, { homeScore: h, awayScore: a }) {
  const [, market, side] = leg.key.split('|');
  if (market === 'spread') return (side === 'home' ? h - a : a - h) + leg.point;
  if (market === 'total') return side === 'over' ? h + a - leg.point : leg.point - (h + a);
  return side === 'home' ? h - a : a - h;
}

// How one bet is doing at a live or final score `s` ({ state: 'in' | 'post',
// homeScore, awayScore, detail }): { cls, text }, or null before kickoff (and
// for player props, which aren't tracked live).
export function legStatus(l, s) {
  const [, market, side] = String(l.key ?? '').split('|');
  if (!['spread', 'total', 'ml'].includes(market)) return null;
  if (!s || s.state === 'pre') return null;
  const h = s.homeScore;
  const a = s.awayScore;
  const m = legMargin({ key: l.key, point: l.point ?? 0 }, { homeScore: h, awayScore: a });
  if (s.state === 'post') {
    return { cls: m > 0 ? 'win' : m < 0 ? 'loss' : 'push', text: `${m > 0 ? 'Won' : m < 0 ? 'Lost' : 'Push'} · final ${a}-${h}` };
  }
  const diff = side === 'home' ? h - a : a - h;
  const lead = diff > 0 ? `up ${diff}` : diff < 0 ? `down ${-diff}` : 'tied';
  const pts = h + a;
  let cls;
  let text;
  if (market === 'total' && side === 'over') {
    cls = m > 0 ? 'win' : 'behind';
    text = m > 0 ? `Hit · ${pts} pts` : `${pts} pts · needs ${Math.floor(-m) + 1} more`;
  } else if (market === 'total') {
    cls = m < 0 ? 'loss' : m > 0 ? 'ahead' : 'even';
    text = m < 0 ? `Busted · ${pts} pts` : m > 0 ? `${pts} pts · ${Math.ceil(m) - 1} to spare` : `${pts} pts · push right now`;
  } else if (market === 'spread') {
    cls = m > 0 ? 'ahead' : m < 0 ? 'behind' : 'even';
    text = `${m > 0 ? 'Covering' : m < 0 ? 'Not covering' : 'Push right now'} · ${lead}`;
  } else {
    cls = diff > 0 ? 'ahead' : diff < 0 ? 'behind' : 'even';
    text = diff > 0 ? `Winning · ${lead}` : diff < 0 ? `Losing · ${lead}` : 'Tied';
  }
  return { cls, text: `${text} · ${s.detail}` };
}
