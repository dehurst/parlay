// Local entry point: `npm start`. (On Vercel, api/index.js serves the same app.)
import app, { config } from './src/app.js';

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Parlay Party on http://localhost:${port}`);
  console.log(`Players: ${config.players.join(', ')}`);
  console.log(config.hasOddsKey
    ? `Using ${config.bookName} lines from The Odds API.`
    : 'No ODDS_API_KEY set: picks need sportsbook lines, so add a key to .env (see README).');
});
