# Parlay Party

A small website where a group of friends picks NFL games each week. It finds
the plays most of you agree on and builds a few parlays out of them.

- **Weekly schedule** pulled automatically from ESPN's public scoreboard (no
  API key needed). The week runs Tuesday to Tuesday, so Thursday, Sunday, and
  Monday games are all included.
- **My Picks**: tap a spread, total, or moneyline and type in the line and odds
  from your sportsbook. If a friend already entered that game, it fills in
  their line for you. Orange badges show how many friends took each bet, and
  picks lock at kickoff.
- **Group Board**: every bet ranked by how many of you took it. It flags bets
  where friends typed different lines (Chiefs -3 vs. -3.5).
- **Parlays**: up to five options built from the majority picks. Each shows the
  price, the payout for your stake, a rough chance of hitting, and a list of
  bets that are one vote short.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

If ESPN can't be reached, it shows a demo slate and retries every 5 minutes.

Settings (environment variables, see `.env.example`):

| Variable | Default | What it does |
| --- | --- | --- |
| `GROUP_CODE` | _(empty)_ | Optional shared code friends enter before they can use the site |
| `SEASON_START` | Tuesday after Labor Day | Sets the "Week N" label (YYYY-MM-DD, a Tuesday) |
| `PORT` | `3000` | |
| `DATA_FILE` | `data/db.json` | Where players, picks, and the schedule are saved |

## Entering lines

- **Spread**: from the side you're picking. Favorites are negative (`-3.5`),
  underdogs positive (`+3.5`).
- **Total**: combined points, like `44.5`. Pick Over or Under.
- **Odds**: American odds like `-110` or `+150`. Spreads and totals default to
  `-110`; moneylines need odds.

## How the parlays are built

1. **Voters** are friends who made at least one pick this week.
2. A bet counts as **consensus** if more than half the voters picked the same
   side of it. With 1 or 2 voters, everyone has to agree. Picks with slightly
   different lines still count together, and the parlay uses the line most of
   you entered.
3. Each game contributes only its most-picked consensus bet. Books won't let
   you parlay both sides of a game, and most limit same-game combos in regular
   parlays.
4. Games that have already kicked off are left out.
5. From that pool it builds, skipping duplicates:
   - **Everybody Agrees**: every bet all voters picked
   - **Crowd Favorites**: the top 3 by votes
   - **Safest Majority**: the bets most likely to hit
   - **Plus-Money Swing**: the bets with the biggest payouts
   - **Full Send**: every consensus bet

Payouts are only as accurate as the odds you type in. "Hit chance" strips a
typical ~4.5% book margin from those odds, so it's an estimate. Expected return
is almost always negative because the book's edge compounds on every leg.

## Hosting

This is one Node process that saves to a JSON file, so any host with a
persistent disk works: a Raspberry Pi, a small VPS, Render or Railway with a
volume, or Fly.io. Hosts with ephemeral filesystems lose picks on restart
unless you point `DATA_FILE` at a mounted volume.

## Tests

```bash
npm test
```
