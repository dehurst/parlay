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
let editing = null; // { key, error }

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

async function load() {
  try {
    week = await api('/api/week');
  } catch (err) {
    notice(err.message);
    return;
  }
  notice(week.warning);
  $('#week-label').textContent = week.label;
  $('#schedule-meta').textContent = week.demo ? 'Schedule: demo games' : 'Schedule: ESPN';

  if (me && !week.players.includes(me)) me = null;
  if (!me) return showJoin();
  $('#join').hidden = true;
  $('#tabs').hidden = false;
  $('#who').innerHTML = `<span class="muted">Picking as</span> <b>${esc(me)}</b> <button class="link" id="switch">switch</button>`;
  $('#switch').onclick = () => { me = null; storage.del('parlay.name'); showJoin(); };
  render();
}

function showJoin() {
  $('#join').hidden = false;
  $('#tabs').hidden = true;
  $('#who').innerHTML = '';
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = true));
  $('#player-list').innerHTML = (week?.players ?? [])
    .map((p) => `<button type="button" data-name="${esc(p)}">${esc(p)}</button>`)
    .join('');
}

async function join(name) {
  try {
    const res = await api('/api/players', { method: 'POST', body: { name } });
    me = res.name;
    storage.set('parlay.name', me);
    load();
  } catch (err) {
    notice(err.message);
  }
}

// ---- Pick helpers --------------------------------------------------------

const myPicks = () => week.picks[me] ?? [];
const marketOf = (key) => key.split('|').slice(0, 2).join('|');

// Everyone's entries for one bet: [{ user, point, price }].
function entriesFor(key) {
  return Object.entries(week.picks).flatMap(([user, picks]) =>
    picks.filter((p) => p.key === key).map((p) => ({ user, ...p })));
}

function mostCommon(entries) {
  const counts = new Map();
  for (const e of entries) {
    const id = `${e.point}|${e.price}`;
    counts.set(id, { ...e, n: (counts.get(id)?.n ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0];
}

// What to pre-fill when you open a bet: your own entry, else the line friends
// used, else the mirror of the other side (Bills -3 means Dolphins +3).
function prefill(key) {
  const mine = myPicks().find((p) => p.key === key);
  if (mine) return mine;
  const same = mostCommon(entriesFor(key));
  if (same) return same;
  const [gameId, market, side] = key.split('|');
  const otherSide = { home: 'away', away: 'home', over: 'under', under: 'over' }[side];
  const other = mostCommon(entriesFor(`${gameId}|${market}|${otherSide}`));
  if (other && market === 'spread') return { point: -other.point, price: -110 };
  if (other && market === 'total') return { point: other.point, price: -110 };
  return { point: '', price: market === 'ml' ? '' : -110 };
}

// ---- Rendering -----------------------------------------------------------

function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${tab}`));
  if (tab === 'picks') renderGames();
  if (tab === 'board') renderBoard();
  if (tab === 'parlays') renderParlays();
}

function renderGames() {
  if (!week.games.length) {
    $('#games').innerHTML = '<div class="card muted">No games on the schedule this week.</div>';
    return;
  }
  const mine = new Map(myPicks().map((p) => [p.key, p]));
  $('#games').innerHTML = week.games.map((g) => {
    const cell = (market, side) => {
      const key = `${g.id}|${market}|${side}`;
      const entries = entriesFor(key);
      const pick = mine.get(key);
      const shown = pick ?? mostCommon(entries);
      let line = market === 'total' ? (side === 'over' ? 'Over' : 'Under') : market === 'ml' ? 'ML' : 'Spread';
      if (shown && market === 'spread') line = fmtPoint(shown.point);
      if (shown && market === 'total') line = `${side === 'over' ? 'O' : 'U'} ${shown.point}`;
      return `<button class="pick ${pick ? 'on' : ''} ${shown ? '' : 'empty'}" data-key="${esc(key)}"
        ${g.started ? 'disabled' : ''} title="${esc(entries.map((e) => e.user).join(', ') || 'No picks yet')}">
        <span class="line">${esc(line)}</span>
        <span class="price">${shown ? fmtOdds(shown.price) : '&nbsp;'}</span>
        ${entries.length ? `<span class="votes">${entries.length}</span>` : ''}
      </button>`;
    };
    const kick = new Date(g.commence).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const row = (team, side, totalSide) => `
      <div class="team" title="${esc(team)}">${esc(side === 'home' ? g.homeShort : g.awayShort)}</div>
      ${cell('spread', side)}${cell('total', totalSide)}${cell('ml', side)}`;
    return `<div class="card" data-game="${esc(g.id)}">
      <div class="game-head">
        <h3>${esc(g.away)} @ ${esc(g.home)}</h3>
        <span class="${g.started ? 'locked' : 'muted small'}">${g.started ? 'Locked' : kick}</span>
      </div>
      <div class="game-grid">
        <div></div><div class="colhead">Spread</div><div class="colhead">Total</div><div class="colhead">Moneyline</div>
        ${row(g.away, 'away', 'over')}
        ${row(g.home, 'home', 'under')}
      </div>
      ${editing && editing.key.startsWith(`${g.id}|`) ? editorHtml(g) : ''}
    </div>`;
  }).join('');
  $('.editor input')?.focus();
}

function editorHtml(g) {
  const [, market, side] = editing.key.split('|');
  const team = side === 'home' ? g.homeShort : g.awayShort;
  const title = market === 'total' ? `${side === 'over' ? 'Over' : 'Under'} (total points)` : `${team} ${market === 'ml' ? 'moneyline' : 'spread'}`;
  const v = prefill(editing.key);
  const hint = {
    spread: `From the ${team}' side: negative if they're favored (-3.5), positive if they're the underdog (+3.5).`,
    total: 'Combined points for both teams, like 44.5.',
    ml: `The ${team}' moneyline odds, like -150 or +130.`,
  }[market];
  const isMine = myPicks().some((p) => p.key === editing.key);
  return `<form class="editor" data-key="${esc(editing.key)}">
    <b>${esc(title)}</b>
    <div class="fields">
      ${market === 'ml' ? '' : `<label>${market === 'total' ? 'Total' : 'Spread'}
        <input name="point" inputmode="decimal" value="${esc(market === 'spread' && typeof v.point === 'number' ? fmtPoint(v.point) : v.point)}" placeholder="${market === 'total' ? '44.5' : '-3.5'}"></label>`}
      <label>Odds<input name="price" inputmode="numeric" value="${esc(v.price)}" placeholder="${market === 'ml' ? '-150' : '-110'}"></label>
      <button type="submit">Save</button>
      ${isMine ? '<button type="button" class="danger" data-act="remove">Remove</button>' : ''}
      <button type="button" data-act="cancel">Cancel</button>
    </div>
    <p class="hint">${esc(hint)}${market === 'ml' ? '' : ' Odds default to -110.'}</p>
    ${editing.error ? `<p class="err">${esc(editing.error)}</p>` : ''}
  </form>`;
}

async function savePicks(list) {
  try {
    const res = await api('/api/picks', { method: 'PUT', body: { name: me, picks: list } });
    week.picks = res.picks;
    editing = null;
  } catch (err) {
    editing.error = err.message;
  }
  renderGames();
}

function submitEditor(form) {
  const key = form.dataset.key;
  const point = form.point?.value.trim().replace(/^\+/, '') ?? null;
  const price = form.price.value.trim().replace(/^\+/, '');
  // Swap in this pick and drop anything else on the same bet (e.g. the Under).
  const others = myPicks().filter((p) => marketOf(p.key) !== marketOf(key));
  savePicks([...others, { key, point, price }]);
}

async function renderBoard() {
  $('#board').innerHTML = '<p class="muted">Loading…</p>';
  const data = await api('/api/parlays').catch((err) => (notice(err.message), null));
  if (!data) return;
  const pickers = Object.keys(week.picks);
  const waiting = week.players.filter((p) => !pickers.includes(p));
  const header = `<div class="card">
    <b>${pickers.length}</b> of ${week.players.length} friends have picked.
    ${waiting.length ? `<span class="muted">Waiting on: ${waiting.map(esc).join(', ')}</span>` : ''}
    ${pickers.length ? `<div class="small muted">A play needs ${data.need}+ votes to count as consensus.</div>` : ''}
  </div>`;
  if (!data.tallied.length) {
    $('#board').innerHTML = header + '<div class="card muted">No picks yet this week.</div>';
    return;
  }
  const rows = data.tallied.map((s) => `
    <div class="board-row">
      <div style="flex:1">
        <div><b>${esc(s.label)}</b> <span class="muted">${fmtOdds(s.price)}</span></div>
        <div class="small muted">${esc(s.matchup)} · ${s.pickers.map(esc).join(', ')}</div>
        ${s.lines.length > 1 ? `<div class="lines">Different lines entered: ${s.lines.map((l) =>
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
    $('#parlays').innerHTML = '<div class="card muted">Nobody has picked yet. Make some picks first.</div>';
    return;
  }

  let html = '';
  if (!data.options.length) {
    html += `<div class="card">
      <b>Not enough agreement yet.</b>
      <p class="muted">Parlays need at least 2 games where ${data.need}+ of the ${data.voters} pickers agree.
      Right now there ${data.consensus.length === 1 ? 'is 1 such play' : `are ${data.consensus.length}`}.</p>
    </div>`;
  }

  html += data.options.map((p) => `
    <div class="card parlay">
      <div class="head">
        <div><h3>${esc(p.name)}</h3><div class="small muted">${esc(p.blurb)}</div></div>
        <div class="odds">${fmtOdds(p.american)}</div>
      </div>
      <ul>${p.legs.map((l) => `<li><b>${esc(l.label)}</b> <span class="muted">${fmtOdds(l.price)} · ${esc(l.matchup)} · ${l.pickers.length}/${data.voters} picked</span></li>`).join('')}</ul>
      <div class="stats">
        <span>${money(p.stake)} pays <b>${money(p.payout)}</b></span>
        <span>Hit chance ~<b>${pct(p.hitProb)}</b></span>
        <span class="${p.ev < 0 ? 'ev-bad' : ''}">Expected return ~${p.ev >= 0 ? '+' : ''}${(p.ev * 100).toFixed(1)}%</span>
      </div>
    </div>`).join('');

  if (data.almost.length) {
    html += `<div class="card"><b>One vote away</b>
      <p class="small muted">These would join the consensus with one more pick:</p>
      <ul>${data.almost.map((s) => `<li>${esc(s.label)} <span class="muted">${fmtOdds(s.price)} · ${s.pickers.map(esc).join(', ')}</span></li>`).join('')}</ul>
    </div>`;
  }

  html += `<p class="small muted">Payouts use the odds you typed in, so double-check them against your sportsbook.
    Hit chance is a rough estimate that removes a typical book margin. A negative expected return is the house edge,
    and parlays stack it on every leg.</p>`;
  $('#parlays').innerHTML = html;
}

// ---- Events --------------------------------------------------------------

$('#games').addEventListener('click', (e) => {
  const btn = e.target.closest('.pick');
  if (btn && !btn.disabled) {
    editing = editing?.key === btn.dataset.key ? null : { key: btn.dataset.key };
    renderGames();
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'cancel') {
    editing = null;
    renderGames();
  }
  if (act === 'remove') savePicks(myPicks().filter((p) => p.key !== editing.key));
});
$('#games').addEventListener('submit', (e) => {
  e.preventDefault();
  submitEditor(e.target);
});
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  tab = btn.dataset.tab;
  render();
});
$('#player-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-name]');
  if (btn) join(btn.dataset.name);
});
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#join-name').value.trim();
  if (name) join(name);
});
$('#code-save').addEventListener('click', () => {
  storage.set('parlay.code', $('#group-code').value.trim());
  $('#code-row').hidden = true;
  load();
});
$('#stake').addEventListener('change', renderParlays);

load();
