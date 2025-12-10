export const config = { runtime: "nodejs" };

import { getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { buildSignal } from "./strategy.js";
import { buildTradingViewLink } from "../utils/tradingview.js";

async function fetchBinancePrice(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (!r.ok) return null;
    const j = await r.json();
    return Number(j.price);
  } catch { return null; }
}

function symbolToBase(symbol) {
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

async function fetchHeatScore(symbol, price) {
  const key = process.env.COINGLASS_API;
  if (!key) return 0.5;

  try {
    const base = symbolToBase(symbol);
    const r = await fetch(
      `https://open-api.coinglass.com/public/v2/liquidationMap?symbol=${base}`,
      { headers: { coinglassSecret: key } }
    );
    if (!r.ok) return 0.5;
    const j = await r.json();
    if (!j?.data) return 0.5;

    let best = null;
    for (const lvl of j.data) {
      const lp = Number(lvl.price);
      const val = Number(lvl.value);
      if (!Number.isFinite(lp) || !Number.isFinite(val)) continue;

      const dist = Math.abs(lp - price) / price;
      if (dist > 0.02) continue;

      const score = val / 1_000_000;
      if (!best || score > best.score) best = { score };
    }

    if (!best) return 0.5;
    return Math.max(0, Math.min(1, best.score));
  } catch { return 0.5; }
}

export default async function handler(req, res) {
  const pairs = await getActivePairs();
  const out = [];

  for (const symbol of pairs) {
    const price = await fetchBinancePrice(symbol);
    if (!Number.isFinite(price)) continue;

    const heat = await fetchHeatScore(symbol, price);
    const signal = buildSignal({ symbol, price, heatScore: heat });

    if (signal) {
      const tv = buildTradingViewLink(symbol);
      const msg = `
🚨 <b>${symbol} Signal</b>
Side: <b>${signal.side}</b>
Entry: <b>${signal.entry.toFixed(2)}</b>
TP: <b>${signal.tp.toFixed(2)}</b>
SL: <b>${signal.sl.toFixed(2)}</b>
Confidence: <b>${signal.confidence}%</b>
TV: ${tv}
`.trim();
      await sendTelegramMessage(msg);
    }
    out.push({ symbol, price, heat, hasSignal: !!signal });
  }

  res.status(200).json({ ok: true, out });
}
