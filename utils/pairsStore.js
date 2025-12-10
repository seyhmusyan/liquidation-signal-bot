// TEMP MEMORY STORE (Redis yoksa burası çalışır)
let PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

// Get list
export async function getActivePairs() {
  return PAIRS;
}

// Add a new coin
export async function addPair(symbol) {
  symbol = symbol.toUpperCase();
  if (!PAIRS.includes(symbol)) {
    PAIRS.push(symbol);
  }
  return PAIRS;
}

// Remove coin
export async function removePair(symbol) {
  symbol = symbol.toUpperCase();
  PAIRS = PAIRS.filter(p => p !== symbol);
  return PAIRS;
}
