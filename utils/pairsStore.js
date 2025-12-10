let PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

export async function getActivePairs() { return PAIRS; }

export async function addPair(symbol) {
  symbol = symbol.toUpperCase();
  if (!PAIRS.includes(symbol)) PAIRS.push(symbol);
  return PAIRS;
}

export async function removePair(symbol) {
  symbol = symbol.toUpperCase();
  PAIRS = PAIRS.filter(p => p !== symbol);
  return PAIRS;
}
