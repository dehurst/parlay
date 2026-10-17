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
let tab = 'picks';
let parlayLegs = new Map(); // parlay id -> leg keys, for voting

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
  try {
    week = await api(`/api/week?${params}`);
  } catch (err) {
    notice(err.message);
    return;
  }
  notice(week.warning);
  $('#week-label').textContent = week.label;
  const time = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  $('#schedule-meta').textContent = [
    `Schedule: ${week.demo ? 'demo games' : week.source}`,
    week.book && week.linesUpdated && `${week.book} lines updated ${time(week.linesUpdated)}`,
    week.creditsLeft && `${week.creditsLeft} API credits left`,
  ].filter(Boolean).join(' · ');
  $('#refresh').hidden = !week.book;

  if (me && !week.players.includes(me)) me = null;
  if (!me) return showJoin();
  $('#join').hidden = true;
  $('#tabs').hidden = false;
  render();
}

function renderWho() {
  const hasAny = hasSubmitted() || (week.draft ?? []).length > 0;
  $('#who').innerHTML = `<span class="muted">Picking as</span> <b>${esc(me)}</b>
    <button class="link" id="switch" type="button">switch</button>
    ${hasAny ? '<button id="clear-picks" class="clear" type="button">Clear my picks</button>' : ''}`;
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

// Friends who submitted this bet.
function votersFor(key) {
  return Object.entries(week.picks).filter(([, picks]) => picks.some((p) => p.key === key)).map(([name]) => name);
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
}

function renderGames() {
  renderWho();
  const locked = isLocked();
  $('#picks-hint').textContent = locked
    ? `Your picks are in for ${week.label}. Tap Edit picks to change them before kickoff. Orange numbers show how many friends took each bet.`
    : isEditing()
      ? 'Editing your picks. Your submitted picks still count until you resubmit. Picks you keep stay at the line you got.'
      : `Tap a bet to select it at ${week.book ?? 'the sportsbook'}'s line, tap again to remove it. Hit Submit when you're done. Orange numbers show how many friends have submitted each bet.`;

  if (!week.games.length) {
    $('#games').innerHTML = '<div class="card muted">No games on the schedule this week.</div>';
    renderSubmitBar();
    return;
  }
  // Picks on started games can't change, so they stay selected while editing.
  const startedPicks = (submittedPicks() ?? []).filter((p) => gameOf(p.key)?.started).map((p) => p.key);
  const mine = new Set(locked ? submittedPicks().map((p) => p.key) : [...(week.draft ?? []), ...startedPicks]);
  // Bets you already submitted show the line you got, not today's line.
  const savedLine = new Map((submittedPicks() ?? []).filter((p) => mine.has(p.key)).map((p) => [p.key, p]));

  $('#games').innerHTML = week.games.map((g) => {
    const cell = (market, side) => {
      const key = `${g.id}|${market}|${side}`;
      const voters = votersFor(key);
      const line = savedLine.get(key) ?? bookLine(key);
      let label = market === 'ml' ? 'ML' : '–';
      if (line && market === 'spread') label = fmtPoint(line.point);
      if (line && market === 'total') label = `${side === 'over' ? 'O' : 'U'} ${line.point}`;
      const disabled = locked || g.started || !line;
      return `<button class="pick ${mine.has(key) ? 'on' : ''}" data-key="${esc(key)}" ${disabled ? 'disabled' : ''}
        title="${esc(voters.join(', ') || (line ? 'No picks yet' : 'No line yet'))}">
        <span class="line">${esc(label)}</span>
        <span class="price">${line ? fmtOdds(line.price) : 'N/A'}</span>
        ${voters.length ? `<span class="votes">${voters.length}</span>` : ''}
      </button>`;
    };
    const kick = new Date(g.commence).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const row = (team, side, totalSide) => `
      <div class="team" title="${esc(team)}">${esc(side === 'home' ? g.homeShort : g.awayShort)}</div>
      ${cell('spread', side)}${cell('total', totalSide)}${cell('ml', side)}`;
    return `<div class="card" data-game="${esc(g.id)}">
      <div class="game-head">
        <h3>${esc(g.away)} @ ${esc(g.home)}</h3>
        <span class="${g.started ? 'locked' : 'muted small'}">${g.started ? 'Started' : kick}</span>
      </div>
      <div class="game-grid ${locked ? 'is-locked' : ''}">
        <div></div><div class="colhead">Spread</div><div class="colhead">Total</div><div class="colhead">Moneyline</div>
        ${row(g.away, 'away', 'over')}
        ${row(g.home, 'home', 'under')}
      </div>
    </div>`;
  }).join('');
  renderSubmitBar();
}

function renderSubmitBar() {
  const bar = $('#submit-bar');
  bar.hidden = tab !== 'picks';
  const plural = (n) => `${n} pick${n === 1 ? '' : 's'}`;
  if (isLocked()) {
    bar.innerHTML = `<span><b>Submitted:</b> ${plural(submittedPicks().length)}</span>
      <span class="actions">
        <button type="button" id="edit-picks">Edit picks</button>
        <button type="button" data-tab-go="parlays">See parlays</button>
      </span>`;
    return;
  }
  const n = (week.draft ?? []).length;
  bar.innerHTML = `<span>${n ? `<b>${n}</b> pick${n === 1 ? '' : 's'} selected` : 'No picks selected yet'}</span>
    <span class="actions">
      ${isEditing() ? '<button type="button" id="cancel-edit">Cancel</button>' : ''}
      <button type="button" class="primary" id="submit-picks" ${n ? '' : 'disabled'}>${isEditing() ? 'Resubmit' : 'Submit picks'}</button>
    </span>`;
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
  const data = await api('/api/parlays').catch((err) => (notice(err.message), null));
  if (!data) return;
  const done = Object.keys(week.picks);
  const waiting = week.players.filter((p) => !done.includes(p));
  const header = `<div class="card">
    <b>${done.length}</b> of ${week.players.length} have submitted.
    ${waiting.length ? `<span class="muted">Waiting on: ${waiting.map(esc).join(', ')}</span>` : ''}
    ${done.length ? `<div class="small muted">A bet needs ${data.need}+ votes to count as consensus.</div>` : ''}
  </div>`;
  if (!data.tallied.length) {
    $('#board').innerHTML = header + '<div class="card muted">No submitted picks yet this week.</div>';
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

async function renderParlays() {
  const stake = Number($('#stake').value) || 10;
  $('#parlays').innerHTML = '<p class="muted">Building…</p>';
  const data = await api(`/api/parlays?stake=${stake}`).catch((err) => (notice(err.message), null));
  if (!data) return;

  if (!data.voters) {
    $('#parlays').innerHTML = '<div class="card muted">Nobody has submitted picks yet.</div>';
    return;
  }

  let html = '';
  if (!data.options.length) {
    html += `<div class="card">
      <b>Not enough agreement yet.</b>
      <p class="muted">Parlays need at least 2 games where ${data.need}+ of the ${data.voters} who submitted agree.
      Right now there ${data.consensus.length === 1 ? 'is 1 such bet' : `are ${data.consensus.length}`}.</p>
    </div>`;
  }

  parlayLegs = new Map(data.options.map((p) => [p.id, p.legs.map((l) => l.key)]));
  const majority = Math.floor(data.players.length / 2) + 1;
  html += data.options.map((p) => {
    const iVoted = p.votes.includes(me);
    const groupPick = p.votes.length >= majority;
    return `
    <div class="card parlay ${groupPick ? 'group-pick' : ''}">
      <div class="head">
        <div>
          ${groupPick ? '<span class="badge">Group\'s pick</span>' : ''}
          <h3>${esc(p.name)}</h3><div class="small muted">${esc(p.blurb)}</div>
        </div>
        <div class="odds">${fmtOdds(p.american)}</div>
      </div>
      <ul>${p.legs.map((l) => `<li><b>${esc(l.label)}</b> <span class="muted">${fmtOdds(l.price)} · ${esc(l.matchup)} · ${l.pickers.length}/${data.voters} picked</span>${lineMoved(l, data.book)}</li>`).join('')}</ul>
      <div class="stats">
        <span>${money(p.stake)} pays <b>${money(p.payout)}</b></span>
        <span>Hit chance ~<b>${pct(p.hitProb)}</b></span>
        <span class="${p.ev < 0 ? 'ev-bad' : ''}">Est. return ${p.ev >= 0 ? '+' : ''}${(p.ev * 100).toFixed(1)}%</span>
      </div>
      <div class="vote-row">
        <button type="button" class="vote ${iVoted ? 'on' : ''}" data-parlay="${esc(p.id)}" data-vote="${iVoted ? '0' : '1'}">
          ${iVoted ? '✓ You voted for this' : '👍 Vote for this'}
        </button>
        <span class="small muted">${p.votes.length
          ? `${p.votes.length}/${data.players.length} votes: ${p.votes.map(esc).join(', ')}`
          : 'No votes yet'}</span>
      </div>
    </div>`;
  }).join('');

  if (data.almost.length) {
    html += `<div class="card"><b>One vote away</b>
      <p class="small muted">These would join the consensus with one more pick:</p>
      <ul>${data.almost.map((s) => `<li>${esc(s.label)} <span class="muted">${fmtOdds(s.price)} · ${s.pickers.map(esc).join(', ')}</span></li>`).join('')}</ul>
    </div>`;
  }

  html += `<p class="small muted">Payouts use the lines at the time each pick was submitted${data.book ? `, which can drift from ${esc(data.book)}'s current lines` : ''}, so double-check them in your sportsbook before you bet.
    Hit chance is a rough estimate that removes a typical book margin. A negative expected return is the house edge,
    and parlays stack it on every leg.</p>`;
  $('#parlays').innerHTML = html;
}

// ---- Events --------------------------------------------------------------

$('#games').addEventListener('click', (e) => {
  const btn = e.target.closest('.pick');
  if (btn && !btn.disabled) toggle(btn.dataset.key);
});
$('#submit-bar').addEventListener('click', (e) => {
  if (e.target.closest('#submit-picks')) submit();
  if (e.target.closest('#edit-picks')) startEditing();
  if (e.target.closest('#cancel-edit')) cancelEditing();
  const go = e.target.closest('[data-tab-go]')?.dataset.tabGo;
  if (go) {
    tab = go;
    render();
  }
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
$('#stake').addEventListener('change', renderParlays);
$('#parlays').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-parlay]');
  if (!btn) return;
  btn.disabled = true;
  try {
    await api('/api/vote', {
      method: 'POST',
      body: { name: me, legs: parlayLegs.get(btn.dataset.parlay), vote: btn.dataset.vote === '1' },
    });
  } catch (err) {
    notice(err.message);
  }
  renderParlays();
});
$('#who').addEventListener('click', (e) => {
  if (e.target.closest('#switch')) {
    me = null;
    storage.del('parlay.name');
    showJoin();
  }
  if (e.target.closest('#clear-picks')) clearPicks();
});
$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  const wait = (week?.nextRefreshAt ?? 0) - Date.now();
  if (wait > 0) {
    const ago = Math.max(1, Math.round((Date.now() - week.linesUpdated) / 60e3));
    notice(`Lines were updated ${ago} min ago. To save API credits you can refresh again in ${Math.ceil(wait / 60e3)} min.`);
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  await load(true);
  btn.disabled = false;
  btn.textContent = '↻ Refresh lines';
});

load();
