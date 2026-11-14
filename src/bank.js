// Running balances: instead of a Venmo for every bet, each member (everyone but
// the banker, who places the bets) keeps money with the banker. A balance is
// never stored, it's worked out from:
//   + Venmos to the banker (deposits)
//   - Venmos back from the banker (cash-outs)
//   - their stake on each bet placed since the balances started
//   + their share of what each of those bets paid back (wins and pushes)
// Money pledged on bets not placed yet is "on hold": it comes off "available"
// but not the balance until the bet is placed.

export const BANK_LINES = {
  low: 20, // warn when available drops under this
  high: 200, // tell the banker to cash someone out at this
  backTo: 100, // ...back down to this
};

const cents = (n) => Math.round(n * 100) / 100;

// `bank` is { startAt, entries: [{ id, who, kind: 'deposit' | 'cashout', amount, at, note }] }.
// `bets` are every parlay with money on it: { id, name, url, placed, status
// ('pending' | 'won' | 'lost' | 'push'), stakes, total, returned, decidedAt,
// current (in a week still being played) }.
export function computeBank(bank, bets, members, banker, lines = BANK_LINES) {
  const rows = new Map(members.map((name) => [name, {
    name, deposits: 0, cashouts: 0, staked: 0, returned: 0, inPlay: 0, hold: 0, history: [],
  }]));
  for (const e of bank.entries ?? []) {
    const r = rows.get(e.who);
    if (!r) continue;
    const deposit = e.kind === 'deposit';
    if (deposit) r.deposits += e.amount;
    else r.cashouts += e.amount;
    r.history.push({
      id: e.id, at: e.at, kind: e.kind, amount: deposit ? e.amount : -e.amount, note: e.note || '',
      text: deposit ? `Venmo to ${banker}` : `${banker} paid you back`,
    });
  }
  for (const b of bets) {
    for (const [who, amt] of Object.entries(b.stakes ?? {})) {
      const r = rows.get(who);
      if (!r || !(amt > 0)) continue;
      if (b.placed && b.placed.at >= bank.startAt) {
        r.staked += amt;
        r.history.push({ at: b.placed.at, kind: 'bet', amount: -amt, text: `Bet placed: ${b.name}`, url: b.url });
        if (b.status === 'pending') {
          r.inPlay += amt;
        } else {
          const share = b.total > 0 ? (b.returned * amt) / b.total : 0;
          r.returned += share;
          const text = b.status === 'won' ? `Won: ${b.name}` : b.status === 'push' ? `Push, stake back: ${b.name}` : `Lost: ${b.name}`;
          r.history.push({ at: b.decidedAt ?? b.placed.at, kind: b.status, amount: share, text, url: b.url });
        }
      } else if (!b.placed && b.status === 'pending' && b.current) {
        r.hold += amt;
      }
    }
  }
  const out = [...rows.values()].map((r) => {
    const balance = cents(r.deposits - r.cashouts - r.staked + r.returned);
    const available = cents(balance - r.hold);
    const status = available < lines.low ? 'low' : balance >= lines.high ? 'high' : 'ok';
    return {
      name: r.name,
      balance, available,
      hold: cents(r.hold), inPlay: cents(r.inPlay),
      status,
      cashOut: status === 'high' ? cents(balance - lines.backTo) : 0,
      topUp: available < lines.low ? cents(lines.backTo - available) : 0, // back to the starting amount
      history: r.history
        .map((h) => ({ ...h, amount: cents(h.amount) }))
        .sort((a, b) => b.at - a.at),
    };
  });
  return {
    members: out,
    // The members' money the banker has: cash on hand plus bets in play.
    holding: cents(out.reduce((t, m) => t + Math.max(0, m.balance), 0)),
    inPlay: cents(out.reduce((t, m) => t + m.inPlay, 0)),
  };
}

// Alerts to send as balances cross the lines, at most once per crossing.
// `sent` is { member: 'low' | 'high' } from last time; returns the new map
// and the alerts to send now.
export function bankAlerts(members, sent = {}) {
  const next = {};
  const alerts = [];
  for (const m of members) {
    const now = m.status === 'ok' ? null : m.status;
    if (now) next[m.name] = now;
    if (now && sent[m.name] !== now) alerts.push(m);
  }
  return { sent: next, alerts };
}
