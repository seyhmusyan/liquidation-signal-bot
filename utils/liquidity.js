const FAPI_BASE = "https://fapi.binance.com";

export async function getLiquidityMap(symbol, price) {
  try {
    const r = await fetch(
      `${FAPI_BASE}/fapi/v1/depth?symbol=${symbol}&limit=100`
    );
    if (!r.ok) {
      return { nearestLong: null, nearestShort: null, score: 0.5 };
    }
    const j = await r.json();
    const bids = j.bids || [];
    const asks = j.asks || [];

    let nearestLong = null;
    let nearestShort = null;
    let maxNotionalAround = 0;

    for (const [pStr, qStr] of bids) {
      const p = Number(pStr);
      const q = Number(qStr);
      if (!Number.isFinite(p) || !Number.isFinite(q)) continue;
      if (p >= price) continue;
      const notional = p * q;
      const distPct = Math.abs(price - p) / price * 100;
      if (!nearestLong || distPct < nearestLong.dist) {
        nearestLong = { price: p, dist: distPct, value: notional };
      }
      if (distPct < 2) {
        if (notional > maxNotionalAround) maxNotionalAround = notional;
      }
    }

    for (const [pStr, qStr] of asks) {
      const p = Number(pStr);
      const q = Number(qStr);
      if (!Number.isFinite(p) || !Number.isFinite(q)) continue;
      if (p <= price) continue;
      const notional = p * q;
      const distPct = Math.abs(p - price) / price * 100;
      if (!nearestShort || distPct < nearestShort.dist) {
        nearestShort = { price: p, dist: distPct, value: notional };
      }
      if (distPct < 2) {
        if (notional > maxNotionalAround) maxNotionalAround = notional;
      }
    }

    let score = 0.5;
    if (maxNotionalAround > 0) {
      const base = symbol.startsWith("BTC") ? 5_000_000 : 1_000_000;
      score = Math.min(1, maxNotionalAround / base);
      if (score < 0.3) score = 0.3;
    }

    return { nearestLong, nearestShort, score };
  } catch (e) {
    console.error("liq map error", symbol, e);
    return { nearestLong: null, nearestShort: null, score: 0.5 };
  }
}
