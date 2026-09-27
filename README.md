# Parlay Party

A small website where a group of friends picks NFL games each week. It finds
the plays most of you agree on and builds a few parlays out of them.

- **Weekly odds** from [The Odds API](https://the-odds-api.com): spread, total,
  and moneyline for every game in the current Tuesday-to-Tuesday week.
- **My Picks**: tap the plays you like. Badges show how many friends took each
  one, and picks lock at kickoff.
- **Group Board**: every picked play ranked by how many of you took it.
- **Parlays**: up to five options built from the majority picks. Each shows the
  price, the payout for your stake, the chance of hitting, and the expected
  return. There's also a list of plays that are one vote short.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

With no API key it runs on demo lines, so you can try it right away.

For real odds, get a free key from the-odds-api.com and start with it:

```bash
ODDS_API_KEY=your_key npm start
```

The rest of the settings are in `.env.example`, all set as environment
variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `ODDS_API_KEY` | _(empty = demo)_ | The Odds API key |
| `BOOKMAKER` | `draftkings` | Book to take lines from (falls back to the first available) |
| `ODDS_CACHE_HOURS` | `6` | How often odds refresh. Each fetch costs 3 credits; 6h uses ~360 of the free tier's 500/month |
| `GROUP_CODE` | _(empty)_ | Optional shared code friends enter before they can use the site |
| `SEASON_START` | Tuesday after Labor Day | Sets the "Week N" label (YYYY-MM-DD, a Tuesday) |
| `PORT` | `3000` | |
| `DATA_FILE` | `data/db.json` | Where players, picks, and cached odds are saved |

Manual "Refresh odds" clicks are capped at once per 15 minutes to protect your
API credits.

## How the parlays are built

1. **Voters** are friends who made at least one pick this week.
2. A play is **consensus** if more than half the voters picked it. With 1 or 2
   voters, everyone has to agree.
3. Each game contributes only its most-picked consensus play. Books won't let
   you parlay both sides of a game, and most limit same-game combos in regular
   parlays.
4. Games that have already kicked off are left out.
5. From that pool it builds, skipping duplicates:
   - **Everybody Agrees**: every play all voters picked
   - **Crowd Favorites**: the top 3 by votes
   - **Safest Majority**: the plays most likely to hit
   - **Plus-Money Swing**: the plays with the biggest payouts
   - **Full Send**: every consensus play

"Hit chance" and "expected return" come from the book's lines with the vig
removed. Expected return is almost always negative because the book's edge
compounds on every leg you add.

## Hosting

This is one Node process that saves to a JSON file, so any host with a
persistent disk works: a Raspberry Pi, a small VPS, Render or Railway with a
volume, or Fly.io. Hosts with ephemeral filesystems lose picks on restart
unless you point `DATA_FILE` at a mounted volume.

## Tests

```bash
npm test
```
