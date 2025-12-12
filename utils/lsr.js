import { getLongShort as getBinanceLS } from "./futures.js";

const MEXC_THRESHOLD = { BTCUSDT: 500, AVAXUSDT: 300 };

export async function getAdvancedLSR(symbol, context = {}) {
  try {
    const bin = await getBinanceLS(symbol);
    if (bin && bin > 0 && Number.isFinite(bin)) return { source: "BINANCE", ratio: bin };
  } catch {}

  try {
    const limit = MEXC_THRESHOLD[symbol] || 200;
    const r = await fetch(`https://api.mexc.com/api/v3/trades?symbol=${symbol}&limit=${limit}`);
    if (r.ok) {
      const trades = await r.json();
      let buyVol = 0, sellVol = 0;
      for (const t of trades) {
        const price = Number(t.price);
        const qty = Number(t.qty);
        if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
        const notional = price * qty;
        if (t.isBuyerMaker) sellVol += notional; else buyVol += notional;
      }
      if (buyVol > 0 && sellVol > 0) return { source: "MEXC", ratio: buyVol / sellVol };
    }
  } catch {}

  let { funding = 0, oiBias = 0, whales = {} } = context;
  let whaleBias = 0;
  if (whales?.side === "BUY") whaleBias = 0.1;
  if (whales?.side === "SELL") whaleBias = -0.1;

  const estimate = 1 + oiBias * 0.5 + funding * 20 + whaleBias;
  const ratio = Math.min(Math.max(estimate, 0.5), 2.0);
  return { source: "AI", ratio };
}
