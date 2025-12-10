import fs from "fs";
import path from "path";

// VERCEL uyumlu tam path
const filePath = path.join(process.cwd(), "data", "pairs.json");

// COINGLASS FORMAT
export function toCoinglassSymbol(symbol) {
  if (!symbol) return null;
  if (symbol.endsWith("USDT")) {
    const base = symbol.slice(0, -4);
    return base.replace("1000", ""); // 1000SHIBUSDT → SHIB
  }
  return symbol;
}

// JSON OKU
function readPairs() {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    return json.pairs || [];
  } catch (e) {
    console.error("Pairs read error:", e);
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  }
}

// JSON YAZ
function writePairs(pairs) {
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ pairs }, null, 2),
      "utf8"
    );
  } catch (e) {
    console.error("Pairs write error:", e);
  }
}

export async function getActivePairs() {
  return readPairs();
}

export async function addPair(symbol) {
  symbol = symbol.toUpperCase();

  const pairs = readPairs();
  if (!pairs.includes(symbol)) {
    pairs.push(symbol);
    writePairs(pairs);
  }
  return pairs;
}

export async function removePair(symbol) {
  symbol = symbol.toUpperCase();

  let pairs = readPairs();
  pairs = pairs.filter(p => p !== symbol);
  writePairs(pairs);

  return pairs;
}
