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
// Which league the site is showing: 'nfl' or 'cfb' (college, Power 5).
// Each has its own weeks, picks, parlays, and stats.
let league = storage.get('parlay.sport') === 'cfb' ? 'cfb' : 'nfl';
let week = null;
// The week on screen: null for this week, else a past week's key (YYYY-MM-DD).
let viewKey = null;
const isPast = () => !!week?.past;
// Adds the viewed week to an API path (nothing for this week).
const withWeek = (path) => (viewKey ? `${path}${path.includes('?') ? '&' : '?'}week=${viewKey}` : path);
let statsScope = 'week'; // Stats tab: 'week' (the one picked up top) or 'season'
let tab = 'picks';
// Payout calculator: a scratch parlay that's never saved or shared.
let calc = false;
const calcKeys = new Set();
// Copy & edit: the parlay the builder started from ({ id, name }), if any.
let calcFrom = null;
// Likes on parlays and dislikes on legs this week (from /api/parlays).
let reactions = { parlays: {}, parlayDowns: {}, legs: {} };
let calcStake = 10;


async function api(path, opts = {}) {
  const sentFor = league;
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-group-code': storage.get('parlay.code') ?? '', 'x-sport': league },
    body: opts.body && JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  // Switched leagues while this was loading: drop it, so the other league's
  // data never lands on screen (the switch already loaded the new league).
  if (sentFor !== league) return new Promise(() => {});
  if (res.status === 401 && data.login && !path.startsWith('/api/login')) {
    showLogin();
    throw new Error('Please log in.');
  }
  if (res.status === 401 && !data.login) {
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
    addTeams(week.teams ?? {});
  } catch (err) {
    if ($('#login').hidden) notice(err.message); // the login screen speaks for itself
    return;
  }
  $('#week-nav').hidden = $('#sport-switch').hidden = false;
  notice(week.authMissing
    ? 'Logins aren’t turned on yet: add LOGINS in Vercel’s settings (see the README). Until then anyone with the link can get in.'
    : week.warning);
  // Logged in: the server says who you are.
  if (week.auth) {
    me = week.me;
    storage.set('parlay.name', me);
  }
  $('#login').hidden = true;
  renderWeekNav();
  // Lines status under the picks hint, with the refresh button right next to
  // the time it would update.
  const time = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const hour = (t) => new Date(t).toLocaleString([], { hour: 'numeric', minute: '2-digit' });
  // "next at 6:00 PM" today, else "next Sun 11:00 AM"
  const next = (t) => (new Date(t).toDateString() === new Date().toDateString() ? `next at ${hour(t)}` : `next ${time(t)}`);
  const live = week.book && !isPast();
  const details = [
    week.demo && 'Demo games',
    live && week.props && (week.propsUpdated ? `Props from ${time(week.propsUpdated)}` : 'No props yet')
      + (week.propsPaused ? ' (paused to save API credits)' : week.nextPropsAt ? `, ${next(week.nextPropsAt)}` : ''),
    week.creditsLeft != null && `${week.creditsLeft} API credits left this month`,
  ].filter(Boolean).map(esc).join(' · ');
  // Lines update on their own at 11 AM and 6 PM; Sundays add a couple of
  // manual refreshes for late news.
  $('#schedule-meta').innerHTML = `${live ? `<span class="lines-row">${week.linesUpdated
      ? `${esc(week.book)} lines from ${esc(time(week.linesUpdated))}` : `No ${esc(week.book)} lines yet`}${week.nextLinesAt ? `, ${esc(next(week.nextLinesAt))}` : ''}
      ${week.manualLeft > 0 ? `<button id="refresh" class="refresh" type="button">↻ Refresh (${week.manualLeft} left)</button>` : ''}</span>` : ''}
    ${details ? `<span class="meta-details">${details}</span>` : ''}`;
  $('#schedule-meta').hidden = isPast();

  if (me && !week.players.includes(me)) me = null;
  if (!me) return showJoin();
  $('#join').hidden = true;
  $('#tabs').hidden = false;
  render();
}

// NFL | CFB switch under the week. Switching shows that league's current week.
function renderLeague() {
  document.querySelectorAll('#sport-switch button').forEach((b) => b.classList.toggle('active', b.dataset.sport === league));
  $('#league-name').textContent = league.toUpperCase();
  // The heat map is NFL only for now.
  $('#tabs [data-tab="heatmap"]').hidden = league !== 'nfl';
  if (league !== 'nfl' && tab === 'heatmap') tab = 'picks';
}

function switchLeague(next) {
  if (next === league) return;
  league = next;
  storage.set('parlay.sport', league);
  researchTeam = storage.get(teamStorageKey());
  compareA = compareB = null;
  viewKey = null;
  statsScope = 'week';
  calc = false;
  calcKeys.clear();
  calcFrom = null;
  placingId = null;
  renamingId = null;
  notice(null);
  renderLeague();
  // Clear the last league's games while the new one loads.
  document.querySelectorAll('main .tab > div:not(.mode-switch)').forEach((d) => (d.innerHTML = ''));
  load();
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
  statsScope = 'week'; // Stats follow the week you switched to
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
  // With logins it's a log out button; without, tap to switch player.
  $('#who').innerHTML = week.auth
    ? `<span class="me-chip static">${esc(me)}</span><button class="link small" id="logout" type="button">Log out</button>`
    : `<button class="me-chip" id="switch" type="button" title="Switch player">${esc(me)} <span class="muted">⇄</span></button>`;
}

async function clearPicks() {
  if (!confirm(`Clear all your picks for ${week.label}?`)) return;
  try {
    const res = await api('/api/picks', { method: 'DELETE', body: { name: me } });
    week.picks = res.picks;
    week.draft = null;
    week.draftLocks = [];
    notice(res.kept ? `Kept ${res.kept} pick${res.kept === 1 ? '' : 's'} on games that already started.` : null);
  } catch (err) {
    notice(err.message);
  }
  render();
}

function showLogin() {
  me = null;
  $('#login').hidden = false;
  $('#join').hidden = true;
  $('#tabs').hidden = true;
  $('#submit-bar').hidden = true;
  $('#past-banner').hidden = true;
  $('#week-nav').hidden = $('#sport-switch').hidden = true;
  $('#who').innerHTML = '';
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = true));
  setTimeout(() => $('#login-form [name=username]')?.focus(), 0);
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
  const game = gameOf(key);
  return isPropMarket(market) ? propLine(game?.props, market, side) : game?.lines?.[market]?.[side] ?? null;
}

// ---- Player props ------------------------------------------------------------
// Keys look like "gameId|td:Travis Kelce|yes" (anytime TD) and
// "gameId|ptd:Patrick Mahomes|over" (passing TDs), same as the server.

const isPropMarket = (m) => String(m).includes(':');
function propParts(market) {
  const i = market.indexOf(':');
  return { type: market.slice(0, i), player: market.slice(i + 1) };
}
const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;
// "Kenneth Walker III" -> "K. Walker"
function shortName(player) {
  const parts = player.trim().split(/\s+/).filter((p) => !SUFFIX.test(p));
  return parts.length < 2 ? player : `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}
const normName = (p) => p.toLowerCase().split(/\s+/).filter((x) => !SUFFIX.test(x)).join('').replace(/[^a-z]/g, '');
// "C. McCaffrey TD", "P. Mahomes o1.5 pass TDs"
function propText(market, side, point) {
  const { type, player } = propParts(market);
  return type === 'td' ? `${shortName(player)} TD` : `${shortName(player)} ${side === 'over' ? 'o' : 'u'}${point} pass TDs`;
}
function propLine(props, market, side) {
  if (!props) return null;
  const { type, player } = propParts(market);
  if (type === 'td') {
    const p = props.td?.find((x) => x.player === player);
    return p && side === 'yes' ? { point: null, price: p.price } : null;
  }
  const p = props.ptd?.find((x) => x.player === player);
  return p?.[side] != null ? { point: p.point, price: p[side] } : null;
}
// Grade a prop from the game's player stats (null until they're in).
function gradeProp(market, side, point, players) {
  if (!players) return null;
  const { type, player } = propParts(market);
  const row = players[normName(player)];
  if (!row) return 'push'; // didn't play: void
  if (type === 'td') return row.td > 0 ? 'win' : 'loss';
  const diff = side === 'over' ? row.passTd - point : point - row.passTd;
  return diff > 0 ? 'win' : diff < 0 ? 'loss' : 'push';
}
// Which games' props sections are open, and which show every TD scorer.
const openProps = new Set();
const allScorers = new Set();
const TOP_SCORERS = 8;
const sameLine = (a, b) => a && b && a.point === b.point && a.price === b.price;

// ---- Locks -------------------------------------------------------------------
// A lock is a pick you're sure of. It doesn't change the bet; it's tracked so
// Bet Stats can show how everyone does on the picks they were certain about.

// Your locks on screen: what you're editing (plus started picks you'd locked),
// else what you submitted.
function myLocks() {
  const picks = submittedPicks() ?? [];
  if (isLocked() || isPast()) return new Set(picks.filter((p) => p.locked).map((p) => p.key));
  const started = picks.filter((p) => p.locked && gameOf(p.key)?.started).map((p) => p.key);
  return new Set([...(week.draftLocks ?? []), ...started]);
}
const isLockedBy = (who, key) => !!week.picks[who]?.find((p) => p.key === key)?.locked;
let justLocked = null; // the lock that just snapped shut, to animate it once

// A padlock: closed and gold (shining, with sparkles) or open and plain.
function lockIcon(closed) {
  const shackle = closed ? 'M7.5 11V8a4.5 4.5 0 0 1 9 0v3' : 'M7.5 11V8a4.5 4.5 0 0 1 8.7-1.6';
  const body = '<rect x="4.5" y="10.5" width="15" height="11" rx="2.5"/>';
  if (!closed) {
    return `<svg class="lock-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path d="${shackle}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
      <g fill="none" stroke="currentColor" stroke-width="2">${body}</g></svg>`;
  }
  return `<svg class="lock-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path class="shackle" d="${shackle}" fill="none" stroke="url(#gold)" stroke-width="2.6" stroke-linecap="round"/>
      <g fill="url(#gold)" stroke="#7a4d00" stroke-width=".6">${body}</g>
      <g fill="url(#gold-shine)">${body}</g>
      <circle cx="12" cy="15.2" r="1.5" fill="#6b4300"/><rect x="11.35" y="15.5" width="1.3" height="3" rx=".65" fill="#6b4300"/>
    </svg>
    <span class="sparkle s1">✦</span><span class="sparkle s2">✦</span><span class="sparkle s3">✦</span>`;
}

// The sound of a padlock snapping shut (or a heavy bolt sliding back to
// open), made on the fly so there's no audio file to load.
let audio = null;
function lockSound(closing) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    playLockSound(audio, closing);
  } catch {
    // No sound support: the lock still works.
  }
}

function playLockSound(ctx, closing) {
  const t = ctx.currentTime + 0.01;
  // The snap plays as is. The bolt goes through a limiter, plus a short echo
  // like a concrete cell block.
  const out = ctx.createDynamicsCompressor();
  out.threshold.value = -12;
  out.ratio.value = 8;
  const master = ctx.createGain();
  master.gain.value = 0.6; // the limiter adds gain of its own; this keeps it from distorting
  out.connect(master).connect(ctx.destination);
  const hall = ctx.createConvolver();
  const tail = Math.ceil(ctx.sampleRate * 2.2);
  const echo = ctx.createBuffer(2, tail, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = echo.getChannelData(c);
    for (let i = 0; i < tail; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / tail) ** 3;
  }
  hall.buffer = echo;
  const wet = ctx.createGain();
  wet.gain.value = 0.15;
  hall.connect(wet).connect(out);
  const bus = ctx.createGain();
  if (closing) bus.connect(ctx.destination);
  else {
    bus.connect(out);
    bus.connect(hall);
  }

  // A burst of filtered noise: dies away, or (swell) builds up to its end.
  const noise = (at, len, type, freq, q, gain, swell = false) => {
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * len), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const x = i / d.length;
      d[i] = (Math.random() * 2 - 1) * (swell ? x * x : (1 - x) ** 4);
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(bus);
    src.start(at);
  };
  // A tone that slides and fades: the low boom, or the iron ringing.
  const tone = (at, from, to, gain, len, type = 'sine') => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, at);
    o.frequency.exponentialRampToValueAtTime(to, at + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(bus);
    o.start(at);
    o.stop(at + len);
  };

  if (closing) {
    noise(t, 0.025, 'bandpass', 2200, 2.5, 0.35); // shackle sliding in
    noise(t + 0.065, 0.04, 'bandpass', 4200, 2.5, 1.1); // the snap
    noise(t + 0.068, 0.05, 'bandpass', 1500, 2.5, 0.9);
    tone(t + 0.065, 190, 90, 0.35, 0.09); // thump
    tone(t + 0.066, 3150, 3100, 0.05, 0.16); // ring
    tone(t + 0.066, 4730, 4700, 0.03, 0.12);
  } else {
    noise(t, 0.22, 'bandpass', 650, 2, 0.4, true); // a heavy bolt sliding back
    noise(t + 0.22, 0.06, 'bandpass', 1300, 3, 0.45);
    tone(t + 0.22, 110, 70, 0.35, 0.16);
  }
}

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
  if (tab === 'analysis') renderAnalysis();
  if (tab === 'research') renderResearch();
  if (tab === 'heatmap') renderHeatmap();
}

// Grade a bet against a final score: 'win' | 'loss' | 'push' (same rules as
// the server's grading).
function gradeBet(key, point, { homeScore: h, awayScore: a, players }) {
  const [, market, side] = key.split('|');
  if (isPropMarket(market)) return gradeProp(market, side, point, players);
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
    : calc && calcFrom
    ? 'Swap or drop legs below, or tap any bet to add it. Post saves it as your own parlay; the original stays as is.'
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
  const locks = calc ? new Set() : myLocks();

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
        if (!grade) continue; // a prop whose stats aren't in yet
        outcome.set(key, grade);
        if (grade === 'loss' && OTHER_SIDE[key.split('|')[2]]) {
          const [, market, side] = key.split('|');
          outcome.set(`${g.id}|${market}|${OTHER_SIDE[side]}`, 'right');
        }
      }
    }
    // One bet button. `label` is the top line.
    const pickButton = (key, label) => {
      const line = savedLine.get(key) ?? bookLine(key);
      const result = outcome.get(key);
      // While editing, picks on games that have started can't change: show a lock.
      const lockedPick = !calc && isEditing() && g.started && mine.has(key) && !result;
      const mark = lockedPick ? '🔒' : { win: '✓', loss: '✗', push: 'P', right: '✓' }[result];
      const disabled = locked || g.started || !line;
      // Friends' picks aren't shown here, so everyone picks on their own.
      const titles = { win: 'Your pick won', loss: 'Your pick lost', push: 'Push', right: 'This side won' };
      // Your picks get a padlock: tap it to make the pick a lock (you're sure
      // of it). It can change until kickoff, while you can edit picks.
      const sure = !calc && mine.has(key) && locks.has(key);
      const canLock = !calc && mine.has(key) && !disabled;
      const lockHtml = sure || canLock
        ? `<span class="lock-toggle ${sure ? 'closed' : 'open'} ${sure && justLocked === key ? 'snap' : ''}" ${canLock ? `role="button" tabindex="0" data-lock="${esc(key)}"` : ''}
            title="${sure ? (canLock ? 'Locked pick. Tap to unlock' : 'Locked pick') : 'Tap to make this a locked pick'}"
            aria-label="${sure ? 'Locked pick' : 'Make this a locked pick'}">${lockIcon(sure)}</span>`
        : '';
      return `<button class="pick ${mine.has(key) ? (calc ? 'on calc' : 'on') : ''} ${sure ? 'sure' : ''} ${result ? `graded ${result}` : ''}" data-key="${esc(key)}" ${disabled ? 'disabled' : ''}
        ${result ? `title="${titles[result]}"` : lockedPick ? 'title="Game started, so this pick is locked"' : line ? '' : 'title="No line yet"'}>
        <span class="line">${esc(label)}</span>
        <span class="price">${line ? fmtOdds(line.price) : 'N/A'}</span>
        ${mark ? `<span class="mark-badge">${mark}</span>` : ''}
        ${lockHtml}
      </button>`;
    };
    const cell = (market, side) => {
      const key = `${g.id}|${market}|${side}`;
      const line = savedLine.get(key) ?? bookLine(key);
      let label = market === 'ml' ? 'ML' : '–';
      if (line && market === 'spread') label = fmtPoint(line.point);
      if (line && market === 'total') label = `${side === 'over' ? 'O' : 'U'} ${line.point}`;
      return pickButton(key, label);
    };
    // Player props, tucked under the game: passing TDs (over/under) for each
    // QB, then anytime TD scorers, likeliest first. Shown while the game is
    // open, or afterwards if you picked one (to see how it did).
    const myProps = [...mine].filter((k) => k.startsWith(`${g.id}|`) && isPropMarket(k.split('|')[1]));
    const props = g.props ?? { td: [], ptd: [] };
    let propsHtml = '';
    if ((!g.started && (props.td.length || props.ptd.length)) || myProps.length) {
      // After kickoff, only the props you picked.
      const keep = (key) => !g.started || myProps.includes(key);
      const ptdRows = props.ptd.filter((q) => keep(`${g.id}|ptd:${q.player}|over`) || keep(`${g.id}|ptd:${q.player}|under`)).map((q) => `
        <div class="prop-name">${esc(shortName(q.player))}</div>
        ${pickButton(`${g.id}|ptd:${q.player}|over`, `O ${q.point}`)}${pickButton(`${g.id}|ptd:${q.player}|under`, `U ${q.point}`)}`).join('');
      const scorers = props.td.filter((t) => keep(`${g.id}|td:${t.player}|yes`));
      const showAll = allScorers.has(g.id) || g.started;
      // Always show the ones you picked, even past the top 8.
      const shown = showAll ? scorers : scorers.filter((t, i) => i < TOP_SCORERS || mine.has(`${g.id}|td:${t.player}|yes`));
      const tdHtml = shown.map((t) => pickButton(`${g.id}|td:${t.player}|yes`, shortName(t.player))).join('');
      // Your picks on props the feed no longer lists.
      const listed = (k) => props.td.some((t) => k === `${g.id}|td:${t.player}|yes`) || props.ptd.some((q) => k.startsWith(`${g.id}|ptd:${q.player}|`));
      const orphans = myProps.filter((k) => !listed(k))
        .map((k) => pickButton(k, propText(k.split('|')[1], k.split('|')[2], savedLine.get(k)?.point))).join('');
      const open = openProps.has(g.id) || (g.started && myProps.length);
      propsHtml = `<details class="props" data-props="${esc(g.id)}" ${open ? 'open' : ''}>
        <summary>Player props${myProps.length ? ` <span class="chip tag">${myProps.length} picked</span>` : ''}</summary>
        ${ptdRows ? `<div class="colhead props-head">Passing TDs</div><div class="ptd-grid">${ptdRows}</div>` : ''}
        ${tdHtml ? `<div class="colhead props-head">Anytime TD</div><div class="td-grid">${tdHtml}</div>` : ''}
        ${!showAll && scorers.length > shown.length ? `<button type="button" class="link small show-all" data-all-td="${esc(g.id)}">Show all ${scorers.length} players</button>` : ''}
        ${orphans ? `<div class="td-grid">${orphans}</div>` : ''}
      </details>`;
    }
    // Props for this week loaded, but none for this game yet.
    else if (!g.started && week.propsUpdated && !isPast()) {
      propsHtml = '<div class="props props-none small muted">Player props: not posted yet. Checked again every few hours until kickoff.</div>';
    }
    const kick = new Date(g.commence).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const row = (team, side, totalSide) => `
      <div class="team" title="${esc(team)}">${teamLogo(team, 'small')}<span>${esc(side === 'home' ? g.homeShort : g.awayShort)}</span></div>
      ${cell('spread', side)}${cell('total', totalSide)}${cell('ml', side)}`;
    const status = g.result
      ? `Final: ${teamLogo(g.away, 'small')}${esc(abbr(g.away))} ${g.result.awayScore}, ${teamLogo(g.home, 'small')}${esc(abbr(g.home))} ${g.result.homeScore}`
      // No score on file: a game runs about 3½ hours from kickoff.
      : Date.now() - new Date(g.commence) > 3.5 * 3600e3 ? 'Final' : '<span class="live">● Live</span>';
    return `<div class="card ${isFinal(g) ? 'done' : ''}" data-game="${esc(g.id)}">
      <div class="game-head">
        <h3>
          <span class="team-line">${teamLogo(g.away)}${esc(g.away)}${rec(g.awayRecord)} @</span>
          <span class="team-line">${teamLogo(g.home)}${esc(g.home)}${rec(g.homeRecord)}</span>
        </h3>
      </div>
      ${g.started ? `<div class="score small">${status}</div>` : ''}
      <div class="game-grid ${locked ? 'is-locked' : ''}">
        <div class="kick">${kick}</div>
        <div class="colhead">Spread</div><div class="colhead">Total</div><div class="colhead">Moneyline</div>
        ${row(g.away, 'away', 'over')}
        ${row(g.home, 'home', 'under')}
      </div>
      ${propsHtml}
    </div>`;
  };
  // Upcoming and live games stay on top in kickoff order; finished games
  // move to a grayed-out section below, most recent first.
  const current = week.games.filter((g) => !isFinal(g));
  const finished = week.games.filter(isFinal).sort((a, b) => b.commence.localeCompare(a.commence));
  $('#games').innerHTML = (calc ? builderHtml() : '') + current.map(gameCard).join('')
    + (current.length ? '' : '<div class="card muted">Every game this week is over.</div>')
    + (finished.length ? `<h3 class="section">Completed games</h3>${finished.map(gameCard).join('')}` : '');
  justLocked = null; // the snap plays once
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
  // Same-game legs are allowed (say Over + Packers -3), except the spread and
  // moneyline from one game together, which FanDuel won't take.
  const conflict = [...games].some((id) => [...calcKeys].some((k) => k.startsWith(`${id}|spread|`)) && [...calcKeys].some((k) => k.startsWith(`${id}|ml|`)));
  const payout = calcStake * decimal;
  const canPost = legs.length >= 1 && !conflict;
  bar.innerHTML = `<span class="calc-sum">
      <b>${legs.length === 1 ? 'Straight bet' : `${legs.length}-leg parlay`} ${fmtOdds(toAmerican(decimal))}</b>
      <span class="small">$${esc(calcStake)} pays <b>${money(payout)}</b> (profit ${money(payout - calcStake)})</span>
      ${conflict ? '<span class="small warn-text">Can’t combine the spread and moneyline from the same game.</span>'
        : sameGame ? '<span class="small warn-text">Same-game parlay: FanDuel prices these together, so its payout will differ. Enter its payout when you mark it placed.</span>' : ''}
      <button type="button" class="link small" id="calc-clear">Clear</button>
    </span>
    <span class="actions">
      <label class="stake-box">$<input id="calc-stake" type="number" inputmode="decimal" min="1" step="1" value="${esc(calcStake)}"></label>
      <button type="button" class="primary" id="calc-post" ${canPost ? '' : 'disabled'}
        title="${canPost ? 'Post to the Parlays tab so others can join' : 'Can’t combine the spread and moneyline from the same game'}">Post</button>
    </span>`;
}

// Post the calculator's parlay to the Parlays tab with your stake.
async function postCustom() {
  try {
    const res = await api('/api/custom', { method: 'POST', body: { name: me, keys: [...calcKeys], amount: calcStake, from: calcFrom?.name } });
    calcKeys.clear();
    calcFrom = null;
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

// ---- Build a parlay: swap or drop legs -------------------------------------

// Chance a bet wins from the book's prices on both sides, with its cut
// removed (same as the Analysis tab).
function chanceOf(key) {
  const [gameId, market, side] = key.split('|');
  // Props too: passing TDs have both sides; anytime TD only has "yes".
  const mine = bookLine(key);
  const other = OTHER_SIDE[side] ? bookLine(`${gameId}|${market}|${OTHER_SIDE[side]}`) : null;
  const implied = (a) => 1 / toDecimal(a);
  if (mine && other) return implied(mine.price) / (implied(mine.price) + implied(other.price));
  return mine ? Math.min(0.99, implied(mine.price) / 1.045) : null;
}

// "Colts -3", "Over 47.5", "Colts ML" at the book's current line.
function keyLabel(key) {
  const g = gameOf(key);
  const [, market, side] = key.split('|');
  const line = bookLine(key);
  if (isPropMarket(market)) return propText(market, side, line?.point);
  if (market === 'total') return `${side === 'over' ? 'Over' : 'Under'} ${line?.point}`;
  const team = side === 'home' ? g.homeShort : g.awayShort;
  return market === 'ml' ? `${team} ML` : `${team} ${fmtPoint(line?.point)}`;
}

// Hit chance and payout (at your stake) for a set of bets.
function priceKeys(keys) {
  let chance = 1;
  let decimal = 1;
  for (const k of keys) {
    chance *= chanceOf(k) ?? 0.5;
    decimal *= toDecimal(bookLine(k).price);
  }
  return { chance, payout: calcStake * decimal };
}

// The other way to back the same team: spread <-> moneyline (totals have none).
function swapFor(key) {
  const [gameId, market, side] = key.split('|');
  if (market !== 'spread' && market !== 'ml') return null; // totals and props have none
  const alt = `${gameId}|${market === 'ml' ? 'spread' : 'ml'}|${side}`;
  return !calcKeys.has(alt) && bookLine(alt) ? alt : null;
}

// The box at the top of Build a parlay: each leg with its win chance, then a
// swap (same team the other way) and Drop, each showing what the parlay
// would become.
function builderHtml() {
  for (const key of calcKeys) if (!bookLine(key) || gameOf(key)?.started) calcKeys.delete(key);
  if (!calcKeys.size) return '';
  const keys = [...calcKeys].sort((a, b) => gameOf(a).commence.localeCompare(gameOf(b).commence));
  const result = (set) => {
    const r = priceKeys(set);
    return `<span class="b-result">→ ${chanceText(r.chance)} · ${money(r.payout)}</span>`;
  };
  const legs = keys.map((key) => {
    const disliked = reactions.legs[key] ?? [];
    const rest = keys.filter((k) => k !== key);
    const alt = swapFor(key);
    return `<div class="b-leg ${disliked.length ? 'disliked' : ''}">
      <div class="b-leg-head">
        <span><b>${betLabel(keyLabel(key))}</b> <span class="muted">${fmtOdds(bookLine(key).price)}</span>${disliked.length ? `<span class="small dislike-note">👎${faces(disliked)}</span>` : ''}</span>
        <b>${chanceText(chanceOf(key))}</b>
      </div>
      ${alt ? `<button type="button" class="b-act" data-swap-from="${esc(key)}" data-swap-to="${esc(alt)}">⇄ ${betLabel(keyLabel(alt))} <span class="muted">${fmtOdds(bookLine(alt).price)}</span> ${result([...rest, alt])}</button>` : ''}
      ${rest.length ? `<button type="button" class="b-act drop" data-drop="${esc(key)}">✕ Drop ${result(rest)}</button>` : ''}
    </div>`;
  }).join('');
  return `<div class="card builder">
    <div class="b-head"><b>Your parlay</b>${calcFrom ? ` <span class="small muted">· copy of ${esc(calcFrom.name)}</span>` : ''}</div>
    <div class="small muted">${keys.length} leg${keys.length === 1 ? '' : 's'} · <b>${chanceText(priceKeys(keys).chance)}</b> to hit</div>
    ${legs}
  </div>`;
}

// Start Build a parlay from an existing parlay's legs.
function copyAndEdit(p) {
  calcKeys.clear();
  let skipped = 0;
  for (const l of p.legs) {
    if (bookLine(l.key) && !gameOf(l.key)?.started) calcKeys.add(l.key);
    else skipped++;
  }
  calcFrom = { id: p.id, name: p.name };
  tab = 'picks';
  calc = true;
  render();
  notice(skipped ? `${skipped} leg${skipped === 1 ? ' was' : 's were'} left out because the game started or lost its line.` : null);
  window.scrollTo(0, 0);
}

// Small initial circles for who liked or disliked something. Two letters
// when two players share a first initial.
function initial(name) {
  const same = week.players.filter((p) => p[0].toUpperCase() === name[0].toUpperCase());
  return same.length > 1 ? name.slice(0, 2) : name[0].toUpperCase();
}
const faces = (names) => (names.length
  ? `<span class="faces">${names.map((n) => `<span class="face" title="${esc(n)}">${esc(initial(n))}</span>`).join('')}</span>` : '');

// Putting money on a parlay counts as liking it.
const likersOf = (p) => [...new Set([...(reactions.parlays[p.id] ?? []), ...Object.keys(p.stakes ?? {})])];

// Parlays that Copy & edit can start from, by id.
const editable = new Map();

// 👍 / 👎 with who picked each, and Copy & edit, on open parlays. Tap one to
// choose it (switching from the other); tap your choice again to clear it.
function reactHtml(p) {
  editable.set(p.id, p);
  const likers = likersOf(p);
  const downers = (reactions.parlayDowns[p.id] ?? []).filter((n) => !likers.includes(n));
  const liked = likers.includes(me);
  const disliked = downers.includes(me);
  const staked = me in (p.stakes ?? {});
  return `<div class="react-row">
    <span class="react-pair">
      <button type="button" class="react like ${liked ? 'on' : ''}" data-like="${esc(p.id)}" data-val="${liked ? 0 : 1}" ${staked ? 'data-staked="1"' : ''}
        aria-pressed="${liked}">👍${likers.length ? ` ${likers.length}` : ''}</button>${faces(likers)}
      <button type="button" class="react down ${disliked ? 'on' : ''}" data-down="${esc(p.id)}" data-val="${disliked ? 0 : 1}" ${staked ? 'data-staked="1"' : ''}
        aria-pressed="${disliked}">👎${downers.length ? ` ${downers.length}` : ''}</button>${faces(downers)}
    </span>
    <button type="button" class="link small edit-copy" data-edit-copy="${esc(p.id)}">✎ Copy &amp; edit</button>
  </div>`;
}

// 👎 on one leg, with who disliked it.
function dislikeHtml(l) {
  const who = reactions.legs[l.key] ?? [];
  const mine = who.includes(me);
  return `<span class="leg-react"><button type="button" class="react dislike ${mine ? 'on' : ''}" data-dislike="${esc(l.key)}" data-val="${mine ? 0 : 1}"
    title="${mine ? 'Take back your dislike' : 'Dislike this leg'}">👎</button>${faces(who)}</span>`;
}

async function react(kind, id, on) {
  try {
    reactions = { parlays: {}, parlayDowns: {}, legs: {}, ...(await api('/api/react', { method: 'POST', body: { name: me, kind, id, on } })).reactions };
  } catch (err) {
    notice(err.message);
  }
  renderParlays(true);
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
// College teams from the server (ESPN): { fullName: { short, abbr, logo } },
// found by full name ("Ohio State Buckeyes") or school ("Ohio State").
const collegeTeams = new Map();
function addTeams(teams) {
  for (const [name, t] of Object.entries(teams)) {
    const info = { name, ...t };
    collegeTeams.set(name, info);
    if (t.short && !collegeTeams.has(t.short)) collegeTeams.set(t.short, info);
  }
}
const college = (team) => collegeTeams.get(String(team));
const abbr = (team) => (league === 'cfb'
  ? college(team)?.abbr ?? team
  : ABBR[team.split(' ').pop().toLowerCase()] ?? team.split(' ').pop());
// NFL.com's own club-logo CDN, keyed by the same abbreviations we already use;
// ESPN's logos for college.
const logoUrl = (team) => (league === 'cfb' ? college(team)?.logo : `https://static.www.nfl.com/league/api/clubs/logos/${abbr(team)}.png`);
const teamLogo = (team, cls = '') => (team && logoUrl(team) ? `<img class="team-logo ${cls}" src="${logoUrl(team)}" alt="" loading="lazy">` : '');
const dayKey = (iso) => new Date(iso).toDateString();
// The team a bet label names ("49ers ML", "Panthers +3", "Ohio State -7.5");
// null for totals and props.
const labelTeam = (label) => {
  const text = String(label ?? '');
  if (league === 'cfb') {
    const m = text.match(/^(.+) (ML|[+-]?\d+(?:\.\d+)?)$/);
    return m && college(m[1]) ? m[1] : null;
  }
  const w = text.split(' ')[0].toLowerCase();
  return ABBR[w] ? w : null;
};
// A bet label with its team's logo in front.
const betLabel = (label) => `${teamLogo(labelTeam(label), 'small')}${esc(label)}`;
// "49ers @ Falcons", each team with its logo.
const matchupHtml = (m) => shortMatchup(m).split(' @ ').map((t) => `${teamLogo(t, 'small')}${esc(t)}`).join(' @ ');

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
  if (isPropMarket(market)) return propText(market, side, point);
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
  const locks = submittedPicks().filter((p) => p.locked).map((p) => p.key);
  try {
    ({ draft: week.draft, locks: week.draftLocks } = await api('/api/draft', { method: 'PUT', body: { name: me, keys, locks } }));
  } catch (err) {
    notice(err.message);
  }
  renderGames();
}

async function cancelEditing() {
  try {
    week.draft = (await api('/api/draft', { method: 'DELETE', body: { name: me } })).draft;
    week.draftLocks = [];
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
  // A pick you drop takes its lock with it.
  week.draftLocks = (week.draftLocks ?? []).filter((k) => draft.has(k));
  renderGames(); // feels instant; the server confirms below
  await saveDraft();
}

// Lock or unlock one of your picks.
async function toggleLock(key) {
  const locks = new Set(week.draftLocks ?? []);
  const closing = !locks.has(key);
  if (closing) locks.add(key);
  else locks.delete(key);
  week.draftLocks = [...locks];
  justLocked = closing ? key : null;
  lockSound(closing);
  renderGames();
  await saveDraft();
}

async function saveDraft() {
  try {
    ({ draft: week.draft, locks: week.draftLocks } = await api('/api/draft', { method: 'PUT', body: { name: me, keys: week.draft, locks: week.draftLocks } }));
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
    week.draftLocks = [];
    if (res.dropped) notice(`${res.dropped} pick${res.dropped === 1 ? ' was' : 's were'} left out because the game already started.`);
  } catch (err) {
    notice(err.message);
  }
  renderGames();
}

// "San Francisco 49ers @ Atlanta Falcons" -> "49ers @ Falcons"
const shortMatchup = (m) => String(m).split(' @ ').map((t) => (league === 'cfb' ? college(t)?.short ?? t : t.split(' ').pop())).join(' @ ');
// A leg's matchup on its own small line under the bet.
const legSub = (l, extra = '') => `<div class="small muted leg-sub">${matchupHtml(l.matchup)}${extra}</div>`;

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
        <div><b>${betLabel(s.label)}</b> <span class="muted">${fmtOdds(s.price)}</span></div>
        <div class="small muted">${matchupHtml(s.matchup)} · ${s.pickers.map((p) => `${esc(p)}${isLockedBy(p, s.key) ? miniLock : ''}`).join(', ')}</div>
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
      ? betLine(total, total * payMultiplier(p)) + whoLine(p.stakes)
      : 'Nobody is in yet'}</div>`;
}

// "$10.00 bet, pays $25.04 ($15.04 profit)", then who's in on the next line.
const betLine = (total, payout, when = '') =>
  `<b>${money(total)} bet</b>, pays ${money(payout)}${when} (${money(payout - total)} profit)`;
const whoLine = (stakes) =>
  `<div>${Object.entries(stakes).map(([who, amt]) => `${esc(who)} ${money(amt)}`).join(' · ')}</div>`;

// "Straight bet" for one leg, else "3-leg parlay" ("3-leg custom parlay").
const betKind = (p, custom = false) => (p.legs.length === 1 ? 'Straight bet' : `${p.legs.length}-leg ${custom ? 'custom ' : ''}parlay`);

// A parlay's name, with a ✎ to rename it when it's saved (custom, or with
// money on it). While renaming, a small form takes its place.
let renamingId = null;
function titleHtml(p, editable = true) {
  if (editable && renamingId === p.id) {
    return `<form class="rename-form" data-rename="${esc(p.id)}">
      <input name="parlayName" maxlength="40" value="${esc(p.name)}" aria-label="Parlay name">
      <button type="submit" class="primary">Save</button>
      <button type="button" class="link small" data-rename-cancel>Cancel</button>
    </form>`;
  }
  return `<h3>${esc(p.name)}${editable ? ` <button type="button" class="link rename" data-rename-start="${esc(p.id)}" title="Rename" aria-label="Rename">✎</button>` : ''}</h3>`;
}
const rerenderParlayTab = () => (tab === 'slip' ? renderSlip(true) : renderParlays(true));

// Parlays with money on them whose games have started but aren't decided:
// legs that finished get a check or X; no more stakes can go in.
function inPlayHtml(data) {
  if (!data.inPlay?.length) return '';
  const cards = data.inPlay.map((p) => {
    return `<div class="card parlay ${p.custom ? 'custom' : ''}">
      <div class="head">
        <div>${p.placed ? '<span class="chip placed">✓ Placed</span>' : '<span class="chip pending">Not placed</span>'}
          ${titleHtml(p, !isPast())}<div class="small muted">${betKind(p, p.custom)}</div></div>
        <div class="odds-col"><div class="odds">${fmtOdds(shownOdds(p))}</div>${copyButton(p)}</div>
      </div>
      <ul class="graded-legs">${p.legs.map((l) => `<li>${gradeMark(l.grade) || '<span class="mark">·</span>'}<span><b>${betLabel(l.label)}</b> <span class="muted">${fmtOdds(l.price)}</span>${legSub(l)}</span></li>`).join('')}</ul>
      <div class="small muted backers">${betLine(p.total, p.payout, ' if it hits')}${whoLine(p.stakes)}</div>
    </div>`;
  }).join('');
  return `<h3 class="section">In play</h3>${cards}`;
}

// Parlays with money on them that are decided: result badge, leg marks,
// and what came back. Grayed out at the bottom of the Parlays tab.
function settledHtml(data) {
  if (!data.settled?.length) return '';
  const cards = data.settled.map((p) => {
    const back = p.status === 'won' ? `paid ${money(p.returned)} (${money(p.returned - p.total)} profit)` : p.status === 'push' ? 'refunded' : 'paid $0.00';
    return `<div class="card parlay done ${p.status}">
      <div class="head">
        <div>${statusChip(p.status, p.returned, p.total)}${titleHtml(p, !isPast())}<div class="small muted">${betKind(p)}</div></div>
        <div class="odds-col"><div class="odds">${fmtOdds(shownOdds(p))}</div>${copyButton(p)}</div>
      </div>
      <ul class="graded-legs">${p.legs.map((l) => `<li>${gradeMark(l.grade)}<span><b>${betLabel(l.label)}</b> <span class="muted">${fmtOdds(l.price)}</span>${legSub(l)}</span></li>`).join('')}</ul>
      <div class="small muted backers"><b>${money(p.total)} bet</b>, ${back}${whoLine(p.stakes)}</div>
    </div>`;
  }).join('');
  return `<h3 class="section">Completed</h3>${cards}`;
}

// More than half the group.
const majority = () => Math.floor(week.players.length / 2) + 1;

function customHtml(data) {
  const cards = data.custom.map((p) => `
    <div class="card parlay custom">
      <div class="head">
        <div>${likersOf(p).length >= majority() ? '<span class="badge">Group\'s pick</span>' : ''}
          ${titleHtml(p)}<div class="small muted">${betKind(p, true)}${p.sameGame ? ' · same-game' : ''}${p.basedOn ? ` · based on ${esc(p.basedOn)}` : ''}</div></div>
        <div class="odds-col"><div class="odds">${fmtOdds(shownOdds(p))}</div>${copyButton(p)}</div>
      </div>
      <ul class="legs">${p.legs.map((l) => `<li><span><b>${betLabel(l.label)}</b> <span class="muted">${fmtOdds(l.price)}</span>${legSub(l)}${lineMoved(l, data.book)}</span>${p.started ? '' : dislikeHtml(l)}</li>`).join('')}</ul>
      <div class="stats"><span>$10.00 pays <b>${money(10 * p.decimal)}</b></span></div>
      ${p.started ? '' : reactHtml(p)}
      ${stakeHtml(p, p.started)}
    </div>`).join('');
  return `<div class="section-head">
      <h3 class="section">Custom parlays</h3>
      <button type="button" class="primary" id="build-custom">+ Build your own</button>
    </div>
    ${cards || '<div class="card muted small">No open custom parlays right now. Build one with any bets you like, and the others can join in.</div>'}`;
}

// After a tap (stake, 👍/👎), pass quiet: keep what's on screen until the
// update arrives and stay where you were, instead of jumping to the top.
async function renderParlays(quiet = false) {
  const y = window.scrollY;
  if (!quiet) $('#parlays').innerHTML = '<p class="muted">Building…</p>';
  const data = await api(withWeek('/api/parlays')).catch((err) => (notice(err.message), null));
  if (!data) return;
  reactions = { parlays: {}, parlayDowns: {}, legs: {}, ...data.reactions };
  $('#parlays-hint').hidden = isPast();
  if (isPast()) {
    // A past week: just the parlays that had money on them, and how they did.
    const html = inPlayHtml(data) + settledHtml(data);
    $('#parlays').innerHTML = html || `<div class="card muted">Nobody put money on a parlay in ${esc(week.label)}.</div>`;
    if (quiet) window.scrollTo(0, y);
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

  html += data.options.map((p) => {
    // A majority liking it (money counts as a like) makes it the group's pick.
    const groupPick = likersOf(p).length >= majority();
    return `
    <div class="card parlay ${groupPick ? 'group-pick' : ''}">
      <div class="head">
        <div>
          ${groupPick ? '<span class="badge">Group\'s pick</span>' : ''}
          ${titleHtml(p, Object.keys(p.stakes).length > 0)}<div class="small muted">${esc(p.blurb)}</div>
        </div>
        <div class="odds-col"><div class="odds">${fmtOdds(shownOdds(p))}</div>${copyButton(p)}</div>
      </div>
      <ul class="legs">${p.legs.map((l) => `<li><span><b>${betLabel(l.label)}</b> <span class="muted">${fmtOdds(l.price)}</span>${legSub(l, ` · ${l.pickers.length}/${data.voters} picked`)}${lineMoved(l, data.book)}</span>${dislikeHtml(l)}</li>`).join('')}</ul>
      <div class="stats">
        <span>${money(p.stake)} pays <b>${money(p.payout)}</b></span>
        <span>Hit chance ~<b>${pct(p.hitProb)}</b></span>
        <span class="${p.ev < 0 ? 'ev-bad' : ''}">Est. return ${p.ev >= 0 ? '+' : ''}${(p.ev * 100).toFixed(1)}%</span>
      </div>
      ${reactHtml(p)}
      ${stakeHtml(p, false)}
    </div>`;
  }).join('');

  if (data.almost.length) {
    html += `<div class="card"><b>One vote away</b>
      <p class="small muted">These would join the consensus with one more pick:</p>
      <ul>${data.almost.map((s) => `<li>${betLabel(s.label)} <span class="muted">${fmtOdds(s.price)} · ${s.pickers.map(esc).join(', ')}</span></li>`).join('')}</ul>
    </div>`;
  }


  html += settledHtml(data);

  html += `<p class="small muted">Payouts use the lines at the time each pick was submitted${data.book ? `, which can drift from ${esc(data.book)}'s current lines` : ''}, so double-check them in your sportsbook before you bet.
    Hit chance is a rough estimate that removes a typical book margin. A negative expected return is the house edge,
    and parlays stack it on every leg.</p>`;
  $('#parlays').innerHTML = html;
  if (quiet) window.scrollTo(0, y);
}

const gradeMark = (g) => ({ win: '<span class="mark win">✓</span>', loss: '<span class="mark loss">✗</span>', push: '<span class="mark push">P</span>' })[g] ?? '';
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${money(Math.abs(n))}`;
const netClass = (n) => (n > 0.004 ? 'pos' : n < -0.004 ? 'neg' : '');

function statusChip(status, returned, total) {
  if (!status || status === 'pending') return '';
  const text = { won: `Won ${money(returned)}`, lost: 'Lost', push: 'Push (refunded)' }[status];
  return `<span class="chip ${status}">${text}</span>`;
}

// " · Props 2-1" once anyone has a graded prop (older stats have none).
const propsRec = (r) => (r && r.win + r.loss + r.push ? ` · Props ${recordText(r)}` : '');

// A small gold padlock for marking locks in lists.
const miniLock = '<span class="mini-lock" title="Locked pick"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 11V8a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="url(#gold)" stroke-width="2.6" stroke-linecap="round"/><rect x="4.5" y="10.5" width="15" height="11" rx="2.5" fill="url(#gold)"/></svg></span>';

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
      <button type="button" data-scope="week" class="${byWeek ? 'active' : ''}">${isPast() ? esc(week.label) : 'Current week'}</button>
      <button type="button" data-scope="season" class="${byWeek ? '' : 'active'}">All season</button>
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
        <td>${esc(p.name)}<div class="small muted">ATS ${recordText(p.byMarket.spread)} · Totals ${recordText(p.byMarket.total)} · ML ${recordText(p.byMarket.ml)}${propsRec(p.byMarket.props)}</div></td>
        ${wlp(p.picks)}<td class="num ${netClass(p.flatNet)}">${signed(p.flatNet)}</td></tr>`).join('')}</tbody>
      <tfoot>
        <tr><th>All of us<div class="small muted">ATS ${recordText(sumRec('spread'))} · Totals ${recordText(sumRec('total'))} · ML ${recordText(sumRec('ml'))}${propsRec(sumRec('props'))}</div></th>
          ${wlp(all)}<th class="num ${netClass(allNet)}">${signed(allNet)}</th></tr>
        <tr><th>Group consensus<div class="small muted">Bets most of you agreed on</div></th>${wlp(c)}<th class="num ${netClass(c.flatNet)}">${signed(c.flatNet)}</th></tr>
      </tfoot>
    </table></div>`;

  // Locks: the picks people were sure of, and how those went.
  const lockers = data.players.filter((p) => p.locks.win + p.locks.loss + p.locks.push + p.locks.pending);
  const allLocks = addUp((p) => p.locks);
  const allLockNet = data.players.reduce((t, p) => t + p.lockNet, 0);
  const locksCard = `<div class="card"><h3>${miniLock} Locked picks</h3>
    <p class="small muted">Picks marked as locks: the ones you were sure of. Same grading as above.</p>
    ${lockers.length ? `<table class="slip">
      <thead><tr><th>Who</th><th class="num">W</th><th class="num">L</th><th class="num">P</th><th class="num">$10 a lock</th></tr></thead>
      <tbody>${[...lockers].sort((a, b) => winPct(b.locks) - winPct(a.locks) || b.locks.win - a.locks.win).map((p) => `<tr>
        <td>${esc(p.name)}<div class="small muted">${recordText(p.locks)}${p.locks.pending ? ` · ${p.locks.pending} still to play` : ''}</div></td>
        ${wlp(p.locks)}<td class="num ${netClass(p.lockNet)}">${signed(p.lockNet)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th>All of us</th>${wlp(allLocks)}<th class="num ${netClass(allLockNet)}">${signed(allLockNet)}</th></tr></tfoot>
    </table>` : '<p class="small muted">No locks yet. Tap the padlock on a pick you\'re sure of.</p>'}
  </div>`;

  const weeks = data.weeks.map((w, i) => {
    const parlays = w.parlays.map((p) => `<div class="hist-parlay">
        <div class="head"><b>${esc(p.name)} ${fmtOdds(p.american)}</b> ${statusChip(p.status, p.returned, p.total) || '<span class="chip pending">Live</span>'}</div>
        <ul>${p.legs.map((l) => `<li>${gradeMark(l.grade)}${betLabel(l.label)} <span class="muted">${fmtOdds(l.price)}</span></li>`).join('')}</ul>
        <div class="small muted">${Object.entries(p.stakes).map(([who, amt]) => `${esc(who)} ${money(amt)}`).join(' · ')} · ${money(p.total)} total</div>
      </div>`).join('') || '<p class="small muted">No parlays placed.</p>';
    const picks = Object.entries(w.picks).map(([who, rows]) => `<div class="hist-picks"><b>${esc(who)}</b>
        <ul>${rows.map((r) => `<li>${gradeMark(r.grade)}${betLabel(r.label)} <span class="muted">${fmtOdds(r.price)}</span>${r.locked ? miniLock : ''}</li>`).join('')}</ul></div>`).join('');
    return `<details class="card week" ${i === 0 ? 'open' : ''}>
      <summary><b>${esc(w.label)}</b> <span class="muted small">${w.parlays.length} parlay${w.parlays.length === 1 ? '' : 's'}</span>
        <span class="num ${netClass(w.net)}">${w.parlays.some((p) => p.status !== 'pending') ? signed(w.net) : ''}</span></summary>
      <h4>Parlays</h4>${parlays}
      <h4>Picks</h4><div class="hist-grid">${picks || '<p class="small muted">No picks submitted.</p>'}</div>
    </details>`;
  }).join('');

  $('#stats').innerHTML = scope + parlayCard + money_ + picksCard + locksCard
    + `<h3 class="section">${byWeek ? 'Picks and parlays' : 'Week by week'}</h3>` + weeks;
}

// ---- Heat map (beta) ---------------------------------------------------------
// One game's matchups from the depth charts: each team's offense against the
// other's defense, unit by unit. Each square is who would line up there, in
// green for a starter, yellow for a backup, red for third string or deeper.

let heatGame = null; // the game shown
const HEAT_UNITS = [['line', 'Offensive line', 'Defensive line'], ['pass', 'Receivers', 'Secondary'], ['back', 'Backfield', 'Linebackers']];
const HEAT_LEVELS = ['Nobody healthy', 'Starter', 'Backup', '3rd string or deeper'];

// How the player got the job, from every week's snap counts this season.
const HEAT_TAGS = { fillin: 'Fill-in', earned: 'Earned ↑', new: 'New', back: 'Back', part: 'Part-time' };
const weekList = (weeks) => (weeks.length > 1 ? `Weeks ${weeks[0]}–${weeks[weeks.length - 1]}` : `Week ${weeks[0]}`);
function historyText(h) {
  if (!h) return null;
  const who = (name, status) => `${name}${status ? ` (${status})` : ''}`;
  const since = h.since ? ` since Week ${h.since}` : '';
  const text = {
    week1: `Starter every game since Week ${h.since}`,
    back: h.missed?.length ? `Back as a starter: out or limited ${weekList(h.missed)}` : 'Back as a starter',
    fillin: `Filling in for ${who(h.replaced, h.replacedStatus)}${since}`,
    earned: `Took the job from ${h.replaced}${since}. He's healthy${h.replacedRecent != null ? ` and down to ${h.replacedRecent}% of snaps` : ''}`,
    new: h.from ? `New: played for ${h.from} earlier this season` : h.replacedGone ? `Took over for ${h.replaced}${since}. He's no longer on the team` : `New starter${since}`,
    part: 'Listed as a starter, but playing well under half the snaps',
  }[h.tag];
  const weeks = h.timeline?.map((t) => `Wk ${t.week}: ${t.pct == null ? 'did not play' : `${t.pct}%`}`).join(', ');
  return [h.recent != null ? `${text} · ${h.recent}% of snaps the last 3 games` : text, weeks && `Snaps by week: ${weeks}`].filter(Boolean).join('\n');
}

// Each week's share of snaps as a tiny bar: bright at half the snaps or more,
// dim under half, a dot where he didn't play.
const snapBars = (timeline) => (timeline?.length
  ? `<span class="heat-weeks" aria-hidden="true">${timeline.map((t) => (t.pct == null ? '<i class="none"></i>'
    : `<i class="${t.pct >= 50 ? 'hi' : 'lo'}" style="height:${Math.max(8, t.pct)}%"></i>`)).join('')}</span>`
  : '');

function heatSquare(s) {
  const level = s.name ? Math.min(s.rank, 3) : 0;
  const tip = [`${s.pos}: ${s.name ?? 'nobody healthy'}`, HEAT_LEVELS[level] + (s.rank > 3 ? ` (#${s.rank} on the depth chart)` : '')];
  if (s.rookie) tip.push('Rookie');
  if (s.status) tip.push(s.status);
  for (const p of s.skipped) tip.push(`${p.name} is ${p.status}`);
  const history = historyText(s.history);
  if (history) tip.push(history);
  const tag = HEAT_TAGS[s.history?.tag];
  return `<div class="heat-sq heat-${level}" title="${esc(tip.join('\n'))}">
    <span class="heat-pos">${esc(s.pos)}</span>
    <span class="heat-name">${esc(s.name ? shortName(s.name) : '—')}</span>
    ${tag ? `<span class="heat-how how-${s.history.tag}">${tag}</span>` : ''}
    ${snapBars(s.history?.timeline)}
    ${s.rookie ? '<span class="rookie" title="Rookie">R</span>' : ''}
    ${s.status === 'Questionable' ? '<span class="heat-tag">Q</span>' : ''}
  </div>`;
}

// How many spots a side is filling below its starters, and how its starters
// got there.
function heatSummary(side) {
  const slots = Object.values(side).flat();
  const backups = slots.filter((s) => s.rank === 2).length;
  const deep = slots.filter((s) => s.rank > 2 || !s.name).length;
  const depth = !backups && !deep ? 'All starters'
    : [backups && `${backups} backup${backups === 1 ? '' : 's'}`, deep && `${deep} 3rd string or deeper`].filter(Boolean).join(' · ') + ' in';
  const how = [['fillin', 'fill-in'], ['earned', 'earned'], ['new', 'new'], ['back', 'back'], ['part', 'part-time']]
    .map(([tag, label]) => [slots.filter((s) => s.history?.tag === tag).length, label])
    .filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(', ');
  return how ? `${depth} (${how})` : depth;
}

function heatMatchup(g, offHome, data) {
  const [off, def] = offHome ? [data.home.offense, data.away.defense] : [data.away.offense, data.home.defense];
  const [offTeam, defTeam] = offHome ? [g.home, g.away] : [g.away, g.home];
  const [offShort, defShort] = offHome ? [g.homeShort, g.awayShort] : [g.awayShort, g.homeShort];
  const units = HEAT_UNITS.map(([id, oLabel, dLabel]) => `<div class="heat-unit">
      <div class="heat-side"><div class="heat-label">${oLabel}</div><div class="heat-row">${off[id].map(heatSquare).join('')}</div></div>
      <div class="heat-vs">vs</div>
      <div class="heat-side"><div class="heat-label">${dLabel}</div><div class="heat-row">${def[id].map(heatSquare).join('')}</div></div>
    </div>`).join('');
  return `<div class="card heat-card">
    <h3 class="heat-title">${teamLogo(offTeam, 'small')}${esc(offShort)} offense <span class="muted">vs</span> ${teamLogo(defTeam, 'small')}${esc(defShort)} defense</h3>
    <div class="small muted">${esc(offShort)}: ${heatSummary(off)} · ${esc(defShort)}: ${heatSummary(def)}</div>
    ${units}
  </div>`;
}

async function renderHeatmap() {
  const box = $('#heatmap');
  const games = [...week.games].sort((a, b) => a.commence.localeCompare(b.commence));
  if (!games.length) {
    box.innerHTML = '<div class="card muted">No games on the schedule this week.</div>';
    return;
  }
  if (!games.some((g) => g.id === heatGame)) heatGame = (games.find((g) => !g.started) ?? games[0]).id;
  const g = games.find((x) => x.id === heatGame);
  const kick = (x) => new Date(x.commence).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const head = `<p class="small muted">Beta: who lines up for each team, from ESPN's current depth charts. Hurt players (Out, Doubtful, IR, suspended) are skipped, so a backup filling in shows up yellow. Tags and the little bars show how a starter got the job, from every week's snap counts this season (nflverse, updated weekly). Hover or long-press a square for details.</p>
    <label class="heat-pick">Game <select id="heat-game">${games.map((x) => `<option value="${esc(x.id)}" ${x.id === heatGame ? 'selected' : ''}>${esc(shortMatchup(`${x.away} @ ${x.home}`))} · ${esc(kick(x))}</option>`).join('')}</select></label>
    <div class="heat-legend">${[1, 2, 3].map((l) => `<span class="heat-key heat-${l}">${HEAT_LEVELS[l]}</span>`).join('')}<span class="heat-key"><span class="heat-tag">Q</span> Questionable</span></div>
    <div class="heat-legend">
      <span class="heat-key"><span class="heat-how how-fillin">Fill-in</span> for a hurt starter</span>
      <span class="heat-key"><span class="heat-how how-earned">Earned ↑</span> passed a healthy starter</span>
      <span class="heat-key"><span class="heat-how how-new">New</span> new starter or traded in</span>
      <span class="heat-key"><span class="heat-how how-back">Back</span> starting again after missing games</span>
      <span class="heat-key"><span class="heat-how how-part">Part-time</span> under half the snaps</span>
      <span class="heat-key">No tag: starter every game since Week 1</span>
      <span class="heat-key"><span class="heat-weeks"><i class="hi" style="height:90%"></i><i class="lo" style="height:35%"></i><i class="none"></i><i class="hi" style="height:100%"></i></span> snaps each week: <b class="snap-hi">50%+</b> · <b class="snap-lo">under 50%</b> · dot: didn't play</span>
      <span class="heat-key"><span class="rookie in-key">R</span> rookie</span>
    </div>`;
  box.innerHTML = head + '<p class="muted">Loading depth charts…</p>';
  const data = await api(withWeek(`/api/heatmap?game=${encodeURIComponent(heatGame)}`)).catch((err) => (notice(err.message), null));
  if (!data || tab !== 'heatmap' || g.id !== heatGame) return;
  box.innerHTML = head + heatMatchup(g, false, data) + heatMatchup(g, true, data);
}

// ---- Analysis ----------------------------------------------------------------

const chanceText = (p) => (p == null ? '?' : `${Math.round(p * 100)}%`);
const chanceVerb = (market) => ({ spread: 'to cover', total: 'to hit', ml: 'to win' })[market] ?? 'to hit';
// 0.5 -> "½ pt", 3.5 -> "3½ pts", 7 -> "7 pts"
function pointsText(m) {
  const abs = Math.abs(m);
  const n = `${Math.floor(abs) || ''}${abs % 1 ? '½' : ''}`;
  return `${n} pt${abs > 1 ? 's' : ''}`;
}
const chanceBar = (p) => `<div class="bar chance"><span style="width:${Math.round((p ?? 0) * 100)}%"></span></div>`;

async function renderAnalysis() {
  $('#analysis').innerHTML = '<p class="muted">Crunching…</p>';
  const data = await api(withWeek(`/api/analysis?me=${encodeURIComponent(me)}`)).catch((err) => (notice(err.message), null));
  if (!data) return;
  const book = data.book ?? 'the sportsbook';
  const kick = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  let html = `<p class="muted small">Win chances come from ${esc(book)}'s odds with the house's cut taken out. That's the betting
    market's own estimate, not a prediction model. Nobody beats it by much, but it shows what each bet really is.</p>`;

  // Your picks on games that haven't started, with the other way to bet it.
  if (!isPast()) {
    const rows = data.mine.map((m) => {
      const alt = m.alt;
      const tag = alt && (alt.chance > m.chance ? '<span class="chip tag">safer</span>' : '<span class="chip tag">bigger payout</span>');
      return `<div class="an-row">
        <div class="an-head">
          <div><b>${betLabel(m.label)}</b> <span class="muted">${fmtOdds(m.price)}</span>
            <div class="small muted">${matchupHtml(m.matchup)} · ${esc(kick(m.commence))}</div></div>
          <div class="an-chance"><b>${chanceText(m.chance)}</b><span>${chanceVerb(m.market)}</span></div>
        </div>
        ${chanceBar(m.chance)}
        <div class="small muted">$10 pays ${money(m.pays)}</div>
        ${alt ? `<div class="alt small">Or <b>${betLabel(alt.label)}</b> ${fmtOdds(alt.price)}: ${chanceText(alt.chance)} ${chanceVerb(alt.market)}, $10 pays ${money(alt.pays)} ${tag}</div>` : ''}
      </div>`;
    }).join('');
    html += `<h3 class="section">Your picks</h3><div class="card">${rows
      || '<p class="muted small">No picks on games that haven’t started. Make some on the Picks tab and they’ll show up here.</p>'}</div>`;
  }

  // Parlays with money on them that are still alive.
  if (data.live.length) {
    html += `<h3 class="section">Parlays in play</h3>
      <p class="small muted">Every leg has to hit, so the chances multiply. The weakest leg is listed first.</p>`;
    html += data.live.map((p) => `<div class="card">
      <div class="an-head">
        <div><b>${esc(p.name)}</b><div class="small muted">${p.won ? `${p.won} of ${p.legs} legs in · ` : `${p.legs} legs · `}${money(p.total)} pays ${money(p.payout)}</div></div>
        <div class="an-chance"><b>${chanceText(p.hitChance)}</b><span>to hit</span></div>
      </div>
      ${chanceBar(p.hitChance)}
      <ul class="an-legs">${p.left.map((l, i) => `<li><span>${betLabel(l.label)} <span class="muted">${fmtOdds(l.price)}</span>${i === 0 && p.left.length > 1 ? ' <span class="chip tag">weakest</span>' : ''}</span><b>${chanceText(l.chance)}</b></li>`).join('')}</ul>
    </div>`).join('');
  }

  // Looking back: lost picks, how close they were, and what would have hit.
  if (data.misses.length) {
    html += `<h3 class="section">Close calls</h3>
      <p class="small muted">Picks that lost, closest first, and whether betting the same team the other way would have won.</p>
      <div class="card">${data.misses.map((m) => `<div class="an-row">
        <div><b>${betLabel(m.label)}</b> <span class="muted">${fmtOdds(m.price)} · ${m.pickers.map(esc).join(', ')}</span></div>
        <div class="small">${m.market === 'ml' ? `Lost by ${pointsText(m.margin)}` : `Missed by ${pointsText(m.margin)}`}${m.alt
          ? `. <span class="pos">${betLabel(m.alt.label)}${m.alt.price != null ? ` (${fmtOdds(m.alt.price)})` : ''} would have won.</span>` : '.'}</div>
      </div>`).join('')}</div>`;
  }

  if (data.oneLegAway.length) {
    html += `<h3 class="section">One leg away</h3><div class="card">${data.oneLegAway.map((p) => `<div class="an-row">
      <div><b>${esc(p.name)}</b> <span class="muted">${money(p.total)} bet</span></div>
      <div class="small">Lost only on ${betLabel(p.leg.label)}${p.leg.margin != null ? ` (missed by ${pointsText(p.leg.margin)})` : ''}.
        ${p.alt ? `<span class="pos">With ${betLabel(p.alt.label)} instead, it would have hit${p.alt.payout != null ? ` and paid about ${money(p.alt.payout)}` : ''}.</span>` : ''}</div>
    </div>`).join('')}</div>`;
  }

  // Same money, as straight bets on the same legs.
  const vs = (label, r) => (r.count ? `<tr><td>${label}<div class="small muted">${r.count} parlay${r.count === 1 ? '' : 's'}, ${money(r.staked)}</div></td>
    <td class="num ${netClass(r.parlayNet)}">${signed(r.parlayNet)}</td><td class="num ${netClass(r.singlesNet)}">${signed(r.singlesNet)}</td></tr>` : '');
  const vsRows = vs(esc(data.label), data.vsSingles.week) + vs('All season', data.vsSingles.season);
  if (vsRows) {
    html += `<h3 class="section">Parlays vs. straight bets</h3><div class="card">
      <p class="small muted">What your settled parlays made, next to the same money split evenly across the same legs as single bets.</p>
      <table class="slip"><thead><tr><th></th><th class="num">As parlays</th><th class="num">As straight bets</th></tr></thead>
      <tbody>${vsRows}</tbody></table></div>`;
  }

  if (isPast() && !data.misses.length && !data.oneLegAway.length && !vsRows) {
    html += `<div class="card muted">Nothing to look back on for ${esc(data.label)}.</div>`;
  }
  $('#analysis').innerHTML = html;
}

// ---- Research ----------------------------------------------------------------

// The team you looked at last, per league.
const teamStorageKey = () => (league === 'cfb' ? 'parlay.team.cfb' : 'parlay.team');
let researchTeam = storage.get(teamStorageKey());
let researchMode = 'team'; // 'team' (one team's full page) | 'compare' (two teams, head to head) | 'league' (rankings)
let compareA = null;
let compareB = null;
// Research cards folded shut this visit, by id. Every card starts open.
const folded = new Set();
// A card with an arrow on its heading: ▾ while open; tap the heading to fold it shut (the arrow flips up).
const foldCard = (id, title, body) => `<div class="card fold ${folded.has(id) ? 'folded' : ''}" data-fold="${esc(id)}">
  <button type="button" class="fold-head" aria-expanded="${!folded.has(id)}"><h3>${title}</h3><span class="fold-arrow" aria-hidden="true">▾</span></button>
  <div class="fold-body">${body}</div></div>`;
const wlt = (r) => `${r.w}-${r.l}${r.t ? `-${r.t}` : ''}`;
const wlPct = (r) => (r.w + r.l ? ` (${Math.round((r.w / (r.w + r.l)) * 100)}%)` : '');
// 1 -> "1st", 12 -> "12th", 23 -> "23rd"
function ordinal(n) {
  const v = n % 100;
  const s = ['th', 'st', 'nd', 'rd'];
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
const winPctText = (p) => (p == null ? '–' : p.toFixed(3).replace(/^0/, ''));
const signedPts = (n) => (n == null ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`);
const lineText = (n) => (n == null ? '–' : n === 0 ? 'PK' : fmtPoint(n));
const rankTag = (r) => (r ? `<span class="muted small"> (${ordinal(r)})</span>` : '');
const fmt1 = (n) => (n == null ? '–' : n.toFixed(1));
const pctFmt = (n) => (n == null ? '–' : `${n.toFixed(1)}%`);
const mmss = (s) => (s == null ? '–' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

// One row of the offense-vs-defense table: a label, then each side's number and rank.
const advRow = (label, offVal, offRank, defVal, defRank, pct = false) => `
  <tr><td>${esc(label)}</td>
    <td class="num">${pct ? pctFmt(offVal) : fmt1(offVal)}${rankTag(offRank)}</td>
    <td class="num">${pct ? pctFmt(defVal) : fmt1(defVal)}${rankTag(defRank)}</td></tr>`;

// Worst-first, so Out/Doubtful/Questionable surface above longer-term IR/Suspension notes.
const INJURY_ORDER = ['Out', 'Doubtful', 'Questionable', 'Injured Reserve', 'Suspension'];
const injuryClass = (status) => (status === 'Questionable' ? '' : 'neg'); // Out/Doubtful/IR/Suspension all mean "unavailable or close to it"
const injuryTag = (status) => `<span class="small ${injuryClass(status)}"><b>${esc(status)}</b></span>`;

// A team's injury report right now: every player ESPN flags, their roster
// position, depth-chart standing, tag, and how long they've carried it.
function injuryTable(list) {
  if (!list.length) return '<p class="small muted">No one on the injury report.</p>';
  const sorted = [...list].sort((a, b) => {
    const oa = INJURY_ORDER.indexOf(a.status), ob = INJURY_ORDER.indexOf(b.status);
    return oa !== ob ? oa - ob : a.name.localeCompare(b.name);
  });
  return `<table class="slip injuries">
    <thead><tr><th>Player</th><th>Pos</th><th>Depth</th><th>Status</th><th>Since</th></tr></thead>
    <tbody>${sorted.map((p) => `<tr>
      <td>${esc(p.name)}</td>
      <td class="muted">${esc(p.position ?? '–')}</td>
      <td class="muted">${esc(p.depthLabel ?? '–')}</td>
      <td>${injuryTag(p.status)}</td>
      <td class="muted">${p.sinceWeek ? `Wk ${p.sinceWeek}` : '–'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

// `off` and `def` are both team stat objects; shows off's offense against def's defense
// (e.g. one team's own numbers, or two different teams for a head-to-head matchup).
function advTable(off, def, offLabel, defLabel) {
  return `<table class="slip adv">
    <thead><tr><th></th><th class="num">${esc(offLabel)}</th><th class="num">${esc(defLabel)}</th></tr></thead>
    <tbody>
      ${advRow('Points/gm', off.ppg, off.ppgRank, def.papg, def.papgRank)}
      ${advRow('Total yds/gm', off.ydsPerGame, off.ydsPerGameRank, def.ydsAllowedPerGame, def.ydsAllowedPerGameRank)}
      ${advRow('Pass yds/gm', off.passYdsPerGame, off.passYdsPerGameRank, def.passYdsAllowedPerGame, def.passYdsAllowedPerGameRank)}
      ${advRow('Rush yds/gm', off.rushYdsPerGame, off.rushYdsPerGameRank, def.rushYdsAllowedPerGame, def.rushYdsAllowedPerGameRank)}
      ${advRow('Sacks/gm', off.sacksAllowedPerGame, off.sacksAllowedPerGameRank, def.sacksMadePerGame, def.sacksMadePerGameRank)}
      ${advRow('Turnovers/gm', off.giveawaysPerGame, off.giveawaysPerGameRank, def.takeawaysPerGame, def.takeawaysPerGameRank)}
      ${advRow('3rd down %', off.thirdDownPct, off.thirdDownPctRank, def.thirdDownPctAllowed, def.thirdDownPctAllowedRank, true)}
      ${advRow('4th down %', off.fourthDownPct, off.fourthDownPctRank, def.fourthDownPctAllowed, def.fourthDownPctAllowedRank, true)}
      ${advRow('Red zone TD%', off.redZonePct, off.redZonePctRank, def.redZonePctAllowed, def.redZonePctAllowedRank, true)}
    </tbody>
  </table>`;
}

// One team's season: record, against the spread, over/under, strength of
// schedule, and every game; or (Compare mode) two teams' offense vs defense
// side by side, or (League mode) every team ranked. Season-wide (not tied to the week up top).
async function renderResearch(quiet = false) {
  if (!quiet || !$('#research').innerHTML) $('#research').innerHTML = '<p class="muted">Loading team stats…</p>';
  const data = await api(`/api/research?team=${encodeURIComponent(researchTeam ?? '')}`).catch((err) => (notice(err.message), null));
  if (!data) return;
  const teams = data.teams;
  addTeams(Object.fromEntries(teams.filter((x) => x.logo).map((x) => [x.name, { short: x.short, abbr: x.abbr, logo: x.logo }])));
  // Default: the team you looked at last, else one from this week's first game.
  if (!teams.some((t) => t.name === researchTeam)) {
    const first = week.games.find((g) => !g.started) ?? week.games[0];
    researchTeam = teams.find((t) => t.name === first?.away)?.name ?? teams[0].name;
  }
  const t = teams.find((x) => x.name === researchTeam);
  const next = t.log.find((e) => !e.final);
  // The logo sits inside the dropdown box, beside the selected team's name.
  const teamPick = (id, selected) => `<span class="team-select">${teamLogo(selected)}<select id="${id}" aria-label="Team">${teams.map((x) => `<option value="${esc(x.name)}" ${x.name === selected ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></span>`;
  const modeSwitch = `<div class="mode-switch" id="research-mode" role="tablist">
    <button type="button" data-mode="team" class="${researchMode === 'team' ? 'active' : ''}">Team</button>
    <button type="button" data-mode="compare" class="${researchMode === 'compare' ? 'active' : ''}">Compare</button>
    <button type="button" data-mode="league" class="${researchMode === 'league' ? 'active' : ''}">League</button>
  </div>`;

  if (researchMode === 'league') {
    $('#research').innerHTML = modeSwitch + leagueHtml(teams);
    return;
  }

  const kickTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
  const mark = (r) => ({ W: '<span class="mark win">✓</span>', L: '<span class="mark loss">✗</span>', P: '<span class="mark push">P</span>' })[r] ?? '';

  // Each section of a team's page, contents only: Team shows one team's,
  // Compare puts two teams' side by side.
  const recordBody = (x) => {
    const dots = x.last5.map((r) => `<span class="dot ${r === 'W' ? 'win' : r === 'L' ? 'loss' : 'push'}">${r}</span>`).join('');
    return `<div class="statline">
        <div><b>${wlt(x.record)}</b><span>overall</span></div>
        <div><b>${wlt(x.home)}</b><span>home</span></div>
        <div><b>${wlt(x.away)}</b><span>away</span></div>
        ${x.streak ? `<div><b>${x.streak}</b><span>streak</span></div>` : ''}
      </div>
      ${dots ? `<div class="small muted last5">Last ${x.last5.length}: ${dots}</div>` : ''}
      <div class="small muted">Points per game: <b>${x.ppg?.toFixed(1) ?? '–'}</b> scored · <b>${x.papg?.toFixed(1) ?? '–'}</b> allowed · <b class="${netClass(x.margin ?? 0)}">${signedPts(x.margin)}</b> margin</div>`;
  };
  const injuriesNote = 'Roster position, depth-chart standing, and how long they\'ve carried the tag. From ESPN, refreshed every few hours.';
  const injuriesBody = (x) => injuryTable(x.injuries ?? []);
  const statsBody = (x) => (x.advGames
    ? `${advTable(x, x, 'Offense', 'Defense')}
      <div class="small muted">Turnover margin <b class="${netClass(x.turnoverMargin ?? 0)}">${signedPts(x.turnoverMargin)}</b>/gm${x.turnoverMarginRank ? ` (${ordinal(x.turnoverMarginRank)})` : ''}
        · Time of possession <b>${mmss(x.possessionPerGame)}</b>/gm
        · Penalties <b>${fmt1(x.penaltiesPerGame)}</b> for <b>${fmt1(x.penaltyYdsPerGame)}</b> yds/gm${x.penaltyYdsPerGameRank ? ` (${ordinal(x.penaltyYdsPerGameRank)} fewest)` : ''}</div>`
    : '<p class="small muted">No box scores yet for their finished games.</p>');
  const atsBody = (x) => `${x.atsGames ? `<div class="statline">
        <div><b>${wlt(x.ats)}</b><span>ATS${wlPct(x.ats)}</span></div>
        <div><b>${wlt(x.atsFav)}</b><span>as favorite</span></div>
        <div><b>${wlt(x.atsDog)}</b><span>as underdog</span></div>
      </div>
      <div class="small muted">Home ${wlt(x.atsHome)} · Away ${wlt(x.atsAway)} · Beats the spread by <b>${signedPts(x.coverAvg)}</b> pts a game on average</div>`
      : '<p class="small muted">No lines on file for their games yet.</p>'}
      <h4>Over / under</h4>
      ${x.ou.w + x.ou.l + x.ou.t ? `<div class="small">Overs <b>${x.ou.w}</b> · Unders <b>${x.ou.l}</b>${x.ou.t ? ` · Pushes ${x.ou.t}` : ''}</div>
        <div class="small muted">Their games average <b>${x.avgTotal.toFixed(1)}</b> points vs. a <b>${x.avgLineTotal.toFixed(1)}</b> line</div>`
      : '<p class="small muted">No totals on file yet.</p>'}`;
  const sosNote = `Opponents' combined win % this season. 1st = hardest of ${teams.length}.`;
  // College: ESPN has no injury reports to speak of, so that card is left out.
  const showInjuries = data.injuries !== false;
  // College opponents outside the Power 5 have no page of their own.
  const hasPage = (name) => teams.some((x) => x.name === name);
  const sosBody = (x) => `<div class="statline">
        <div><b>${winPctText(x.sosPlayed)}</b><span>played${x.sosPlayedRank ? ` · ${ordinal(x.sosPlayedRank)}` : ''}</span></div>
        <div><b>${winPctText(x.sosLeft)}</b><span>still to play${x.sosLeftRank ? ` · ${ordinal(x.sosLeftRank)}` : ''}</span></div>
      </div>`;
  const logBody = (x) => `<table class="slip log">
        <thead><tr><th>Wk</th><th>Opp</th><th>Result</th><th class="num">Spread</th><th class="num">Total</th></tr></thead>
        <tbody>${x.log.map((e) => `<tr class="${e.final ? '' : 'upcoming'}">
          <td>${e.week}</td>
          <td>${e.home ? '' : '@'}${teamLogo(e.oppName, 'small')}${esc(e.oppAbbr ?? e.opp)}</td>
          <td>${e.final ? `<b class="${e.result === 'W' ? 'pos' : e.result === 'L' ? 'neg' : ''}">${e.result}</b> ${esc(e.score)}` : `<span class="muted small">${esc(day(e.date))}</span>`}</td>
          <td class="num">${esc(lineText(e.line))} ${mark(e.cover)}</td>
          <td class="num">${e.total ?? '–'}${e.ou ? ` <span class="muted">${e.ou}</span>` : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`;
  const note = (text) => (text ? `<p class="small muted">${text}</p>` : '');
  const sourcesNote = `<p class="small muted">Scores and lines come from ESPN (the closing line for finished games); games ESPN has no line for use the ${esc(data.book ?? 'sportsbook')} line saved here.
      ✓ = covered the spread, O/U = went over or under the total. A season is a small sample, and the line already prices in most of what these numbers show.</p>`;

  if (researchMode === 'compare') {
    if (!teams.some((x) => x.name === compareA)) compareA = t.name;
    if (!teams.some((x) => x.name === compareB) || compareB === compareA) {
      compareB = teams.find((x) => x.name === next?.oppName)?.name ?? teams.find((x) => x.name !== compareA)?.name;
    }
    const a = teams.find((x) => x.name === compareA);
    const b = teams.find((x) => x.name === compareB);
    const matchup = (off, def) => foldCard(`compare-${off === a ? 'ab' : 'ba'}`,
      `${teamLogo(off.name, 'small')}${esc(off.short)} offense vs ${teamLogo(def.name, 'small')}${esc(def.short)} defense`,
      a.advGames || b.advGames ? advTable(off, def, `${off.short} off`, `${def.short} def`) : '<p class="small muted">No box scores yet.</p>');
    // One section of the Team page, with both teams side by side.
    const pair = (id, title, text, body) => foldCard(`compare-${id}`, title, `${note(text)}<div class="pair">${[a, b].map((x) => `
      <div class="pair-col"><div class="pair-name">${teamLogo(x.name)}<b>${esc(x.short)}</b></div>${body(x)}</div>`).join('')}</div>`);
    $('#research').innerHTML = `
      ${modeSwitch}
      <div class="team-pick">${teamPick('compare-a', a.name)}<span class="muted small">vs</span>${teamPick('compare-b', b.name)}</div>
      ${matchup(a, b)}
      ${matchup(b, a)}
      <p class="small muted">Per game this season from ESPN's box scores. Ranks are out of ${teams.length} (1st = best). A season is a small sample.</p>
      ${pair('record', 'Record', '', recordBody)}
      ${showInjuries ? pair('injuries', 'Injuries', injuriesNote, injuriesBody) : ''}
      ${pair('stats', 'Offensive/Defensive Stats', 'Per game this season. Offense is what they do; defense is what they allow.', statsBody)}
      ${pair('ats', 'Against the spread', '', atsBody)}
      ${pair('sos', 'Strength of schedule', sosNote, sosBody)}
      ${pair('log', 'Game log', '', logBody)}
      ${sourcesNote}`;
    return;
  }

  const html = `
    ${modeSwitch}
    <label class="team-pick">${teamPick('research-team', t.name)}</label>
    ${next ? `<div class="card next-game">
      <div class="next-line"><span class="muted">Next game</span> <b>${next.home ? 'vs' : '@'} ${teamLogo(next.oppName)}${esc(next.opp)}</b> <span>${esc(kickTime(next.date))}</span>
        ${next.line != null ? `<span class="small muted line-info">· Spread ${esc(lineText(next.line))}${next.total != null ? ` · Total ${next.total}` : ''}</span>` : ''}</div>
      ${hasPage(next.oppName) ? `<button type="button" class="link small" data-team="${esc(next.oppName)}" aria-label="See ${esc(next.opp)}"><span class="see-text">See ${teamLogo(next.oppName, 'small')}${esc(next.opp)} </span>→</button>` : ''}
    </div>` : ''}
    ${foldCard('team-record', 'Record', recordBody(t))}
    ${showInjuries ? foldCard('team-injuries', 'Injuries', note(injuriesNote) + injuriesBody(t)) : ''}
    ${foldCard('team-stats', 'Offensive/Defensive Stats', note(`Per game this season${t.advGames ? `, from ${t.advGames} box score${t.advGames === 1 ? '' : 's'}` : ''}. Offense is what they do; defense is what they allow.`) + statsBody(t))}
    ${foldCard('team-ats', 'Against the spread', atsBody(t))}
    ${foldCard('team-sos', 'Strength of schedule', note(sosNote) + sosBody(t))}
    ${foldCard('team-log', 'Game log', logBody(t))}
    ${sourcesNote}`;
  $('#research').innerHTML = html;
}

// League view: how favorites, underdogs, home teams, and overs are doing, then
// every team ranked against the spread and on over/unders. Tap a team to
// open its page.
function leagueHtml(teams) {
  const sum = (key) => teams.reduce((r, t) => ({ w: r.w + t[key].w, l: r.l + t[key].l, t: r.t + t[key].t }), { w: 0, l: 0, t: 0 });
  const rate = (r) => (r.w + r.l ? r.w / (r.w + r.l) : null);
  const pctTxt = (p) => (p == null ? '–' : `${Math.round(p * 100)}%`);
  // Each game shows up once as a favorite and once as an underdog (and once
  // home, once away). Each total shows up twice (both teams), so halve it.
  const fav = sum('atsFav');
  const dog = sum('atsDog');
  const home = sum('atsHome');
  const away = sum('atsAway');
  const ou = sum('ou');
  const overs = { w: ou.w / 2, l: ou.l / 2, t: ou.t / 2 };
  const trend = (label, r, note) => `<div><b>${pctTxt(rate(r))}</b><span>${label}</span><span class="small">${note}</span></div>`;
  const trends = `<div class="card"><h3>League trends</h3>
    <p class="small muted">Every game with a line this season.</p>
    <div class="statline trends">
      ${trend('favorites cover', fav, wlt(fav))}
      ${trend('underdogs cover', dog, wlt(dog))}
      ${trend('home teams cover', home, wlt(home))}
      ${trend('road teams cover', away, wlt(away))}
      ${trend('overs hit', overs, `${overs.w}-${overs.l}${overs.t ? `-${overs.t}` : ''}`)}
    </div></div>`;

  const row = (t, i, cells) => `<tr class="team-row" data-team="${esc(t.name)}"><td class="rank">${i + 1}</td>
    <td>${teamLogo(t.name, 'small')}<b>${esc(t.short ?? t.name)}</b></td>${cells}</tr>`;
  const ats = teams.filter((t) => t.atsGames)
    .sort((a, b) => rate(b.ats) - rate(a.ats) || b.coverAvg - a.coverAvg);
  const atsTable = `<div class="card"><h3>Against the spread</h3>
    <p class="small muted">Best cover rate first. "+/−" is how many points a game they beat (or missed) the spread by, on average.</p>
    ${ats.length ? `<table class="slip league"><thead><tr><th></th><th>Team</th><th class="num">ATS</th><th class="num">Cover</th><th class="num">+/−</th></tr></thead>
      <tbody>${ats.map((t, i) => row(t, i, `<td class="num">${wlt(t.ats)}</td><td class="num">${pctTxt(rate(t.ats))}</td>
        <td class="num ${netClass(t.coverAvg)}">${signedPts(t.coverAvg)}</td>`)).join('')}</tbody></table>`
      : '<p class="small muted">No lines on file yet.</p>'}</div>`;

  const ouTeams = teams.filter((t) => t.ou.w + t.ou.l + t.ou.t)
    .sort((a, b) => rate(b.ou) - rate(a.ou) || (b.avgTotal - b.avgLineTotal) - (a.avgTotal - a.avgLineTotal));
  const ouTable = `<div class="card"><h3>Over / under</h3>
    <p class="small muted">Most overs first. "Pts vs line" is how far their games' scoring lands above or below the total, on average.</p>
    ${ouTeams.length ? `<table class="slip league"><thead><tr><th></th><th>Team</th><th class="num">O-U</th><th class="num">Over</th><th class="num">Pts vs line</th></tr></thead>
      <tbody>${ouTeams.map((t, i) => row(t, i, `<td class="num">${t.ou.w}-${t.ou.l}${t.ou.t ? `-${t.ou.t}` : ''}</td><td class="num">${pctTxt(rate(t.ou))}</td>
        <td class="num">${signedPts(t.avgTotal - t.avgLineTotal)}</td>`)).join('')}</tbody></table>`
      : '<p class="small muted">No totals on file yet.</p>'}</div>`;

  return `${trends}${atsTable}${ouTable}
    <p class="small muted">Tap a team to see its page. Lines are ESPN's closing lines. A few weeks is a small sample, and the lines adjust to these trends quickly.</p>`;
}

let placingId = null; // Bet Slip parlay whose payout box is open

// quiet: same as renderParlays (no placeholder, keep your scroll spot).
async function renderSlip(quiet = false) {
  const y = window.scrollY;
  if (!quiet) $('#slip').innerHTML = '<p class="muted">Loading…</p>';
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
    const legs = p.legs.map((l) => `<li>${gradeMark(l.grade) || '<span class="mark">·</span>'}<span><b>${betLabel(l.label)}</b> <span class="muted">${fmtOdds(l.price)}</span>${legSub(l)}${l.grade === 'pending' ? lineMoved(l, data.book) : ''}</span></li>`).join('');
    const rows = Object.entries(p.stakes).map(([who, amt]) => `<tr>
        <td>${esc(who)}${who === me && !p.placed && !past ? ` <button type="button" class="link danger" data-slip-out="${esc(p.id)}">remove</button>` : ''}</td>
        <td class="num">${money(amt)}</td><td class="num">${money(amt * (p.decimal - 1))}</td><td class="num">${money(amt * p.decimal)}</td></tr>`).join('');
    return `<div class="card parlay ${p.placed ? 'placed' : ''} ${p.status !== 'pending' ? `done ${p.status}` : ''}">
      <div class="head">
        <div><span class="muted small">Bet ${i + 1}</span> ${p.placed ? '<span class="chip placed">✓ Placed</span>' : ''} ${statusChip(p.status, p.returned, p.total)} ${p.paidOut ? '<span class="chip paid">💵 Paid out</span>' : ''}${titleHtml(p, !past)}<div class="small muted">${betKind(p)}</div></div>
        <div class="odds-col"><div class="odds">${fmtOdds(shownOdds(p))}</div>${copyButton(p)}</div>
      </div>
      ${p.sameGame && !p.placed?.payout && !past ? `<div class="lines">Same-game parlay: ${esc(data.book ?? 'the sportsbook')} prices these together, so the real payout will differ from this estimate. Enter it when you mark it placed.</div>` : ''}
      ${p.stillOption || p.placed || past ? '' : '<div class="lines">Picks changed since people bought in, so this parlay is no longer one of the current options. Double-check before placing it.</div>'}
      <ul class="graded-legs">${legs}</ul>
      <table class="slip">
        <thead><tr><th>Who</th><th class="num">Stake</th><th class="num">Profit</th><th class="num">Payout</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${money(p.total)}</th><th class="num">${money(p.payout - p.total)}</th><th class="num">${money(p.payout)}</th></tr></tfoot>
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
      ${past ? '' : `<div class="small muted">Profit and Payout are if the parlay hits, at the odds shown. Payout includes the stake.
      Check each leg in ${esc(data.book ?? 'your sportsbook')} before placing; anything marked "Line moved" will pay differently.</div>`}
    </div>
    ${cards}
    <div class="card"><b>Who owes what</b>
      <table class="slip"><tbody>${totals}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${money(grand)}</th></tr></tfoot></table>
    </div>`;
  if (quiet) window.scrollTo(0, y);
}

// ---- Events --------------------------------------------------------------

// Remember which props sections are open across re-draws.
$('#games').addEventListener('toggle', (e) => {
  const box = e.target.closest?.('details[data-props]');
  if (!box) return;
  if (box.open) openProps.add(box.dataset.props);
  else openProps.delete(box.dataset.props);
}, true);
$('#games').addEventListener('click', (e) => {
  const all = e.target.closest('[data-all-td]');
  if (all) {
    allScorers.add(all.dataset.allTd);
    return renderGames();
  }
  const drop = e.target.closest('[data-drop]');
  if (drop) {
    calcKeys.delete(drop.dataset.drop);
    if (!calcKeys.size) calcFrom = null;
    return renderGames();
  }
  const swap = e.target.closest('[data-swap-to]');
  if (swap) {
    calcKeys.delete(swap.dataset.swapFrom);
    calcKeys.add(swap.dataset.swapTo);
    return renderGames();
  }
  const lock = e.target.closest('[data-lock]');
  if (lock) return toggleLock(lock.dataset.lock);
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
  const box = document.querySelector('.builder');
  if (box) box.outerHTML = builderHtml();
  if (line) line.innerHTML = `$${esc(calcStake)} pays <b>${money(calcStake * decimal)}</b> (profit ${money(calcStake * decimal - calcStake)})`;
});
$('#submit-bar').addEventListener('click', (e) => {
  if (e.target.closest('#submit-picks')) submit();
  if (e.target.closest('#edit-picks')) startEditing();
  if (e.target.closest('#copy-picks')) copyPicks(e.target.closest('#copy-picks'));
  if (e.target.closest('#calc-clear')) {
    calcKeys.clear();
    calcFrom = null;
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
$('#heatmap').addEventListener('change', (e) => {
  if (e.target.id !== 'heat-game') return;
  heatGame = e.target.value;
  renderHeatmap();
});
$('#back-to-now').addEventListener('click', () => goWeek(null));
$('#stats').addEventListener('click', (e) => {
  const scope = e.target.closest('[data-scope]')?.dataset.scope;
  if (!scope || scope === statsScope) return;
  statsScope = scope;
  renderStats();
});
$('#research').addEventListener('change', (e) => {
  if (e.target.id === 'research-team') {
    researchTeam = e.target.value;
    storage.set(teamStorageKey(), researchTeam);
    renderResearch(true);
    window.scrollTo(0, 0);
  } else if (e.target.id === 'compare-a') {
    compareA = e.target.value;
    renderResearch(true);
  } else if (e.target.id === 'compare-b') {
    compareB = e.target.value;
    renderResearch(true);
  }
});
$('#research').addEventListener('click', (e) => {
  const head = e.target.closest('.fold-head');
  if (head) {
    const card = head.closest('.fold');
    const shut = card.classList.toggle('folded');
    if (shut) folded.add(card.dataset.fold);
    else folded.delete(card.dataset.fold);
    head.setAttribute('aria-expanded', String(!shut));
    return;
  }
  const mode = e.target.closest('#research-mode button')?.dataset.mode;
  if (mode) {
    researchMode = mode;
    renderResearch(true);
    window.scrollTo(0, 0);
    return;
  }
  const go = e.target.closest('[data-team]');
  if (!go) return;
  researchMode = 'team'; // a tapped team (league list or "See ...") opens its page
  researchTeam = go.dataset.team;
  storage.set('parlay.team', researchTeam);
  renderResearch(true);
  window.scrollTo(0, 0);
});
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button');
  btn.disabled = true;
  $('#login-error').hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: { username: form.username.value, password: form.password.value } });
    form.password.value = '';
    $('#week-nav').hidden = $('#sport-switch').hidden = false;
    await load();
  } catch (err) {
    $('#login-error').textContent = err.message;
    $('#login-error').hidden = false;
  }
  btn.disabled = false;
});
// Renaming works the same on the Parlays tab and the Bet Slip.
document.addEventListener('click', async (e) => {
  const start = e.target.closest('[data-rename-start]');
  if (start) {
    renamingId = start.dataset.renameStart;
    await rerenderParlayTab();
    const input = document.querySelector('.rename-form input');
    input?.focus();
    input?.select();
  }
  if (e.target.closest('[data-rename-cancel]')) {
    renamingId = null;
    rerenderParlayTab();
  }
});
// Capture phase, so the tabs' own form handlers (stakes, payouts) never see it.
document.addEventListener('submit', async (e) => {
  const form = e.target.closest?.('.rename-form');
  if (!form) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    await api('/api/rename', { method: 'POST', body: { name: me, id: form.dataset.rename, title: form.elements.parlayName.value } });
    renamingId = null;
    notice(null);
  } catch (err) {
    notice(err.message);
  }
  rerenderParlayTab();
}, true);
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
  setStake(e.target.dataset.parlay, amount, () => renderParlays(true));
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
  if (e.target.closest('[data-act="out"]')) setStake(e.target.closest('form').dataset.parlay, 0, () => renderParlays(true));
  // Money on a parlay counts as a 👍, so it can't change until the stake is removed.
  const vote = e.target.closest('[data-like], [data-down]');
  if (vote?.dataset.staked) {
    notice('You have money on this parlay, so it counts as a 👍. Remove your stake first if you want to change that.');
    return;
  }
  if (vote) {
    vote.disabled = true;
    react(vote.dataset.like ? 'parlay' : 'parlay-down', vote.dataset.like ?? vote.dataset.down, vote.dataset.val === '1');
  }
  const dislike = e.target.closest('[data-dislike]');
  if (dislike) {
    dislike.disabled = true;
    react('leg', dislike.dataset.dislike, dislike.dataset.val === '1');
  }
  const copy = e.target.closest('[data-edit-copy]');
  if (copy && editable.has(copy.dataset.editCopy)) copyAndEdit(editable.get(copy.dataset.editCopy));
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
  renderSlip(true);
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
    renderSlip(true);
    return;
  }
  const open = e.target.closest('[data-edit-payout]');
  if (open) {
    placingId = open.dataset.editPayout;
    await renderSlip(true);
    $('.payout-form input')?.select();
    return;
  }
  if (e.target.closest('[data-act="cancel-place"]')) {
    placingId = null;
    renderSlip(true);
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
    renderSlip(true);
    return;
  }
  const btn = e.target.closest('[data-slip-out]');
  if (btn) setStake(btn.dataset.slipOut, 0, () => renderSlip(true));
});
$('#who').addEventListener('click', (e) => {
  if (e.target.closest('#logout')) {
    api('/api/logout', { method: 'POST' }).catch(() => {});
    storage.del('parlay.name');
    notice(null);
    showLogin();
    return;
  }
  if (e.target.closest('#switch')) {
    me = null;
    storage.del('parlay.name');
    showJoin();
  }
});
const limitText = () =>
  `Lines update on their own at 11 AM and 6 PM Eastern, plus ${week.manualPerSunday} extra refreshes on ${league === 'cfb' ? 'Saturdays' : 'Sundays'}, to stay under the free 500 API credits a month. Showing lines from ${new Date(week.linesUpdated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;

$('#schedule-meta').addEventListener('click', async (e) => {
  const btn = e.target.closest('#refresh');
  if (!btn) return;
  if (!week?.manualLeft) return notice(limitText());
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

$('#sport-switch').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sport]');
  if (btn) switchLeague(btn.dataset.sport);
});

renderLeague();
load();
