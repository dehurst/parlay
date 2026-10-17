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
  if (tab === 'slip') renderSlip();
  if (tab === 'stats') renderStats();
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
  $('#parlays').innerHTML = '<p class="muted">Building…</p>';
  const data = await api('/api/parlays').catch((err) => (notice(err.message), null));
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

  const majority = Math.floor(data.players.length / 2) + 1;
  html += data.options.map((p) => {
    const mine = p.stakes[me];
    const backers = Object.entries(p.stakes);
    const total = backers.reduce((sum, [, amt]) => sum + amt, 0);
    const groupPick = backers.length >= majority;
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
      <form class="stake-form" data-parlay="${esc(p.id)}">
        <label>Your stake $
          <input name="amount" type="number" inputmode="decimal" min="0" step="1" value="${mine ?? ''}" placeholder="10">
        </label>
        <button type="submit" class="${mine ? '' : 'primary'}">${mine ? 'Update' : "I'm in"}</button>
        ${mine ? '<button type="button" class="link danger" data-act="out">Remove</button>' : ''}
      </form>
      <div class="small muted backers">${backers.length
        ? `${backers.map(([who, amt]) => `${esc(who)} ${money(amt)}`).join(' · ')} · <b>${money(total)} total</b>, pays ${money(total * p.decimal)}`
        : 'Nobody is in yet'}</div>
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
  const data = await api('/api/stats').catch((err) => (notice(err.message), null));
  if (!data) return;
  if (!data.weeks.length) {
    $('#stats').innerHTML = '<div class="card muted">No history yet. Stats show up once games people picked have finished.</div>';
    return;
  }
  const pr = data.parlays;
  const people = [...data.players].sort((a, b) => b.net - a.net);
  const money_ = `<div class="card"><h3>Season money</h3>
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
  const picksCard = `<div class="card"><h3>Pick records</h3>
    <p class="small muted">Every submitted pick graded as a single bet. "$10 a pick" is what you'd be up or down betting $10 on each one.</p>
    <table class="slip">
      <thead><tr><th>Who</th><th class="num">W-L-P</th><th class="num">$10 a pick</th></tr></thead>
      <tbody>${[...data.players].sort((a, b) => b.flatNet - a.flatNet).map((p) => `<tr>
        <td>${esc(p.name)}<div class="small muted">ATS ${recordText(p.byMarket.spread)} · Totals ${recordText(p.byMarket.total)} · ML ${recordText(p.byMarket.ml)}</div></td>
        <td class="num">${recordText(p.picks)}</td><td class="num ${netClass(p.flatNet)}">${signed(p.flatNet)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th>Group consensus<div class="small muted">Bets most of you agreed on</div></th><th class="num">${recordText(c)}</th><th></th></tr></tfoot>
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

  $('#stats').innerHTML = parlayCard + money_ + picksCard + `<h3 class="section">Week by week</h3>` + weeks;
}

async function renderSlip() {
  $('#slip').innerHTML = '<p class="muted">Loading…</p>';
  const data = await api('/api/slip').catch((err) => (notice(err.message), null));
  if (!data) return;
  if (!data.parlays.length) {
    $('#slip').innerHTML = '<div class="card muted">Nobody has put money on a parlay yet. Do that on the Parlays tab.</div>';
    return;
  }
  const grand = data.parlays.reduce((sum, p) => sum + p.total, 0);
  const cards = data.parlays.map((p, i) => {
    const legs = p.legs.map((l) => `<li>${gradeMark(l.grade)}<b>${esc(l.label)}</b> <span class="muted">${fmtOdds(l.price)} · ${esc(l.matchup)}</span>${l.grade === 'pending' ? lineMoved(l, data.book) : ''}</li>`).join('');
    const rows = Object.entries(p.stakes).map(([who, amt]) => `<tr>
        <td>${esc(who)}${who === me ? ` <button type="button" class="link danger" data-slip-out="${esc(p.id)}">remove</button>` : ''}</td>
        <td class="num">${money(amt)}</td><td class="num">${money(amt * p.decimal)}</td></tr>`).join('');
    return `<div class="card parlay">
      <div class="head">
        <div><span class="muted small">Bet ${i + 1}</span> ${statusChip(p.status, p.returned, p.total)}<h3>${esc(p.name)} · ${p.legs.length}-leg parlay</h3></div>
        <div class="odds">${fmtOdds(p.american)}</div>
      </div>
      ${p.stillOption ? '' : '<div class="lines">Picks changed since people bought in, so this parlay is no longer one of the current options. Double-check before placing it.</div>'}
      <ul>${legs}</ul>
      <table class="slip">
        <thead><tr><th>Who</th><th class="num">Stake</th><th class="num">Wins</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><th>Total</th><th class="num">${money(p.total)}</th><th class="num">${money(p.payout)}</th></tr></tfoot>
      </table>
    </div>`;
  }).join('');
  const totals = Object.entries(data.totals).map(([who, amt]) => `<tr><td>${esc(who)}</td><td class="num">${money(amt)}</td></tr>`).join('');
  $('#slip').innerHTML = `
    <div class="card"><b>${data.parlays.length} parlay${data.parlays.length === 1 ? '' : 's'} to place, ${money(grand)} total.</b>
      <div class="small muted">"Wins" is the total payout (stake included) if the parlay hits, at the odds shown.
      Check each leg in ${esc(data.book ?? 'your sportsbook')} before placing; anything marked "Line moved" will pay differently.</div>
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
$('#parlays').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="out"]')) setStake(e.target.closest('form').dataset.parlay, 0, renderParlays);
});
$('#slip').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-slip-out]');
  if (btn) setStake(btn.dataset.slipOut, 0, renderSlip);
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
