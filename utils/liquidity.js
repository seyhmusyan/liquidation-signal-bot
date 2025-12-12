const FAPI_BASE = "https://fapi.binance.com";

function normalizeLevels(levels, price, side) {
  const out = [];
  for (const [pStr, qStr] of levels) {
    const p = Number(pStr);
    const q = Number(qStr);
    if (!Number.isFinite(p) || !Number.isFinite(q) || p <= 0 || q <= 0) continue;
    if (side === "bid" && p >= price) continue;
    if (side === "ask" && p <= price) continue;
    const notional = p * q;
    const dist = Math.abs(p - price) / price * 100;
    out.push({ price: p, dist, value: notional });
  }
  return out;
}

function pickNearest(arr) {
  let best = null;
  for (const x of arr) if (!best || x.dist < best.dist) best = x;
  return best;
}

function pickTop2High(arr) {
  const close = arr.filter(x => x.dist <= 3);
  const src = close.length ? close : arr;
  const sorted = [...src].sort((a,b) => b.value - a.value);
  return sorted.slice(0,2);
}

export async function getLiquidityMap(symbol, price) {
  try {
    const r = await fetch(`${FAPI_BASE}/fapi/v1/depth?symbol=${symbol}&limit=200`);
    if (!r.ok) return { nearestBid: null, nearestAsk: null, topLong: [], topShort: [], score: 0.5 };

    const j = await r.json();
    const bids = normalizeLevels(j.bids || [], price, "bid");
    const asks = normalizeLevels(j.asks || [], price, "ask");

    const nearestBid = pickNearest(bids);
    const nearestAsk = pickNearest(asks);

    const topLong = pickTop2High(bids);
    const topShort = pickTop2High(asks);

    let maxNotionalAround = 0;
    for (const x of [...bids, ...asks]) if (x.dist <= 2) maxNotionalAround = Math.max(maxNotionalAround, x.value);

    let score = 0.5;
    if (maxNotionalAround > 0) {
      const base = symbol.startsWith("BTC") ? 5_000_000 : 1_000_000;
      score = Math.min(1, maxNotionalAround / base);
      if (score < 0.3) score = 0.3;
    }

    return { nearestBid, nearestAsk, topLong, topShort, score };
  } catch (e) {
    console.error("liq map error", symbol, e);
    return { nearestBid: null, nearestAsk: null, topLong: [], topShort: [], score: 0.5 };
  }
}
