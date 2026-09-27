const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtOdds = (a) => (a > 0 ? `+${a}` : `${a}`);
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
  try {
    week = await api(`/api/week${refresh ? '?refresh=1' : ''}`);
  } catch (err) {
    notice(err.message);
    return;
  }
  notice(week.demo ? 'Demo mode: these are made-up lines. Set ODDS_API_KEY on the server for real odds.' : week.warning);
  $('#week-label').textContent = week.label;
  const when = new Date(week.fetchedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const book = week.games[0]?.book ?? '';
  $('#odds-meta').textContent = `Lines: ${book} · updated ${when}${week.remaining ? ` · ${week.remaining} API credits left` : ''}`;

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

// ---- Rendering -----------------------------------------------------------

function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${tab}`));
  if (tab === 'picks') renderGames();
  if (tab === 'board') renderBoard();
  if (tab === 'parlays') renderParlays();
}

function votesFor(key) {
  return Object.entries(week.picks).filter(([, keys]) => keys.includes(key)).map(([name]) => name);
}

function renderGames() {
  const mine = new Set(week.picks[me] ?? []);
  const now = Date.now();
  if (!week.games.length) {
    $('#games').innerHTML = '<div class="card muted">No games with odds this week yet. Check back after lines post.</div>';
    return;
  }
  $('#games').innerHTML = week.games.map((g) => {
    const started = new Date(g.commence) <= now;
    const find = (market, side) => g.selections.find((s) => s.market === market && s.side === side);
    const cell = (sel, lineText) => {
      if (!sel) return '<div></div>';
      const voters = votesFor(sel.key);
      return `<button class="pick ${mine.has(sel.key) ? 'on' : ''}" data-key="${esc(sel.key)}"
        ${started ? 'disabled' : ''} title="${esc(voters.join(', ') || 'No picks yet')}">
        <span class="line">${esc(lineText)}</span><span class="price">${fmtOdds(sel.price)}</span>
        ${voters.length ? `<span class="votes">${voters.length}</span>` : ''}
      </button>`;
    };
    const spread = (s) => (s ? `${s.point > 0 ? '+' : ''}${s.point}` : '');
    const kick = new Date(g.commence).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const row = (team, side, totalSide) => `
      <div class="team" title="${esc(team)}">${esc(team.split(' ').pop())}</div>
      ${cell(find('spread', side), spread(find('spread', side)))}
      ${cell(find('total', totalSide), `${totalSide === 'over' ? 'O' : 'U'} ${find('total', totalSide)?.point ?? ''}`)}
      ${cell(find('ml', side), 'ML')}`;
    return `<div class="card">
      <div class="game-head">
        <h3>${esc(g.away)} @ ${esc(g.home)}</h3>
        <span class="${started ? 'locked' : 'muted small'}">${started ? 'Locked' : kick}</span>
      </div>
      <div class="game-grid">
        <div></div><div class="colhead">Spread</div><div class="colhead">Total</div><div class="colhead">Moneyline</div>
        ${row(g.away, 'away', 'over')}
        ${row(g.home, 'home', 'under')}
      </div>
    </div>`;
  }).join('');
}

async function togglePick(key) {
  const mine = new Set(week.picks[me] ?? []);
  if (mine.has(key)) {
    mine.delete(key);
  } else {
    // Only one side of a market per game (can't take both Over and Under).
    const prefix = key.split('|').slice(0, 2).join('|') + '|';
    for (const k of mine) if (k.startsWith(prefix)) mine.delete(k);
    mine.add(key);
  }
  try {
    const res = await api('/api/picks', { method: 'PUT', body: { name: me, picks: [...mine] } });
    week.picks = res.picks;
    renderGames();
  } catch (err) {
    notice(err.message);
  }
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
        <span class="${p.ev < 0 ? 'ev-bad' : ''}">Expected return ${p.ev >= 0 ? '+' : ''}${(p.ev * 100).toFixed(1)}%</span>
      </div>
    </div>`).join('');

  if (data.almost.length) {
    html += `<div class="card"><b>One vote away</b>
      <p class="small muted">These would join the consensus with one more pick:</p>
      <ul>${data.almost.map((s) => `<li>${esc(s.label)} <span class="muted">${fmtOdds(s.price)} · ${s.pickers.map(esc).join(', ')}</span></li>`).join('')}</ul>
    </div>`;
  }

  html += `<p class="small muted">Hit chance and expected return use the book's lines with the vig removed.
    A negative expected return is the house edge. Parlays stack it on every leg.</p>`;
  $('#parlays').innerHTML = html;
}

// ---- Events --------------------------------------------------------------

$('#games').addEventListener('click', (e) => {
  const btn = e.target.closest('.pick');
  if (btn && !btn.disabled) togglePick(btn.dataset.key);
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
$('#refresh').addEventListener('click', () => load(true));

load();
