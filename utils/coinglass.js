const COINGLASS_KEY = process.env.COINGLASS_API;

function toCG(symbol) {
  if (symbol.endsWith("USDT"))
    return symbol.slice(0, -4).replace("1000", "");
  return symbol;
}

export async function getFunding(symbol) {
  const base = toCG(symbol);
  try {
    const r = await fetch(
      `https://open-api.coinglass.com/api/futures/funding?symbol=${base}`,
      { headers: { coinglassSecret: COINGLASS_KEY } }
    );
    const j = await r.json();
    return j.data?.fundingRate ?? null;
  } catch {
    return null;
  }
}

export async function getOI(symbol) {
  const base = toCG(symbol);
  try {
    const r = await fetch(
      `https://open-api.coinglass.com/api/futures/openInterest?symbol=${base}`,
      { headers: { coinglassSecret: COINGLASS_KEY } }
    );
    const j = await r.json();
    return j.data?.[0]?.openInterest ?? null;
  } catch { 
    return null; 
  }
}

export async function getLongShort(symbol) {
  const base = toCG(symbol);
  try {
    const r = await fetch(
      `https://open-api.coinglass.com/api/futures/longShortRate?symbol=${base}`,
      { headers: { coinglassSecret: COINGLASS_KEY } }
    );
    const j = await r.json();
    return j.data?.[0]?.longShortRate ?? null;
  } catch {
    return null;
  }
}

export async function getLiqMap(symbol, price) {
  const base = toCG(symbol);

  try {
    const r = await fetch(
      `https://open-api.coinglass.com/public/v2/liquidationMap?symbol=${base}`,
      { headers: { coinglassSecret: COINGLASS_KEY } }
    );

    const j = await r.json();
    if (!Array.isArray(j.data)) return { nearestLong: null, nearestShort: null, score: 0.5 };

    let nearestLong = null, nearestShort = null;
    let score = 0.5;

    for (const lvl of j.data) {
      const lp = Number(lvl.price);
      const val = Number(lvl.value);
      if (!Number.isFinite(lp) || !Number.isFinite(val)) continue;

      const dist = Math.abs(lp - price) / price * 100;

      if ((lvl.side || "").toLowerCase() === "long") {
        if (!nearestLong || dist < nearestLong.dist) {
          nearestLong = { price: lp, dist, val };
        }
      } else {
        if (!nearestShort || dist < nearestShort.dist) {
          nearestShort = { price: lp, dist, val };
        }
      }

      if (dist < 2) score = Math.min(1, Math.max(score, val / 1_000_000));
    }

    return { nearestLong, nearestShort, score };
  } catch {
    return { nearestLong: null, nearestShort: null, score: 0.5 };
  }
}
