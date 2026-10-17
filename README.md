# Parlay Party

A small website where a group of friends picks NFL games each week. It finds
the plays most of you agree on and builds a few parlays out of them.

- **Weekly schedule and FanDuel lines** from [The Odds API](https://the-odds-api.com)
  (free key). Without a key it uses ESPN's public schedule and you type lines
  in by hand. The week runs Tuesday to Tuesday, so Thursday, Sunday, and
  Monday games are all included.
- **My Picks**: tap a spread, total, or moneyline to take it at FanDuel's
  current line. Tap it again to change the line or remove it. Orange badges
  show how many friends took each bet, and picks lock at kickoff.
- **Group Board**: every bet ranked by how many of you took it. It flags bets
  where friends took different lines (Chiefs -3 vs. -3.5) and bets where
  FanDuel's line has moved since.
- **Parlays**: up to five options built from the majority picks. Each shows the
  price, the payout for your stake, a rough chance of hitting, and a list of
  bets that are one vote short.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

To pull FanDuel lines, get a free key at https://the-odds-api.com, then:

```bash
cp .env.example .env
open -e .env         # macOS; paste your key after ODDS_API_KEY=, save, close
npm start
```

The startup message should say `Using FanDuel lines from The Odds API.`
`.env` is git-ignored, so the key never gets committed.

If no schedule source can be reached, it shows a demo slate and retries every
5 minutes. The terminal prints why each source failed.

Settings (in `.env` or as environment variables):

| Variable | Default | What it does |
| --- | --- | --- |
| `ODDS_API_KEY` | _(empty)_ | The Odds API key. Without it: ESPN schedule, manual lines |
| `BOOKMAKER` | `fanduel` | Book to pull lines from (`draftkings`, `betmgm`, `williamhill_us`, ...) |
| `ODDS_CACHE_HOURS` | `6` | Hours between line refreshes. Each costs 3 credits; the schedule is free |
| `GROUP_CODE` | _(empty)_ | Optional shared code friends enter before they can use the site |
| `SEASON_START` | Tuesday after Labor Day | Sets the "Week N" label (YYYY-MM-DD, a Tuesday) |
| `PORT` | `3000` | |
| `DATA_FILE` | `data/db.json` | Where players, picks, and the schedule are saved |

## API credits

The free tier has 500 credits a month. The schedule doesn't use any. Lines
cost 3 credits per refresh and only refresh when someone opens the site and
they're older than `ODDS_CACHE_HOURS`, so 6 hours means at most ~360 a month.
The **Refresh lines** link forces an update but only once per 15 minutes. The
footer shows how many credits are left.

## Entering lines by hand

Without an API key, or to override FanDuel's number:

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

Parlays are priced at the lines your group took, which can drift from
FanDuel's current lines. The board and parlay cards flag any that moved.
"Hit chance" strips a typical ~4.5% book margin from those odds, so it's an
estimate. Expected return is almost always negative because the book's edge
compounds on every leg.

## Hosting

This is one Node process that saves to a JSON file, so any host with a
persistent disk works: a Raspberry Pi, a small VPS, Render or Railway with a
volume, or Fly.io. Hosts with ephemeral filesystems lose picks on restart
unless you point `DATA_FILE` at a mounted volume.

## Tests

```bash
npm test
```
