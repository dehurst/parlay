export function americanToDecimal(american) {
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

export function decimalToAmerican(decimal) {
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

export function formatAmerican(american) {
  return american > 0 ? `+${american}` : `${american}`;
}

// Probability implied by the price, including the book's vig.
export function impliedProb(american) {
  return 1 / americanToDecimal(american);
}

// Strip the vig from a two-way market so the two sides sum to 1.
export function fairProb(price, otherPrice) {
  const p = impliedProb(price);
  const q = impliedProb(otherPrice);
  return p / (p + q);
}
