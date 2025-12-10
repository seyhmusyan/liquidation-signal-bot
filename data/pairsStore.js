let PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

export async function getActivePairs() {
  return PAIRS;
}

export async function addPair(symbol) {
  symbol = String(symbol || "").toUpperCase();
  if (!symbol.endsWith("USDT")) symbol = symbol + "USDT";
  if (!PAIRS.includes(symbol)) {
    PAIRS.push(symbol);
  }
  return PAIRS;
}

export async function removePair(symbol) {
  symbol = String(symbol || "").toUpperCase();
  if (!symbol.endsWith("USDT")) symbol = symbol + "USDT";
  PAIRS = PAIRS.filter(p => p !== symbol);
  return PAIRS;
}

export function toCoinglassSymbol(symbol) {
  if (!symbol) return null;
  if (symbol.endsWith("USDT")) {
    const base = symbol.slice(0, -4);
    return base.replace("1000", "");
  }
  return symbol;
}
