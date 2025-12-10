// SABİT VE KİLİTLİ PAIR LİSTESİ
const PAIRS = ["BTCUSDT", "AVAXUSDT"];

export async function getActivePairs() {
  return PAIRS;
}

// /addpair KAPALI
export async function addPair() {
  return PAIRS;
}

// /rmpair KAPALI
export async function removePair() {
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
