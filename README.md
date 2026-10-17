# Parlay Builder

A small website where a group of friends picks NFL games each week. It finds
the plays most of you agree on and builds a few parlays out of them.

- **Weekly schedule and FanDuel lines** from [The Odds API](https://the-odds-api.com)
  (free key). The week runs Tuesday to Tuesday, so Thursday, Sunday, and
  Monday games are all included. ESPN is a backup for the schedule.
- **Players**: Daniel, Asher, and Matt (set with `PLAYERS`). Pick your name
  and the site remembers you on that device.
- **My Picks**: tap a spread, total, or moneyline to select it, tap again to
  remove it. Picks stay private until you hit **Submit**, which saves them at
  FanDuel's line at that moment. Tap **Edit picks** to change them later:
  your submitted picks keep counting until you resubmit, bets you keep stay
  at the line you got, and picks on games that started can't change. Only
  your own picks show here, so nobody copies anybody. **Clear my picks** (next to
  your name) wipes your picks for the week, except games already under way.
- **Group Board**: every submitted bet ranked by how many of you took it,
  plus who still needs to submit. It flags bets where FanDuel's line has
  moved since.
- **Parlays**: up to five options built from the majority picks. Each shows the
  price, the payout for your stake, a rough chance of hitting, and a list of
  bets that are one vote short. Everyone types in how much they want on the
  parlays they like; one with money from a majority of the group is marked
  **Group's pick**.
- **Stats**: season money per person (staked, paid back, net), the group's
  parlay record, everyone's pick records (by spread, total, and moneyline),
  how the group's consensus picks have done, and a week-by-week history.
  Games are graded automatically from ESPN's final scores (free), about 3
  hours after kickoff.
- **Bet Slip**: for whoever places the bets. Every parlay with money on it,
  its legs and odds, each person's stake and payout, and a "who owes what"
  total. A parlay is saved as it was when people bought in, so it stays on
  the slip after kickoff or if picks change (it gets flagged if it's no
  longer a current option). Legs flag any line FanDuel has moved since.

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
| `ODDS_API_KEY` | _(empty)_ | The Odds API key. Needed for lines, so picks need it too |
| `PLAYERS` | `Daniel,Asher,Matt` | Who's in the group, comma-separated |
| `BOOKMAKER` | `fanduel` | Book to pull lines from (`draftkings`, `betmgm`, `williamhill_us`, ...) |
| `ODDS_CACHE_HOURS` | `6` | Hours between line refreshes. Each costs 3 credits; the schedule is free |
| `GROUP_CODE` | _(empty)_ | Optional shared code friends enter before they can use the site |
| `SEASON_START` | Tuesday after Labor Day | Sets the "Week N" label (YYYY-MM-DD, a Tuesday) |
| `PORT` | `3000` | |
| `DATA_FILE` | `data/db.json` | Where players, picks, and the schedule are saved |

## API credits

The free tier has 500 credits a month. The schedule, team records, and final
scores (from ESPN) don't use any. FanDuel lines cost 3 credits per refresh and
only refresh when someone opens the site and they're older than
`ODDS_CACHE_HOURS`. The **Refresh lines** button at the top forces an update,
at most once per 15 minutes. The footer shows how many credits are left.

Paid calls pause from the kickoff of the week's last game (normally Monday
night) until **Wednesday 7:00 PM Eastern**. Next week's games show up
Tuesday morning, but their lines arrive Wednesday evening. That keeps it
around 60 credits a week at most.

## How the parlays are built

1. **Voters** are friends who submitted picks this week.
2. A bet counts as **consensus** if more than half the voters picked the same
   side of it. With 1 or 2 voters, everyone has to agree. Picks with slightly
   different lines (submitted at different times) still count together, and
   the parlay uses the most common line.
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

Parlays are priced at the lines each pick was submitted at, which can drift from
FanDuel's current lines. The board and parlay cards flag any that moved.
"Hit chance" strips a typical ~4.5% book margin from those odds, so it's an
estimate. Expected return is almost always negative because the book's edge
compounds on every leg.

## Week to week

The week flips every Tuesday at 8am Eastern: new games, fresh lines, and empty
picks. Nothing is deleted. Past weeks stay in the data and show up on the
Stats tab with their results.

## Hosting on Vercel (free)

Vercel runs the site for free but has no lasting disk, so the data goes in a
free Upstash Redis database you add from Vercel's dashboard. (Locally, the
site keeps using `data/db.json`.)

1. Sign in at https://vercel.com with GitHub (the free Hobby plan).
2. **Add New → Project**, import this repo, and leave the build settings
   alone (`vercel.json` handles them).
3. Under **Environment Variables**, add `ODDS_API_KEY`. Strongly consider
   `GROUP_CODE` too: the site will be on the public internet. Add `PLAYERS` if
   the group changes.
4. Click **Deploy**. The page loads, but picks won't work until step 5.
5. In the project, open **Storage → Create Database → Upstash for Redis**
   (free plan) and connect it to the project. That adds `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` for you.
6. **Deployments → ⋯ → Redeploy** so the site picks up the database.
7. Optional, to bring over picks and history from your computer: put the
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` values in your local `.env`, then
   run `npm run upload-data`.

Pushing to the repo's default branch redeploys automatically.

You can also host it anywhere that runs Node: `npm start` with the same
environment variables. Without Upstash variables it uses `data/db.json`, so
use a persistent disk.

## Tests

```bash
npm test
```
