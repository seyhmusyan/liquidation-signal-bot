const COINGLASS_KEY = process.env.COINGLASS_API;

function headers() {
  return { coinglassSecret: COINGLASS_KEY || "" };
}

function toCG(symbol) {
  if (!symbol) return null;
  if (symbol.endsWith("USDT")) {
    const base = symbol.slice(0, -4);
    return base.replace("1000", "");
  }
  return symbol;
}

export async function getFunding(symbol) {
  if (!COINGLASS_KEY) return null;
  const base = toCG(symbol);
  try {
    const r = await fetch(`https://open-api.coinglass.com/api/futures/funding?symbol=${base}`, { headers: headers() });
    if (!r.ok) return null;
    const j = await r.json();
    const d = j.data || {};
    return d.fundingRate ?? d.fundingRateValue ?? null;
  } catch (e) {
    console.error("Coinglass funding error", e);
    return null;
  }
}

export async function getOI(symbol) {
  if (!COINGLASS_KEY) return null;
  const base = toCG(symbol);
  try {
    const r = await fetch(`https://open-api.coinglass.com/api/futures/openInterest?symbol=${base}`, { headers: headers() });
    if (!r.ok) return null;
    const j = await r.json();
    const row = Array.isArray(j.data) ? j.data[0] : j.data;
    return row?.openInterest ?? row?.sumOpenInterest ?? null;
  } catch (e) {
    console.error("Coinglass OI error", e);
    return null;
  }
}

export async function getLongShort(symbol) {
  if (!COINGLASS_KEY) return null;
  const base = toCG(symbol);
  try {
    const r = await fetch(`https://open-api.coinglass.com/api/futures/longShortRate?symbol=${base}`, { headers: headers() });
    if (!r.ok) return null;
    const j = await r.json();
    const row = Array.isArray(j.data) ? j.data[0] : j.data;
    return row?.longShortRate ?? row?.longShortRatio ?? row?.ratio ?? null;
  } catch (e) {
    console.error("Coinglass longShort error", e);
    return null;
  }
}

export async function getLiqMap(symbol, price) {
  if (!COINGLASS_KEY) {
    return { nearestLong: null, nearestShort: null, score: 0.5 };
  }
  const base = toCG(symbol);
  try {
    const r = await fetch(`https://open-api.coinglass.com/public/v2/liquidationMap?symbol=${base}`, { headers: headers() });
    if (!r.ok) return { nearestLong: null, nearestShort: null, score: 0.5 };
    const j = await r.json();
    if (!Array.isArray(j.data)) return { nearestLong: null, nearestShort: null, score: 0.5 };

    let nearestLong = null;
    let nearestShort = null;
    let bestScore = 0.5;

    for (const lvl of j.data) {
      const lp = Number(lvl.price);
      const val = Number(lvl.value);
      if (!Number.isFinite(lp) || !Number.isFinite(val)) continue;
      const dist = Math.abs(lp - price) / price * 100;
      const side = String(lvl.side || "").toLowerCase();

      if (side === "long") {
        if (!nearestLong || dist < nearestLong.dist) {
          nearestLong = { price: lp, dist, value: val };
        }
      } else if (side === "short") {
        if (!nearestShort || dist < nearestShort.dist) {
          nearestShort = { price: lp, dist, value: val };
        }
      }
      if (dist < 2) {
        bestScore = Math.max(bestScore, Math.min(1, val / 1_000_000));
      }
    }

    return { nearestLong, nearestShort, score: bestScore };
  } catch (e) {
    console.error("Coinglass liq error", e);
    return { nearestLong: null, nearestShort: null, score: 0.5 };
  }
}
