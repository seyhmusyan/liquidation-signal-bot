import fs from "fs";
import path from "path";

const filePath = path.join(process.cwd(), "data", "pairs.json");

// COINGLASS FORMAT PARSER
export function toCoinglassSymbol(symbol) {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

function readPairs() {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);
    return json.pairs || [];
  } catch (e) {
    console.error("Pairs read error", e);
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  }
}

function writePairs(pairs) {
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ pairs }, null, 2),
      "utf8"
    );
  } catch (e) {
    console.error("Pairs write error", e);
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
