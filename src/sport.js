import { AsyncLocalStorage } from 'node:async_hooks';

// The site runs two leagues side by side: NFL and college football (CFB).
// Each has its own data (picks, stakes, schedule, lines, ...) and its own
// Odds API and ESPN feeds. Every API request runs inside one league, picked
// by the page's NFL/CFB switch (the x-sport header), so the rest of the code
// asks sport() which one it's in instead of passing it everywhere.
export const SPORTS = {
  nfl: {
    id: 'nfl',
    label: 'NFL',
    oddsKey: 'americanfootball_nfl',
    espnPath: 'football/nfl',
    espnQuery: '',
    weekOffset: 0,
    seasonWeeks: 18,
    // NFL nicknames are unique ("Broncos"), so they name a team across sources.
    fullNames: false,
    props: true,
    injuries: true,
    bigDay: 'Sun', // manual line refreshes and the higher credit limit
    storeKey: 'parlay:db',
    file: 'db.json',
  },
  cfb: {
    id: 'cfb',
    label: 'CFB',
    oddsKey: 'americanfootball_ncaaf',
    espnPath: 'football/college-football',
    // Every FBS game; without groups ESPN only lists ranked teams' games.
    espnQuery: '&groups=80&limit=400',
    // College starts a week before the NFL, so its Week 9 is the NFL's Week 8.
    weekOffset: 1,
    seasonWeeks: 15,
    // Nicknames repeat in college ("Tigers", "Wildcats"), so use full names.
    fullNames: true,
    // Props cost a credit per game; with ~35 games a week that's too many.
    props: false,
    // ESPN has next to no college injury reports, and rosters are huge.
    injuries: false,
    bigDay: 'Sat',
    // Games with a team from a Power 5 conference, by ESPN conference ID:
    // ACC, Big 12, Big Ten, SEC, Pac-12.
    conferences: ['1', '4', '5', '8', '9'],
    storeKey: 'parlay:cfb',
    file: 'cfb.json',
  },
};

const current = new AsyncLocalStorage();

// The league this request is for (NFL outside of a request, e.g. in tests).
export const sport = () => current.getStore() ?? SPORTS.nfl;

export const runInSport = (id, fn) => current.run(SPORTS[id] ?? SPORTS.nfl, fn);

// True if ESPN's conference ID is one this league's slate includes (all for the NFL).
export const inSlate = (conferenceId) => !sport().conferences || sport().conferences.includes(String(conferenceId));

export const espnSite = (path) => `https://site.api.espn.com/apis/site/v2/sports/${sport().espnPath}/${path}`;
export const espnCore = () => `https://sports.core.api.espn.com/v2/sports/${sport().espnPath.replace('/', '/leagues/')}`;
