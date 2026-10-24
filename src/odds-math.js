export function americanToDecimal(american) {
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

export function decimalToAmerican(decimal) {
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

// Probability implied by the price, including the book's vig.
export function impliedProb(american) {
  return 1 / americanToDecimal(american);
}

// We only know the side people bet, not the other side's price, so strip a
// typical ~4.5% book margin instead of the exact one. -110 comes out ~50%.
export function estFairProb(american) {
  return Math.min(0.99, impliedProb(american) / 1.045);
}
