import { getRecentLiquidations } from "./binanceLiquidations";
import { getOrderbook } from "./binanceOrderbook";
import { getOpenInterestChange } from "./binanceOI";
import { getLatestFundingRate } from "./binanceFunding";
import { getCoinglassHeatmap } from "./coinglass";

export async function getCombinedHeatmap(symbol, base, price) {
  const [liq, ob, oi, funding, cg] = await Promise.all([
    getRecentLiquidations(symbol),
    getOrderbook(symbol),
    getOpenInterestChange(symbol),
    getLatestFundingRate(symbol),
    getCoinglassHeatmap(base)
  ]);

  const buckets = new Map();
  for (const l of liq) {
    const key = Math.round(l.price / 50) * 50;
    if (!buckets.has(key)) buckets.set(key, { long: 0, short: 0 });
    buckets.get(key)[l.side] += l.notional;
  }

  const synthetic = [...buckets.entries()].map(([p, d]) => ({
    source: "binance",
    price: p,
    side: d.short > d.long ? "short" : "long",
    size: d.short + d.long,
    oiChange: oi,
    funding
  }));

  return [...synthetic, ...cg];
}