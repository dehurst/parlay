const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtOdds = (a) => (a > 0 ? `+${a}` : `${a}`);
const fmtPoint = (p) => (p > 0 ? `+${p}` : `${p}`);
const pct = (p) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
const money = (n) => `$${n.toFixed(2)}`;

const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

let me = storage.get('parlay.name');
let week = null;
// The week on screen: null for this week, else a past week's key (YYYY-MM-DD).
let viewKey = null;
const isPast = () => !!week?.past;
// Adds the viewed week to an API path (nothing for this week).
const withWeek = (path) => (viewKey ? `${path}${path.includes('?') ? '&' : '?'}week=${viewKey}` : path);
let statsScope = 'season'; // Stats tab: 'season' or 'week'
let tab = 'picks';
// Payout calculator: a scratch parlay that's never saved or shared.
let calc = false;
const calcKeys = new Set();
let calcStake = 10;


async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-group-code': storage.get('parlay.code') ?? '' },
    body: opts.body && JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    $('#code-row').hidden = false;
    showJoin();
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function notice(msg) {
  $('#notice').hidden = !msg;
  $('#notice').textContent = msg ?? '';
}

// ---- Loading -------------------------------------------------------------

async function load(refresh = false) {
  const params = new URLSearchParams();
  if (me) params.set('me', me);
  if (refresh) params.set('refresh', '1');
  if (viewKey) params.set('week', viewKey);
  try {
    week = await api(`/api/week?${params}`);
  } catch (err) {
    notice(err.message);
    return;
  }
  notice(week.warning);
  renderWeekNav();
  // Lines status under the picks hint, with the refresh button right next to
  // the time it would update.
  const time = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const canRefresh = week.book && !isPast();
  const details = [
    week.demo && 'Demo games',
    week.refreshesLeft != null && `${week.refreshesLeft} of ${week.refreshesPerDay} refreshes left today`,
    week.creditsLeft && `${week.creditsLeft} API credits left this month`,
  ].filter(Boolean).map(esc).join(' · ');
  $('#schedule-meta').innerHTML = `${canRefresh ? `<span class="lines-row">${week.linesUpdated
      ? `${esc(week.book)} lines from ${esc(time(week.linesUpdated))}` : `No ${esc(week.book)} lines yet`}
      <button id="refresh" class="refresh" type="button">↻ Refresh</button></span>` : ''}
    ${details ? `<span class="meta-details">${details}</span>` : ''}`;
  $('#schedule-meta').hidden = isPast();

  if (me && !week.players.includes(me)) me = null;
  if (!me) return showJoin();
  $('#join').hidden = true;
  $('#tabs').hidden = false;
  render();
}

// Header week switcher: ‹ older · pick any week · newer ›. Past weeks are
// read-only, with a banner to get back.
function renderWeekNav() {
  const list = week.weeks; // newest first
  const i = list.findIndex((w) => w.key === week.key);
  $('#week-select').innerHTML = list.map((w) =>
    `<option value="${esc(w.key)}" ${w.key === week.key ? 'selected' : ''}>${esc(w.label)}</option>`).join('');
  $('#week-select').disabled = list.length < 2;
  $('#week-prev').disabled = i < 0 || i >= list.length - 1;
  $('#week-next').disabled = i <= 0;
  $('#past-banner').hidden = !isPast();
  $('#past-banner').innerHTML = isPast() ? `<span>Looking back at <b>${esc(week.label)}</b>. Past weeks are view-only.</span>` : '';
  // Shortcut back to this week, next to the switcher.
  $('#back-to-now').hidden = !isPast();
  $('#back-to-now').textContent = `Back to ${list[0].label} →`;
}

function goWeek(key) {
  const current = week.weeks.find((w) => w.current)?.key;
  viewKey = !key || key === current ? null : key;
  calc = false;
  placingId = null;
  notice(null);
  load();
}

// Games that haven't kicked off: the only ones a pick can still be changed on.
const openGames = () => week.games.filter((g) => !g.started);
const isOpenPick = (key) => !gameOf(key)?.started;

function renderWho() {
  // Who you are, as a small chip; tap it to switch.
  $('#who').innerHTML = `<button class="me-chip" id="switch" type="button" title="Switch player">${esc(me)} <span class="muted">⇄</span></button>`;
}

async function clearPicks() {
  if (!confirm(`Clear all your picks for ${week.label}?`)) return;
  try {
    const res = await api('/api/picks', { method: 'DELETE', body: { name: me } });
    week.picks = res.picks;
    week.draft = null;
    notice(res.kept ? `Kept ${res.kept} pick${res.kept === 1 ? '' : 's'} on games that already started.` : null);
  } catch (err) {
    notice(err.message);
  }
  render();
}

function showJoin() {
  $('#join').hidden = false;
  $('#tabs').hidden = true;
  $('#submit-bar').hidden = true;
  $('#who').innerHTML = '';
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = true));
  $('#player-list').innerHTML = (week?.players ?? [])
    .map((p) => `<button type="button" data-name="${esc(p)}">${esc(p)}</button>`)
    .join('');
}

// ---- Pick helpers --------------------------------------------------------

const submittedPicks = () => week.picks[me] ?? null;
const hasSubmitted = () => !!submittedPicks();
// Submitted and not editing: picks are shown read-only.
const isLocked = () => hasSubmitted() && week.draft === null;
const isEditing = () => hasSubmitted() && week.draft !== null;
const gameOf = (key) => week.games.find((g) => g.id === key.split('|')[0]);
const marketOf = (key) => key.split('|').slice(0, 2).join('|');

// The sportsbook's current line for one side of a bet, if we have it.
function bookLine(key) {
  const [, market, side] = key.split('|');
  return gameOf(key)?.lines?.[market]?.[side] ?? null;
}
const sameLine = (a, b) => a && b && a.point === b.point && a.price === b.price;

// ---- Rendering -----------------------------------------------------------

function render() {
  renderWho();
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${tab}`));
  if (tab === 'picks') renderGames();
  else $('#submit-bar').hidden = true;
  if (tab === 'board') renderBoard();
  if (tab === 'parlays') renderParlays();
  if (tab === 'slip') renderSlip();
  if (tab === 'stats') renderStats();
}

// Grade a bet against a final score: 'win' | 'loss' | 'push' (same rules as
// the server's grading).
function gradeBet(key, point, { homeScore: h, awayScore: a }) {
  const [, market, side] = key.split('|');
  const diff = market === 'spread' ? (side === 'home' ? h - a : a - h) + point
    : market === 'total' ? (side === 'over' ? h + a - point : point - (h + a))
    : side === 'home' ? h - a : a - h;
  return diff > 0 ? 'win' : diff < 0 ? 'loss' : 'push';
}
const OTHER_SIDE = { home: 'away', away: 'home', over: 'under', under: 'over' };

// A game is over once its final score is in, or ~3½ hours after kickoff.
const isFinal = (g) => g.started && (!!g.result || Date.now() - new Date(g.commence) > 3.5 * 3600e3);

const rec = (r) => (r ? ` <span class="rec">(${esc(r)})</span>` : '');

function renderGames() {
  renderWho();
  $('#picks-mode').hidden = isPast();
  document.querySelectorAll('#picks-mode button').forEach((b) => b.classList.toggle('active', (b.dataset.mode === 'calc') === calc));
  const locked = isLocked() && !calc;
  const allStarted = !openGames().length;
  const n = submittedPicks()?.length ?? 0;
  $('#picks-hint').textContent = isPast()
    ? (n ? `Your ${n} pick${n === 1 ? '' : 's'} for ${week.label}, graded once each game finished.` : `You didn't submit picks for ${week.label}.`)
    : !calc && allStarted && hasSubmitted()
    ? `Every game this week has kicked off, so picks are locked. Next week's games show up Tuesday at 6 AM Eastern.`
    : calc
    ? `Tap any bets to see what a parlay would pay at ${week.book ?? 'the sportsbook'}'s current lines. Nothing is shared unless you hit Post, which adds it to the Parlays tab for others to join.`
    : locked
    ? `Your picks are in for ${week.label}. Tap Edit picks to change them before kickoff.`
    : isEditing()
      ? 'Editing your picks. Picks on games that already started are locked 🔒. Your submitted picks still count until you resubmit, and picks you keep stay at the line you got.'
      : `Tap a bet to select it at ${week.book ?? 'the sportsbook'}'s line, tap again to remove it. Hit Submit when you're done.`;

  if (!week.games.length) {
    $('#games').innerHTML = '<div class="card muted">No games on the schedule this week.</div>';
    renderSubmitBar();
    return;
  }
  // Picks on started games can't change, so they stay selected while editing.
  const startedPicks = (submittedPicks() ?? []).filter((p) => gameOf(p.key)?.started).map((p) => p.key);
  const mine = calc ? calcKeys : new Set(locked ? submittedPicks().map((p) => p.key) : [...(week.draft ?? []), ...startedPicks]);
  // Bets you already submitted show the line you got, not today's line.
  const savedLine = calc ? new Map() : new Map((submittedPicks() ?? []).filter((p) => mine.has(p.key)).map((p) => [p.key, p]));

  // Games that have kicked off go to a grayed-out section at the bottom.
  const gameCard = (g) => {
    // On finished games with a score, show how your picks did: won (green ✓),
    // lost (red ✗), push (gray P), and outline the side that won where you lost.
    const outcome = new Map();
    if (!calc && g.result) {
      for (const key of mine) {
        if (!key.startsWith(`${g.id}|`)) continue;
        const line = savedLine.get(key) ?? bookLine(key);
        if (!line) continue;
        const grade = gradeBet(key, line.point, g.result);
        outcome.set(key, grade);
        if (grade === 'loss') {
          const [, market, side] = key.split('|');
          outcome.set(`${g.id}|${market}|${OTHER_SIDE[side]}`, 'right');
        }
      }
    }
    const cell = (market, side) => {
      const key = `${g.id}|${market}|${side}`;
      const line = savedLine.get(key) ?? bookLine(key);
      const result = outcome.get(key);
      // While editing, picks on games that have started can't change: show a lock.
      const lockedPick = !calc && isEditing() && g.started && mine.has(key) && !result;
      const mark = lockedPick ? '🔒' : { win: '✓', loss: '✗', push: 'P', right: '✓' }[result];
      let label = market === 'ml' ? 'ML' : '–';
      if (line && market === 'spread') label = fmtPoint(line.point);
      if (line && market === 'total') label = `${side === 'over' ? 'O' : 'U'} ${line.point}`;
      const disabled = locked || g.started || !line;
      // Friends' picks aren't shown here, so everyone picks on their own.
      const titles = { win: 'Your pick won', loss: 'Your pick lost', push: 'Push', right: 'This side won' };
      return `<button class="pick ${mine.has(key) ? (calc ? 'on calc' : 'on') : ''} ${result ? `graded ${result}` : ''}" data-key="${esc(key)}" ${disabled ? 'disabled' : ''}
        ${result ? `title="${titles[result]}"` : lockedPick ? 'title="Game started, so this pick is locked"' : line ? '' : 'title="No line yet"'}>
        <span class="line">${esc(label)}</span>
        <span class="price">${line ? fmtOdds(line.price) : 'N/A'}</span>
        ${mark ? `<span class="mark-badge">${mark}</span>` : ''}
      </button>`;
    };
    const kick = new Date(g.commence).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const row = (team, side, totalSide) => `
      <div class="team" title="${esc(team)}">${esc(side === 'home' ? g.homeShort : g.awayShort)}</div>
      ${cell('spread', side)}${cell('total', totalSide)}${cell('ml', side)}`;
    const status = g.result
      ? `Final: ${esc(abbr(g.away))} ${g.result.awayScore}, ${esc(abbr(g.home))} ${g.result.homeScore}`
      // No score on file: a game runs about 3½ hours from kickoff.
      : Date.now() - new Date(g.commence) > 3.5 * 3600e3 ? 'Final' : '<span class="live">● Live</span>';
    return `<div class="card ${isFinal(g) ? 'done' : ''}" data-game="${esc(g.id)}">
      <div class="game-head">
        <h3>
          <span class="team-line">${esc(g.away)}${rec(g.awayRecord)} @</span>
          <span class="team-line">${esc(g.home)}${rec(g.homeRecord)}</span>
        </h3>
      </div>
      ${g.started ? `<div class="score small">${status}</div>` : ''}
      <div class="game-grid ${locked ? 'is-locked' : ''}">
        <div class="kick">${kick}</div>
        <div class="colhead">Spread</div><div class="colhead">Total</div><div class="colhead">Moneyline</div>
        ${row(g.away, 'away', 'over')}
        ${row(g.home, 'home', 'under')}
      </div>
    </div>`;
  };
  // Upcoming and live games stay on top in kickoff order; finished games
  // move to a grayed-out section below, most recent first.
  const current = week.games.filter((g) => !isFinal(g));
  const finished = week.games.filter(isFinal).sort((a, b) => b.commence.localeCompare(a.commence));
  $('#games').innerHTML = current.map(gameCard).join('')
    + (current.length ? '' : '<div class="card muted">Every game this week is over.</div>')
    + (finished.length ? `<h3 class="section">Completed games</h3>${finished.map(gameCard).join('')}` : '');
  renderSubmitBar();
}

function renderSubmitBar() {
  const bar = $('#submit-bar');
  bar.hidden = tab !== 'picks' || isPast();
  if (bar.hidden) return;
  if (calc) return renderCalcBar(bar);
  const plural = (n) => `${n} pick${n === 1 ? '' : 's'}`;
  if (isLocked()) {
    const day = copyDay();
    bar.innerHTML = `<span><b>${plural(submittedPicks().length)}</b> in</span>
      <span class="actions">
        ${day ? `<button type="button" id="copy-picks">Copy picks</button>` : ''}
        ${openGames().length ? '<button type="button" id="edit-picks">Edit picks</button>' : '<span class="small muted">🔒 Locked</span>'}
      </span>`;
    return;
  }
  const n = (week.draft ?? []).length;
  // Clearing only removes picks on games that haven't started, so only offer
  // it while picking and there's one of those (or a selection).
  const clearable = n > 0 || (submittedPicks() ?? []).some((p) => isOpenPick(p.key));
  bar.innerHTML = `<span>${n ? `<b>${n}</b> pick${n === 1 ? '' : 's'} selected` : 'No picks selected yet'}
      ${clearable ? '<button type="button" class="link small danger" id="clear-picks">Clear all</button>' : ''}</span>
    <span class="actions">
      ${isEditing() ? '<button type="button" id="cancel-edit">Cancel</button>' : ''}
      <button type="button" class="primary" id="submit-picks" ${n ? '' : 'disabled'}>${isEditing() ? 'Resubmit' : 'Submit picks'}</button>
    </span>`;
}

// ---- Payout calculator -----------------------------------------------------

const toDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
const toAmerican = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

function renderCalcBar(bar) {
  // Drop bets whose game started or whose line disappeared.
  for (const key of calcKeys) if (!bookLine(key) || gameOf(key)?.started) calcKeys.delete(key);
  const legs = [...calcKeys].map(bookLine);
  if (!legs.length) {
    bar.innerHTML = '<span class="muted">Tap bets to build a parlay</span>';
    return;
  }
  const decimal = legs.reduce((d, l) => d * toDecimal(l.price), 1);
  const games = new Set([...calcKeys].map((k) => k.split('|')[0]));
  const sameGame = games.size < calcKeys.size;
  const payout = calcStake * decimal;
  const canPost = legs.length >= 2 && !sameGame;
  bar.innerHTML = `<span class="calc-sum">
      <b>${legs.length === 1 ? 'Straight bet' : `${legs.length}-leg parlay`} ${fmtOdds(toAmerican(decimal))}</b>
      <span class="small">$${esc(calcStake)} pays <b>${money(payout)}</b> (profit ${money(payout - calcStake)})</span>
      ${sameGame ? '<span class="small warn-text">Same-game legs: FanDuel will pay a different amount, so this can’t be posted.</span>' : ''}
      <button type="button" class="link small" id="calc-clear">Clear</button>
    </span>
    <span class="actions">
      <label class="stake-box">$<input id="calc-stake" type="number" inputmode="decimal" min="1" step="1" value="${esc(calcStake)}"></label>
      <button type="button" class="primary" id="calc-post" ${canPost ? '' : 'disabled'}
        title="${canPost ? 'Post to the Parlays tab so others can join' : 'Needs 2+ legs from different games'}">Post</button>
    </span>`;
}

// Post the calculator's parlay to the Parlays tab with your stake.
async function postCustom() {
  try {
    const res = await api('/api/custom', { method: 'POST', body: { name: me, keys: [...calcKeys], amount: calcStake } });
    calcKeys.clear();
    calc = false;
    tab = 'parlays';
    render();
    notice(`Posted ${res.name}. Others can join it on the Parlays tab.`);
  } catch (err) {
    notice(err.message);
  }
}

function toggleCalc(key) {
  if (calcKeys.has(key)) calcKeys.delete(key);
  else {
    // One side per bet per game (can't have both Over and Under).
    for (const k of calcKeys) if (marketOf(k) === marketOf(key)) calcKeys.delete(k);
    calcKeys.add(key);
  }
  renderGames();
}

// ---- Copy picks as text ----------------------------------------------------

const ABBR = {
  cardinals: 'ARI', falcons: 'ATL', ravens: 'BAL', bills: 'BUF', panthers: 'CAR', bears: 'CHI',
  bengals: 'CIN', browns: 'CLE', cowboys: 'DAL', broncos: 'DEN', lions: 'DET', packers: 'GB',
  texans: 'HOU', colts: 'IND', jaguars: 'JAX', chiefs: 'KC', raiders: 'LV', chargers: 'LAC',
  rams: 'LAR', dolphins: 'MIA', vikings: 'MIN', patriots: 'NE', saints: 'NO', giants: 'NYG',
  jets: 'NYJ', eagles: 'PHI', steelers: 'PIT', '49ers': 'SF', seahawks: 'SEA', buccaneers: 'TB',
  titans: 'TEN', commanders: 'WAS',
};
const abbr = (team) => ABBR[team.split(' ').pop().toLowerCase()] ?? team.split(' ').pop();
const dayKey = (iso) => new Date(iso).toDateString();

// Which day's picks to copy: today if you have picks today, otherwise the next
// day you do (Saturday copies Sunday's), otherwise the most recent day.
function copyDay() {
  const picks = submittedPicks() ?? [];
  const days = [...new Set(picks.map((p) => gameOf(p.key)?.commence).filter(Boolean).sort().map(dayKey))];
  if (!days.length) return null;
  const today = new Date().toDateString();
  const upcoming = days.filter((d) => new Date(d) >= new Date(today));
  const day = upcoming[0] ?? days[days.length - 1];
  return { day };
}

// One bet as short text, like "KC -3.5", "GB/DET O 49.5", or "JAX ML".
function betText(key, point, away, home) {
  const [, market, side] = key.split('|');
  if (market === 'total') return `${abbr(away)}/${abbr(home)} ${side === 'over' ? 'O' : 'U'} ${point}`;
  const team = abbr(side === 'home' ? home : away);
  return market === 'ml' ? `${team} ML` : `${team} ${fmtPoint(point)}`;
}

function picksText(day) {
  return (submittedPicks() ?? [])
    .map((p) => ({ p, g: gameOf(p.key) }))
    .filter(({ g }) => g && dayKey(g.commence) === day)
    .sort((a, b) => a.g.commence.localeCompare(b.g.commence))
    .map(({ p, g }) => betText(p.key, p.point, g.away, g.home))
    .join('\n');
}

// A parlay's legs as text, in kickoff order. Legs carry their matchup
// ("Away @ Home"), so this works for past games too.
// Followed by the odds, the payout on $10, and (if anyone's in) the total
// bet and what it pays.
function parlayText(p) {
  const legs = [...p.legs]
    .sort((a, b) => (a.commence ?? '').localeCompare(b.commence ?? ''))
    .map((l) => {
      const [away, home] = l.matchup.split(' @ ');
      return betText(l.key, l.point, away, home);
    });
  const total = Object.values(p.stakes ?? {}).reduce((sum, amt) => sum + amt, 0);
  const real = p.placed?.payout ? payMultiplier(p) : null;
  const odds = real ? oddsFromMultiplier(real) : p.american;
  const mult = real ?? p.decimal;
  const lines = [...legs, '', `Odds: ${fmtOdds(odds)}`, `$10 pays ${money(10 * mult)}`];
  if (total > 0) lines.push(`Total bet: ${money(total)}, pays ${money(total * mult)}`);
  return lines.join('\n');
}

// What the parlay really pays per $1: the payout entered when it was placed,
// else the estimate from its legs' odds.
function payMultiplier(p) {
  const total = Object.values(p.stakes ?? {}).reduce((sum, amt) => sum + amt, 0);
  return p.placed?.payout && total > 0 ? p.placed.payout / total : p.decimal;
}
// FanDuel shows odds rounded toward zero (+301.6 -> +301).
const oddsFromMultiplier = (d) => (d >= 2 ? Math.trunc((d - 1) * 100) : Math.trunc(-100 / (d - 1)));

// Odds to show: what the sportsbook actually gave once a payout is entered.
const shownOdds = (p) => (p.placed?.payout ? oddsFromMultiplier(payMultiplier(p)) : p.american);

// Parlays on screen, by id, for their Copy buttons.
const copyable = new Map();
const copyButton = (p) => {
  copyable.set(p.id, p);
  return `<button type="button" class="copy-parlay" data-copy="${esc(p.id)}">Copy</button>`;
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers: copy through a hidden text box.
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.append(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  }
}

async function copyParlay(btn) {
  const parlay = copyable.get(btn.dataset.copy);
  if (!parlay) return;
  const ok = await copyText(parlayText(parlay));
  btn.textContent = ok ? 'Copied ✓' : "Couldn't copy";
  setTimeout(() => (btn.textContent = 'Copy'), 1800);
}

async function copyPicks(btn) {
  const day = copyDay();
  if (!day) return;
  const ok = await copyText(picksText(day.day));
  const label = btn.textContent;
  btn.textContent = ok ? 'Copied ✓' : "Couldn't copy";
  setTimeout(() => (btn.textContent = label), 1800);
}

async function startEditing() {
  const keys = submittedPicks().map((p) => p.key);
  try {
    week.draft = (await api('/api/draft', { method: 'PUT', body: { name: me, keys } })).draft;
  } catch (err) {
    notice(err.message);
  }
  renderGames();
}

async function cancelEditing() {
  try {
    week.draft = (await api('/api/draft', { method: 'DELETE', body: { name: me } })).draft;
  } catch (err) {
    notice(err.message);
  }
  renderGames();
}

async function toggle(key) {
  const draft = new Set(week.draft ?? []);
  if (draft.has(key)) {
    draft.delete(key);
  } else {
    // Only one side of a bet per game (can't take both Over and Under).
    for (const k of draft) if (marketOf(k) === marketOf(key)) draft.delete(k);
    draft.add(key);
  }
  week.draft = [...draft];
  renderGames(); // feels instant; the server confirms below
  try {
    week.draft = (await api('/api/draft', { method: 'PUT', body: { name: me, keys: week.draft } })).draft;
  } catch (err) {
    notice(err.message);
  }
  renderGames();
}

async function submit() {
  try {
    const res = await api('/api/submit', { method: 'POST', body: { name: me } });
    week.picks = res.picks;
    week.draft = null;
    if (res.dropped) notice(`${res.dropped} pick${res.dropped === 1 ? ' was' : 's were'} left out because the game already started.`);
  } catch (err) {
    notice(err.message);
  }
  renderGames();
}

// Note when the book's line has moved off the one the group took.
function lineMoved(s, book) {
  if (!s.current || sameLine(s.current, s)) return '';
  const pt = s.market === 'ml' ? '' : `${s.market === 'spread' ? fmtPoint(s.current.point) : s.current.point} `;
  return `<div class="lines">Line moved: ${esc(book)} now ${pt}${fmtOdds(s.current.price)}</div>`;
}

async function renderBoard() {
  $('#board').innerHTML = '<p class="muted">Loading…</p>';
  const data = await api(withWeek('/api/parlays')).catch((err) => (notice(err.message), null));
  if (!data) return;
  const done = Object.keys(week.picks);
  const waiting = week.players.filter((p) => !done.includes(p));
  const header = `<div class="card">
    <b>${done.length}</b> of ${week.players.length} have submitted.
    ${waiting.length ? `<span class="muted">${isPast() ? 'No picks from' : 'Waiting on'}: ${waiting.map(esc).join(', ')}</span>` : ''}
    ${done.length ? `<div class="small muted">A bet needs ${data.need}+ votes to count as consensus.</div>` : ''}
  </div>`;
  if (!data.tallied.length) {
    $('#board').innerHTML = header + `<div class="card muted">${isPast() ? `No picks were submitted for ${esc(week.label)}.` : 'No submitted picks yet this week.'}</div>`;
    return;
  }
  const rows = data.tallied.map((s) => `
    <div class="board-row">
      <div style="flex:1">
        <div><b>${esc(s.label)}</b> <span class="muted">${fmtOdds(s.price)}</span></div>
        <div class="small muted">${esc(s.matchup)} · ${s.pickers.map(esc).join(', ')}</div>
        ${lineMoved(s, data.book)}
        ${s.lines.length > 1 ? `<div class="lines">Submitted at different lines: ${s.lines.map((l) =>
          `${l.point === null ? '' : `${s.market === 'spread' ? fmtPoint(l.point) : l.point} `}${fmtOdds(l.price)} (${l.users.map(esc).join(', ')})`).join(' · ')}</div>` : ''}
        <div class="bar"><span style="width:${(s.pickers.length / data.voters) * 100}%"></span></div>
      </div>
      <div><b>${s.pickers.length}</b><span class="muted">/${data.voters}</span></div>
    </div>`).join('');
  $('#board').innerHTML = header + `<div class="card">${rows}</div>`;
}

// Stake box + who's in, shared by group and custom parlay cards.
function stakeHtml(p, closed) {
  const mine = p.stakes[me];
  const backers = Object.entries(p.stakes);
  const total = backers.reduce((sum, [, amt]) => sum + amt, 0);
  const form = p.placed
    ? `<p class="small"><span class="chip placed">✓ Placed</span> <span class="muted">by ${esc(p.placed.by)}, so stakes are locked.</span></p>`
    : closed
    ? '<p class="small muted">A game in this parlay has started, so it’s closed to new money.</p>'
    : `<form class="stake-form" data-parlay="${esc(p.id)}">
        <label>Your stake $
          <input name="amount" type="number" inputmode="decimal" min="0" step="1" value="${mine ?? ''}" placeholder="10">
        </label>
        <button type="submit" class="${mine ? '' : 'primary'}">${mine ? 'Update' : "I'm in"}</button>
        ${mine ? '<button type="button" class="link danger" data-act="out">Remove</button>' : ''}
      </form>`;
  return `${form}
    <div class="small muted backers">${backers.length
      ? `${backers.map(([who, amt]) => `${esc(who)} ${money(amt)}`).join(' · ')} · <b>${money(total)} total</b>, pays ${money(total * payMultiplier(p))}`
      : 'Nobody is in yet'}</div>`;
}

// Parlays with money on them whose games have started but aren't decided:
// legs that finished get a check or X; no more stakes can go in.
function inPlayHtml(data) {
  if (!data.inPlay?.length) return '';
  const cards = data.inPlay.map((p) => {
    const backers = Object.entries(p.stakes).map(([who, amt]) => `${esc(who)} ${money(amt)}`).join(' · ');
    return `<div class="card parlay ${p.custom ? 'custom' : ''}">
      <div class="head">
        <div>${p.placed ? '<span class="chip placed">✓ Placed</span>' : '<span class="chip pending">Not placed</span>'}
          <h3>${esc(p.name)}</h3><div class="small muted">${p.legs.length}-leg ${p.custom ? 'custom ' : ''}parlay</div></div>
        <div class="odds-col"><div class="odds">${fmtOdds(shownOdds(p))}</div>${copyButton(p)}</div>
      </div>
      <ul class="graded-legs">${p.legs.map((l) => `<li>${gradeMark(l.grade) || '<span class="mark">·</span>'}<b>${esc(l.label)}</b> <span class="muted">${fmtOdds(l.price)} · ${esc(l.matchup)}</span></li>`).join('')}</ul>
      <div class="small muted backers">${backers} · <b>${money(p.total)} bet</b>, pays ${money(p.payout)} if it hits</div>
    </div>`;
  }).join('');
  return `<h3 class="section">In play</h3>${cards}`;
}

// Parlays with money on them that are decided: result badge, leg marks,
// and what came back. Grayed out at the bottom of the Parlays tab.
function settledHtml(data) {
  if (!data.settled?.length) return '';
  const cards = data.settled.map((p) => {
    const backers = Object.entries(p.stakes).map(([who, amt]) => `${esc(who)} ${money(amt)}`).join(' · ');
    const back = p.status === 'won' ? `paid ${money(p.returned)}` : p.status === 'push' ? 'refunded' : 'paid $0.00';
    return `<div class="card parlay done ${p.status}">
      <div class="head">
        <div>${statusChip(p.status, p.returned, p.total)}<h3>${esc(p.name)}</h3><div class="small muted">${p.legs.length}-leg parlay</div></div>
        <div class="odds-col"><div class="odds">${fmtOdds(shownOdds(p))}</div>${copyButton(p)}</div>
      </div>
      <ul class="graded-legs">${p.legs.map((l) => `<li>${gradeMark(l.grade)}<b>${esc(l.label)}</b> <span class="muted">${fmtOdds(l.price)} · ${esc(l.matchup)}</span></li>`).join('')}</ul>
      <div class="small muted backers">${backers} · <b>${money(p.total)} bet</b>, ${back}</div>
    </div>`;
  }).join('');
  return `<h3 class="section">Completed</h3>${cards}`;
}

function customHtml(data) {
  const cards = data.custom.map((p) => `
    <div class="card parlay custom">
      <div class="head">
        <div><h3>${esc(p.name)}</h3><div class="small muted">${p.legs.length}-leg custom parlay</div></div>
        <div class="odds-col"><div class="odds">${fmtOdds(shownOdds(p))}</div>${copyButton(p)}</div>
      </div>
      <ul>${p.legs.map((l) => `<li><b>${esc(l.label)}</b> <span class="muted">${fmtOdds(l.price)} · ${esc(l.matchup)}</span>${lineMoved(l, data.book)}</li>`).join('')}</ul>
      <div class="stats"><span>$10.00 pays <b>${money(10 * p.decimal)}</b></span></div>
      ${stakeHtml(p, p.started)}
    </div>`).join('');
  return `<div class="section-head">
      <h3 class="section">Custom parlays</h3>
      <button type="button" class="primary" id="build-custom">+ Build your own</button>
    </div>
    ${cards || '<div class="card muted small">No open custom parlays right now. Build one with any bets you like, and the others can join in.</div>'}`;
}

async function renderParlays() {
  $('#parlays').innerHTML = '<p class="muted">Building…</p>';
  const data = await api(withWeek('/api/parlays')).catch((err) => (notice(err.message), null));
  if (!data) return;
  $('#parlays-hint').hidden = isPast();
  if (isPast()) {
    // A past week: just the parlays that had money on them, and how they did.
    const html = inPlayHtml(data) + settledHtml(data);
    $('#parlays').innerHTML = html || `<div class="card muted">Nobody put money on a parlay in ${esc(week.label)}.</div>`;
    return;
  }

  let html = customHtml(data) + inPlayHtml(data) + '<h3 class="section">Suggested parlays</h3>';
  if (!data.voters) {
    html += '<div class="card muted">Nobody has submitted picks yet.</div>';
  } else if (!data.options.length) {
    html += `<div class="card">
      <b>Not enough agreement yet.</b>
      <p class="muted">Parlays need at least 2 games where ${data.need}+ of the ${data.voters} who submitted agree.
      Right now there ${data.consensus.length === 1 ? 'is 1 such bet' : `are ${data.consensus.length}`}.</p>
    </div>`;
  }

  const majority = Math.floor(data.players.length / 2) + 1;
  html += data.options.map((p) => {
    const groupPick = Object.keys(p.stakes).length >= majority;
    return `
    <div class="card parlay ${groupPick ? 'group-pick' : ''}">
      <div class="head">
        <div>
          ${groupPick ? '<span class="badge">Group\'s pick</span>' : ''}
          <h3>${esc(p.name)}</h3><div class="small muted">${esc(p.blurb)}</div>
        </div>
        <div class="odds-col"><div class="odds">${fmtOdds(shownOdds(p))}</div>${copyButton(p)}</div>
      </div>
      <ul>${p.legs.map((l) => `<li><b>${esc(l.label)}</b> <span class="muted">${fmtOdds(l.price)} · ${esc(l.matchup)} · ${l.pickers.length}/${data.voters} picked</span>${lineMoved(l, data.book)}</li>`).join('')}</ul>
      <div class="stats">
        <span>${money(p.stake)} pays <b>${money(p.payout)}</b></span>
        <span>Hit chance ~<b>${pct(p.hitProb)}</b></span>
        <span class="${p.ev < 0 ? 'ev-bad' : ''}">Est. return ${p.ev >= 0 ? '+' : ''}${(p.ev * 100).toFixed(1)}%</span>
      </div>
      ${stakeHtml(p, false)}
    </div>`;
  }).join('');

  if (data.almost.length) {
    html += `<div class="card"><b>One vote away</b>
      <p class="small muted">These would join the consensus with one more pick:</p>
      <ul>${data.almost.map((s) => `<li>${esc(s.label)} <span class="muted">${fmtOdds(s.price)} · ${s.pickers.map(esc).join(', ')}</span></li>`).join('')}</ul>
    </div>`;
  }


  html += settledHtml(data);

  html += `<p class="small muted">Payouts use the lines at the time each pick was submitted${data.book ? `, which can drift from ${esc(data.book)}'s current lines` : ''}, so double-check them in your sportsbook before you bet.
    Hit chance is a rough estimate that removes a typical book margin. A negative expected return is the house edge,
    and parlays stack it on every leg.</p>`;
  $('#parlays').innerHTML = html;
}

const gradeMark = (g) => ({ win: '<span class="mark win">✓</span>', loss: '<span class="mark loss">✗</span>', push: '<span class="mark push">P</span>' })[g] ?? '';
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`;
const netClass = (n) => (n > 0.004 ? 'pos' : n < -0.004 ? 'neg' : '');

function statusChip(status, returned, total) {
  if (!status || status === 'pending') return '';
  const text = { won: `Won ${money(returned)}`, lost: 'Lost', push: 'Push (refunded)' }[status];
  return `<span class="chip ${status}">${text}</span>`;
}

function recordText(r) {
  const decided = r.win + r.loss;
  const pctText = decided ? ` (${Math.round((r.win / decided) * 100)}%)` : '';
  return `${r.win}-${r.loss}${r.push ? `-${r.push}` : ''}${pctText}`;
}

async function renderStats() {
  $('#stats').innerHTML = '<p class="muted">Loading…</p>';
  const byWeek = statsScope === 'week';
  const data = await api(byWeek ? `/api/stats?week=${week.key}` : '/api/stats').catch((err) => (notice(err.message), null));
  if (!data) return;
  // All season, or just the week picked in the header.
  const scope = `<div class="mode-switch" id="stats-scope">
      <button type="button" data-scope="season" class="${byWeek ? '' : 'active'}">All season</button>
      <button type="button" data-scope="week" class="${byWeek ? 'active' : ''}">${esc(week.label)}</button>
    </div>`;
  if (!data.weeks.length) {
    $('#stats').innerHTML = scope + `<div class="card muted">${byWeek
      ? `Nothing to show for ${esc(week.label)} yet: no picks or parlays.`
      : 'No history yet. Stats show up once games people picked have finished.'}</div>`;
    return;
  }
  const pr = data.parlays;
  const people = [...data.players].sort((a, b) => b.net - a.net);
  const money_ = `<div class="card"><h3>${byWeek ? `${esc(week.label)} money` : 'Season money'}</h3>
    <p class="small muted">Parlays you put money on that have been decided. Net = paid back minus staked.</p>
    <table class="slip">
      <thead><tr><th>Who</th><th class="num">Staked</th><th class="num">Paid back</th><th class="num">Net</th></tr></thead>
      <tbody>${people.map((p) => `<tr><td>${esc(p.name)}${p.inPlay ? `<div class="small muted">${money(p.inPlay)} in play</div>` : ''}</td>
        <td class="num">${money(p.staked)}</td><td class="num">${money(p.returned)}</td>
        <td class="num ${netClass(p.net)}">${signed(p.net)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th>Group</th><th class="num">${money(pr.staked)}</th><th class="num">${money(pr.returned)}</th>
        <th class="num ${netClass(pr.net)}">${signed(pr.net)}</th></tr></tfoot>
    </table></div>`;

  const parlayCard = `<div class="card"><h3>Group parlays</h3>
    <div class="statline">
      <div><b>${pr.won}-${pr.lost}${pr.push ? `-${pr.push}` : ''}</b><span>record</span></div>
      <div><b>${pr.won + pr.lost ? Math.round((pr.won / (pr.won + pr.lost)) * 100) : 0}%</b><span>hit rate</span></div>
      <div><b class="${netClass(pr.net)}">${signed(pr.net)}</b><span>net</span></div>
      ${pr.pending ? `<div><b>${pr.pending}</b><span>still live</span></div>` : ''}
    </div></div>`;

  const c = data.consensus;
  const winPct = (r) => (r.win + r.loss ? r.win / (r.win + r.loss) : 0);
  // Everyone's picks added together.
  const addUp = (get) => data.players.reduce((t, p) => {
    const r = get(p);
    return { win: t.win + r.win, loss: t.loss + r.loss, push: t.push + r.push };
  }, { win: 0, loss: 0, push: 0 });
  const all = addUp((p) => p.picks);
  const sumRec = (m) => addUp((p) => p.byMarket[m]);
  const allNet = data.players.reduce((t, p) => t + p.flatNet, 0);
  const wlp = (r) => `<td class="num">${r.win}</td><td class="num">${r.loss}</td><td class="num">${r.push}</td>`;
  const picksCard = `<div class="card"><h3>Pick records</h3>
    <p class="small muted">Every submitted pick, graded win, loss, or push. "$10 a pick" is what you'd be up or down betting $10 on each one by itself.</p>
    <table class="slip">
      <thead><tr><th>Who</th><th class="num">W</th><th class="num">L</th><th class="num">P</th><th class="num">$10 a pick</th></tr></thead>
      <tbody>${[...data.players].sort((a, b) => winPct(b.picks) - winPct(a.picks) || b.picks.win - a.picks.win).map((p) => `<tr>
        <td>${esc(p.name)}<div class="small muted">ATS ${recordText(p.byMarket.spread)} · Totals ${recordText(p.byMarket.total)} · ML ${recordText(p.byMarket.ml)}</div></td>
        ${wlp(p.picks)}<td class="num ${netClass(p.flatNet)}">${signed(p.flatNet)}</td></tr>`).join('')}</tbody>
      <tfoot>
        <tr><th>All of us<div class="small muted">ATS ${recordText(sumRec('spread'))} · Totals ${recordText(sumRec('total'))} · ML ${recordText(sumRec('ml'))}</div></th>
          ${wlp(all)}<th class="num ${netClass(allNet)}">${signed(allNet)}</th></tr>
        <tr><th>Group consensus<div class="small muted">Bets most of you agreed on</div></th>${wlp(c)}<th class="num ${netClass(c.flatNet)}">${signed(c.flatNet)}</th></tr>
      </tfoot>
    </table></div>`;

  const weeks = data.weeks.map((w, i) => {
    const parlays = w.parlays.map((p) => `<div class="hist-parlay">
        <div class="head"><b>${esc(p.name)} ${fmtOdds(p.american)}</b> ${statusChip(p.status, p.returned, p.total) || '<span class="chip pending">Live</span>'}</div>
        <ul>${p.legs.map((l) => `<li>${gradeMark(l.grade)}${esc(l.label)} <span class="muted">${fmtOdds(l.price)}</span></li>`).join('')}</ul>
        <div class="small muted">${Object.entries(p.stakes).map(([who, amt]) => `${esc(who)} ${money(amt)}`).join(' · ')} · ${money(p.total)} total</div>
      </div>`).join('') || '<p class="small muted">No parlays placed.</p>';
    const picks = Object.entries(w.picks).map(([who, rows]) => `<div class="hist-picks"><b>${esc(who)}</b>
        <ul>${rows.map((r) => `<li>${gradeMark(r.grade)}${esc(r.label)} <span class="muted">${fmtOdds(r.price)}</span></li>`).join('')}</ul></div>`).join('');
    return `<details class="card week" ${i === 0 ? 'open' : ''}>
      <summary><b>${esc(w.label)}</b> <span class="muted small">${w.parlays.length} parlay${w.parlays.length === 1 ? '' : 's'}</span>
        <span class="num ${netClass(w.net)}">${w.parlays.some((p) => p.status !== 'pending') ? signed(w.net) : ''}</span></summary>
      <h4>Parlays</h4>${parlays}
      <h4>Picks</h4><div class="hist-grid">${picks || '<p class="small muted">No picks submitted.</p>'}</div>
    </details>`;
  }).join('');

  $('#stats').innerHTML = scope + parlayCard + money_ + picksCard
    + `<h3 class="section">${byWeek ? 'Picks and parlays' : 'Week by week'}</h3>` + weeks;
}

let placingId = null; // Bet Slip parlay whose payout box is open

async function renderSlip() {
  $('#slip').innerHTML = '<p class="muted">Loading…</p>';
  const data = await api(withWeek('/api/slip')).catch((err) => (notice(err.message), null));
  if (!data) return;
  const past = isPast();
  if (!data.parlays.length) {
    $('#slip').innerHTML = `<div class="card muted">${past
      ? `Nobody put money on a parlay in ${esc(week.label)}.`
      : 'Nobody has put money on a parlay yet. Do that on the Parlays tab.'}</div>`;
    return;
  }
  const grand = data.parlays.reduce((sum, p) => sum + p.total, 0);
  // Parlays still in play (to place, or placed and waiting on games) stay on
  // top; finished ones move to a grayed-out section at the bottom.
  const active = data.parlays.filter((p) => p.status === 'pending');
  const finished = data.parlays.filter((p) => p.status !== 'pending');
  const toPlace = active.filter((p) => !p.placed);
  const left = toPlace.reduce((sum, p) => sum + p.total, 0);
  // Winnings (or push refunds) not yet paid out, by person. Each person's
  // share is proportional to their stake.
  const owed = {};
  for (const p of finished) {
    if (!['won', 'push'].includes(p.status) || p.paidOut) continue;
    for (const [who, amt] of Object.entries(p.stakes)) owed[who] = (owed[who] ?? 0) + (p.returned * amt) / p.total;
  }
  const owedTotal = Object.values(owed).reduce((a, b) => a + b, 0);
  const at = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const card = (p, i) => {
    const legs = p.legs.map((l) => `<li>${gradeMark(l.grade)}<b>${esc(l.label)}</b> <span class="muted">${fmtOdds(l.price)} · ${esc(l.matchup)}</span>${l.grade === 'pending' ? lineMoved(l, data.book) : ''}</li>`).join('');
    const rows = Object.entries(p.stakes).map(([who, amt]) => `<tr>
        <td>${esc(who)}${who === me && !p.placed && !past ? ` <button type="button" class="link danger" data-slip-out="${esc(p.id)}">remove</button>` : ''}</td>
        <td class="num">${money(amt)}</td><td class="num">${money(amt * p.decimal)}</td></tr>`).join('');
    return `<div class="card parlay ${p.placed ? 'placed' : ''} ${p.status !== 'pending' ? `done ${p.status}` : ''}">
      <div class="head">
        <div><span class="muted small">Bet ${i + 1}</span> ${p.placed ? '<span class="chip placed">✓ Placed</span>' : ''} ${statusChip(p.status, p.returned, p.total)} ${p.paidOut ? '<span class="chip paid">💵 Paid out</span>' : ''}<h3>${esc(p.name)} · ${p.legs.length}-leg parlay</h3></div>
        <div class="odds-col"><div class="odds">${fmtOdds(shownOdds(p))}</div>${copyButton(p)}</div>
      </div>
      ${p.stillOption || p.placed || past ? '' : '<div class="lines">Picks changed since people bought in, so this parlay is no longer one of the current options. Double-check before placing it.</div>'}
      <ul>${legs}</ul>
      <table class="slip">
        <thead><tr><th>Who</th><th class="num">Stake</th><th class="num">Wins</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${money(p.total)}</th><th class="num">${money(p.payout)}</th></tr></tfoot>
      </table>
      <div class="place-row">
        ${past
          ? `<span class="small muted">${p.placed
              ? `Placed by ${esc(p.placed.by)} ${esc(at(p.placed.at))}.${p.placed.payout ? ` ${esc(data.book ?? 'Sportsbook')} payout: ${money(p.placed.payout)}.` : ''}`
              : 'Never marked placed.'}</span>`
          : placingId === p.id
          ? `<form class="payout-form" data-id="${esc(p.id)}">
               <label>${esc(data.book ?? 'Sportsbook')} total payout $
                 <input name="payout" type="number" inputmode="decimal" step="0.01" min="0" value="${(p.placed?.payout ?? p.estimate).toFixed(2)}"></label>
               <button type="submit" class="primary">Save</button>
               <button type="button" class="link" data-act="cancel-place">Cancel</button>
               <p class="small muted">The payout ${esc(data.book ?? 'the sportsbook')} shows for the whole bet, stake included.
                 The site estimated ${money(p.estimate)}${p.legs.some((l) => l.current && !sameLine(l.current, l)) ? ' (some lines have moved since)' : ''}.</p>
             </form>`
          : p.placed
          ? `<span class="small muted">Placed by ${esc(p.placed.by)} ${esc(at(p.placed.at))}. Stakes are locked.
               ${p.placed.payout ? `<br>${esc(data.book ?? 'Sportsbook')} pays <b>${money(p.placed.payout)}</b>${Math.abs(p.placed.payout - p.estimate) >= 0.01 ? ` (site estimated ${money(p.estimate)})` : ''}.` : ''}</span>
             <button type="button" class="link" data-edit-payout="${esc(p.id)}">${p.placed.payout ? 'Edit payout' : 'Add payout'}</button>
             <button type="button" class="link" data-place="${esc(p.id)}" data-val="0">Undo</button>`
          : `<button type="button" class="primary" data-edit-payout="${esc(p.id)}">Mark placed</button>
             <span class="small muted">Tap after you've placed it at ${esc(data.book ?? 'the sportsbook')}.</span>`}
      </div>
      ${['won', 'push'].includes(p.status) ? `<div class="place-row">
        ${p.paidOut
          ? `<span class="small muted">Paid out by ${esc(p.paidOut.by)} ${esc(at(p.paidOut.at))}.</span>
             <button type="button" class="link" data-paid="${esc(p.id)}" data-val="0">Not paid yet</button>`
          : `<button type="button" class="primary" data-paid="${esc(p.id)}" data-val="1">Mark paid out</button>
             <span class="small muted">Tap after everyone's been paid their ${p.status === 'push' ? 'refund' : 'winnings'}.</span>`}
      </div>` : ''}
    </div>`;
  };
  const cards = active.map((p, i) => card(p, i)).join('')
    + (finished.length ? `<h3 class="section">Completed</h3>${finished.map((p, i) => card(p, active.length + i)).join('')}` : '');
  const totals = Object.entries(data.totals).map(([who, amt]) => `<tr><td>${esc(who)}</td><td class="num">${money(amt)}</td></tr>`).join('');
  $('#slip').innerHTML = `
    <div class="card"><b>${past ? `${esc(week.label)} bet slip` : toPlace.length
        ? `${toPlace.length} parlay${toPlace.length === 1 ? '' : 's'} left to place, ${money(left)}.`
        : active.length ? `All placed ✓ · ${active.length} still in play` : 'All parlays are settled.'}</b>
      <span class="small muted">${data.parlays.length} ${past ? 'that week' : 'this week'}, ${money(grand)} total${finished.length ? `, ${finished.length} settled` : ''}.</span>
      ${owedTotal > 0.004 ? `<div class="owed"><b>To pay out: ${money(owedTotal)}</b> <span class="small">(${Object.entries(owed).map(([who, amt]) => `${esc(who)} ${money(amt)}`).join(', ')})</span></div>` : ''}
      ${past ? '' : `<div class="small muted">"Wins" is the total payout (stake included) if the parlay hits, at the odds shown.
      Check each leg in ${esc(data.book ?? 'your sportsbook')} before placing; anything marked "Line moved" will pay differently.</div>`}
    </div>
    ${cards}
    <div class="card"><b>Who owes what</b>
      <table class="slip"><tbody>${totals}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${money(grand)}</th></tr></tfoot></table>
    </div>`;
}

// ---- Events --------------------------------------------------------------

$('#games').addEventListener('click', (e) => {
  const btn = e.target.closest('.pick');
  if (btn && !btn.disabled) (calc ? toggleCalc : toggle)(btn.dataset.key);
});
$('#tab-picks').addEventListener('click', (e) => {
  const mode = e.target.closest('.mode-switch button')?.dataset.mode;
  if (!mode) return;
  calc = mode === 'calc';
  renderGames();
});
$('#submit-bar').addEventListener('input', (e) => {
  if (e.target.id !== 'calc-stake') return;
  const v = Number(e.target.value);
  if (!(v > 0)) return;
  calcStake = Math.round(v * 100) / 100;
  // Update the numbers without re-rendering the input (keeps the keyboard up).
  const legs = [...calcKeys].map(bookLine);
  const decimal = legs.reduce((d, l) => d * toDecimal(l.price), 1);
  const line = document.querySelector('.calc-sum .small');
  if (line) line.innerHTML = `$${esc(calcStake)} pays <b>${money(calcStake * decimal)}</b> (profit ${money(calcStake * decimal - calcStake)})`;
});
$('#submit-bar').addEventListener('click', (e) => {
  if (e.target.closest('#submit-picks')) submit();
  if (e.target.closest('#edit-picks')) startEditing();
  if (e.target.closest('#copy-picks')) copyPicks(e.target.closest('#copy-picks'));
  if (e.target.closest('#calc-clear')) {
    calcKeys.clear();
    renderGames();
  }
  if (e.target.closest('#calc-post')) postCustom();
  if (e.target.closest('#cancel-edit')) cancelEditing();
  if (e.target.closest('#clear-picks')) clearPicks();
  const go = e.target.closest('[data-tab-go]')?.dataset.tabGo;
  if (go) {
    tab = go;
    render();
  }
});
$('#week-prev').addEventListener('click', () => {
  const i = week.weeks.findIndex((w) => w.key === week.key);
  if (week.weeks[i + 1]) goWeek(week.weeks[i + 1].key);
});
$('#week-next').addEventListener('click', () => {
  const i = week.weeks.findIndex((w) => w.key === week.key);
  if (i > 0) goWeek(week.weeks[i - 1].key);
});
$('#week-select').addEventListener('change', (e) => goWeek(e.target.value));
$('#back-to-now').addEventListener('click', () => goWeek(null));
$('#stats').addEventListener('click', (e) => {
  const scope = e.target.closest('[data-scope]')?.dataset.scope;
  if (!scope || scope === statsScope) return;
  statsScope = scope;
  renderStats();
});
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  tab = btn.dataset.tab;
  render();
});
$('#player-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-name]');
  if (!btn) return;
  me = btn.dataset.name;
  storage.set('parlay.name', me);
  load();
});
$('#code-save').addEventListener('click', () => {
  storage.set('parlay.code', $('#group-code').value.trim());
  $('#code-row').hidden = true;
  load();
});
async function setStake(id, amount, rerender) {
  try {
    await api('/api/stake', { method: 'POST', body: { name: me, id, amount } });
    notice(null);
  } catch (err) {
    notice(err.message);
  }
  rerender();
}
$('#parlays').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = Number(e.target.amount.value);
  if (!(amount > 0)) return notice('Enter how many dollars you want on it.');
  setStake(e.target.dataset.parlay, amount, renderParlays);
});
for (const el of ['#parlays', '#slip']) {
  $(el).addEventListener('click', (e) => {
    const btn = e.target.closest('.copy-parlay');
    if (btn) copyParlay(btn);
  });
}
$('#parlays').addEventListener('click', (e) => {
  if (e.target.closest('#build-custom')) {
    tab = 'picks';
    calc = true;
    render();
    notice('Tap the bets you want, set your stake in the bar at the bottom, then hit Post.');
    window.scrollTo(0, 0);
    return;
  }
  if (e.target.closest('[data-act="out"]')) setStake(e.target.closest('form').dataset.parlay, 0, renderParlays);
});
$('#slip').addEventListener('submit', async (e) => {
  const form = e.target.closest('.payout-form');
  if (!form) return;
  e.preventDefault();
  try {
    await api('/api/placed', { method: 'POST', body: { name: me, id: form.dataset.id, placed: true, payout: form.payout.value } });
    placingId = null;
    notice(null);
  } catch (err) {
    notice(err.message);
  }
  renderSlip();
});
$('#slip').addEventListener('click', async (e) => {
  const paid = e.target.closest('[data-paid]');
  if (paid) {
    paid.disabled = true;
    try {
      await api('/api/paidout', { method: 'POST', body: { name: me, id: paid.dataset.paid, paid: paid.dataset.val === '1', week: viewKey } });
    } catch (err) {
      notice(err.message);
    }
    renderSlip();
    return;
  }
  const open = e.target.closest('[data-edit-payout]');
  if (open) {
    placingId = open.dataset.editPayout;
    await renderSlip();
    $('.payout-form input')?.select();
    return;
  }
  if (e.target.closest('[data-act="cancel-place"]')) {
    placingId = null;
    renderSlip();
    return;
  }
  const place = e.target.closest('[data-place]');
  if (place) {
    place.disabled = true;
    try {
      await api('/api/placed', { method: 'POST', body: { name: me, id: place.dataset.place, placed: place.dataset.val === '1' } });
    } catch (err) {
      notice(err.message);
    }
    renderSlip();
    return;
  }
  const btn = e.target.closest('[data-slip-out]');
  if (btn) setStake(btn.dataset.slipOut, 0, renderSlip);
});
$('#who').addEventListener('click', (e) => {
  if (e.target.closest('#switch')) {
    me = null;
    storage.del('parlay.name');
    showJoin();
  }
});
const limitText = () =>
  `You've used today's ${week.refreshesPerDay} line refreshes (that keeps you under the free 500 API credits a month). Showing lines from ${new Date(week.linesUpdated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Refreshes reset at midnight Eastern.`;

$('#schedule-meta').addEventListener('click', async (e) => {
  const btn = e.target.closest('#refresh');
  if (!btn) return;
  if (week?.refreshesLeft === 0) return notice(limitText());
  const wait = (week?.nextRefreshAt ?? 0) - Date.now();
  if (wait > 0) {
    const ago = Math.max(1, Math.round((Date.now() - week.linesUpdated) / 60e3));
    notice(`Lines were just updated ${ago} min ago. You can refresh again in ${Math.ceil(wait / 60e3)} min.`);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  await load(true); // re-draws the button
  if (week?.limitHit) notice(limitText());
});

load();
