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
  your own picks show here, so nobody copies anybody. After submitting,
  **Copy picks** copies a plain-text list of that day's picks (like
  `KC -3.5`, `GB/DET O 49.5`, `JAX ML`, one per line) for a group chat. **Clear my picks** (next to
  your name) wipes your picks for the week, except games already under way.
- **Completed games**: live games stay at the top of the Picks tab (marked
  Live); once a game is over it moves to a grayed-out **Completed games**
  section at the bottom, with the final score for games anyone bet on. Once the
  score is in, your picks there turn green ✓ (won), red ✗ (lost), or gray P
  (push), and where you lost, the side that won gets a dashed green outline.
  The Bet Slip does the same for settled parlays.
- **Build a parlay** (switch at the top of the Picks tab): tap any bets to
  see what a one-off parlay would pay at FanDuel's current lines for any
  stake. Nothing in it is saved or shared, and it warns when two legs come
  from the same game (FanDuel prices those as a Same Game Parlay).
- **Group Board**: every submitted bet ranked by how many of you took it,
  plus who still needs to submit. It flags bets where FanDuel's line has
  moved since.
- **Parlays**: custom parlays first, then up to five suggested parlays built
  from the majority picks. Once any game in a parlay with money on it kicks
  off, it moves to **In play** (✓/✗ on legs as they finish), and once it's
  decided, to a grayed **Completed** section marked Won (with the payout),
  Lost, or Push. Every parlay on the Bet Slip is always somewhere on this tab. Each shows the
  price, the payout for your stake, a rough chance of hitting, and a list of
  bets that are one vote short. Everyone types in how much they want on the
  parlays they like; one with money from a majority of the group is marked
  **Group's pick**.
- **Stats**: season money per person (staked, paid back, net), the group's
  parlay record, everyone's pick records (by spread, total, and moneyline),
  how the group's consensus picks have done, and a week-by-week history.
  Games are graded automatically from ESPN's final scores (free), about 3
  hours after kickoff.
- **Likes and dislikes** (Parlays tab): 👍 or 👎 a parlay (tap again to clear,
  or tap the other to switch) and 👎 any leg
  you don't trust; small initial circles show who. Money on a parlay counts as
  a like, and a parlay a majority likes is the **Group's pick**.
- **Copy & edit**: opens any open parlay in Build a parlay with its legs filled
  in. Each leg shows its win chance, a swap to the same team the other way
  (spread vs. moneyline), and **Drop**, each with the parlay's new hit chance
  and payout. Posting makes a new custom parlay "based on" the
  original, which stays as it was.
- **Research**: pick any team for its season so far, from ESPN's scoreboard
  (free): record (home/away, streak, last 5, points per game), against the
  spread (overall, as favorite/underdog, home/away), over/under, strength of
  schedule (opponents' win %, ranked), and a game log with each line and
  result. Lines come from ESPN's odds, or the saved FanDuel line when ESPN has
  none. Finished weeks are cached; weeks in progress re-check every 15 minutes
  during games, else every 6 hours.
- **Analysis**: each of your open picks with its win chance (FanDuel's odds on
  both sides with the house's cut removed) and the other way to bet the same
  team (spread vs. moneyline); live parlays' hit chances and weakest leg;
  close calls (how far lost picks missed and whether the other bet would have
  won); parlays that lost by one leg; and parlays vs. the same money as
  straight bets. Lines are kept for past weeks people bet on so look-backs can
  show prices.
- **Custom parlays** (Parlays tab, **+ Build your own**): pick any bets in the
  Build a parlay view, set your stake, and **Post**. It shows up as "Daniel's
  Parlay 1" (then 2, ...) for the others to join with their own stakes, and
  flows into the Bet Slip and Stats like the group parlays. Needs 2+ legs from
  different games, and closes to new money once any of its games starts. If
  everyone pulls out, it disappears. Every parlay card (here and on the Bet
  Slip) has a **Copy** button that copies its legs, one per line, then the odds,
  what $10 pays, and the total bet and payout if anyone is in.
- **Bet Slip**: for whoever places the bets. Every parlay with money on it,
  its legs and odds, each person's stake and payout, and a "who owes what"
  total. A parlay is saved as it was when people bought in, so it stays on
  the slip after kickoff or if picks change (it gets flagged if it's no
  longer a current option). Legs flag any line FanDuel has moved since.
  **Mark placed** asks for the total payout FanDuel shows (pre-filled with the
  site's estimate), records who placed it and when, moves it below the ones
  still to place, and locks its stakes so the slip keeps matching the real bet
  (Undo unlocks). From then on the real payout is used everywhere: each
  person's winnings, the odds shown, copied text, and season Stats. **Edit
  payout** fixes a typo.
  Once a parlay wins (or pushes), **Mark paid out** records that everyone's
  been paid; until then the slip's summary shows **To pay out** with what each
  person is owed.

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
| `DAILY_CREDIT_LIMIT` | `16` | Backstop: most credits line refreshes can spend per day (Eastern) |
| `SUNDAY_CREDIT_LIMIT` | `30` | The same, on Sundays |
| `GROUP_CODE` | _(empty)_ | Optional shared code friends enter before they can use the site |
| `SEASON_START` | Tuesday after Labor Day | Sets the "Week N" label (YYYY-MM-DD, a Tuesday) |
| `PORT` | `3000` | |
| `DATA_FILE` | `data/db.json` | Where players, picks, and the schedule are saved |

## API credits

The free tier has 500 credits a month. The schedule, team records, and final
scores (from ESPN) don't use any. FanDuel lines cost 3 credits per refresh
(spreads, totals, and moneylines).

Player props cost 1 credit per market per game: anytime TD + passing TDs is
2 a game, about 28-32 for a full slate.

**Lines** update at **11 AM and 6 PM Eastern**: the first visit after each time
pulls fresh lines once (3 credits), and everyone shares them. A new week with
no lines yet gets them on its first visit. **Sundays** add 2 manual refreshes
(the ↻ Refresh button only shows then) for late injury news.

**Props** update **Thursday and Sunday at 11 AM Eastern**, for games that
haven't started. They pause if the month's credits left would drop under 75,
so lines keep working to the end of the month.

| | Lines | Props | Per week |
| --- | --- | --- | --- |
| Tue, Wed, Fri, Sat, Mon | 2 × 3 = 6 | 0 | 30 |
| Thu | 6 | ~32 | ~38 |
| Sun | 6-12 | ~30 | ~36-42 |
| **Week** | **42-48** | **~62** | **~104-110** |

That's roughly 450-470 a month in the worst case (a refresh only happens if
someone visits), under the free 500. `DAILY_CREDIT_LIMIT` and
`SUNDAY_CREDIT_LIMIT` are a backstop for line refreshes only. Once every game
of the week has kicked off, nothing refreshes until the next week. The Picks
tab shows when lines and props were last updated, when they update next, and
credits left this month.

Props are graded from ESPN's box scores (free): anytime TD counts every
touchdown the player scores (not ones he throws), and a player who doesn't
play is a push, like a void at the sportsbook.

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

The week flips every Tuesday at 6 AM Eastern: new games, fresh lines, and empty
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
