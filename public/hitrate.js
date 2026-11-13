// Hit rates against a prop line, shared by the server's tests and the page.

// How often a player's games cleared `line`: values are his games' numbers
// (any order). Over = more than the line, under = less, push = exactly on it
// (only possible with a whole-number line).
export function hitRate(values, line) {
  const out = { over: 0, under: 0, push: 0, n: values.length };
  for (const v of values) {
    if (v > line) out.over++;
    else if (v < line) out.under++;
    else out.push++;
  }
  return out;
}

// The chance a price implies, before taking out the book's cut:
// -150 -> 0.6, +200 -> 0.333.
export const impliedProb = (american) => (american < 0 ? -american / (-american + 100) : 100 / (american + 100));

// A line to start from when none is given: his average, to the nearest half
// point (books use .5 so nobody pushes).
export function defaultLine(avg) {
  if (!Number.isFinite(avg) || avg <= 0) return 0.5;
  return Math.max(0.5, Math.round(avg - 0.5) + 0.5);
}
