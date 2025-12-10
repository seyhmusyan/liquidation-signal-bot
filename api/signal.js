export const config = { runtime: "nodejs18.x" };

import { getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { buildSignal } from "./strategy.js";
import { buildTradingViewLink } from "../utils/tradingview.js";

async function fetchBinancePrice(symbol) {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    return Number(json.price);
  } catch (e) {
    console.error("Binance price error", symbol, e);
    return null;
  }
}

function symbolToBase(symbol) {
  if (symbol.endsWith("USDT")) return symbol.slice(0, -4);
  return symbol;
}

// Basit heat score: Coinglass API varsa ona göre, yoksa 0.5
async function fetchHeatScore(symbol, price) {
  const key = process.env.COINGLASS_API;
  if (!key) return 0.5;

  const base = symbolToBase(symbol);

  try {
    const res = await fetch(
      `https://open-api.coinglass.com/public/v2/liquidationMap?symbol=${base}`,
      {
        headers: { coinglassSecret: key }
      }
    );
    if (!res.ok) {
      console.log("Coinglass response not ok", res.status);
      return 0.5;
    }
    const data = await res.json();
    if (!data || !data.data || !Array.isArray(data.data)) return 0.5;

    // Fiyata en yakın level'i bul
    let best = null;
    for (const lvl of data.data) {
      const lvlPrice = Number(lvl.price);
      if (!Number.isFinite(lvlPrice)) continue;
      const dist = Math.abs(lvlPrice - price) / price;
      if (dist > 0.02) continue; // %2'den uzakta olanları görmezden gel
      const notional = Number(lvl.value || 0);
      if (!Number.isFinite(notional)) continue;

      const score = notional / (1_000_000); // 1M referans
      if (!best || score > best.score) {
        best = { dist, score };
      }
    }

    if (!best) return 0.5;

    // skoru 0-1 aralığına sıkıştır
    const s = Math.max(0, Math.min(1, best.score));
    return s;
  } catch (e) {
    console.error("Coinglass heat error", e);
    return 0.5;
  }
}

export default async function handler(req, res) {
  try {
    const pairs = await getActivePairs();
    const results = [];

    for (const symbol of pairs) {
      const price = await fetchBinancePrice(symbol);
      if (!Number.isFinite(price)) continue;

      const heatScore = await fetchHeatScore(symbol, price);
      const signal = buildSignal({ symbol, price, heatScore });

      if (signal) {
        const tv = buildTradingViewLink(symbol, "15");
        const msg = `
🚨 <b>${symbol} Liquidation Signal</b>

📊 Side: <b>${signal.side}</b>
💰 Entry: <b>${signal.entry.toFixed(2)}</b>
🎯 TP: <b>${signal.tp.toFixed(2)}</b>
🛑 SL: <b>${signal.sl.toFixed(2)}</b>
📈 Confidence: <b>%${signal.confidence}</b>

📉 TradingView:
${tv}

🕒 ${new Date().toUTCString()}
        `.trim();

        await sendTelegramMessage(msg);
      }

      results.push({ symbol, price, heatScore, hasSignal: !!signal });
    }

    res.status(200).json({ ok: true, results });
  } catch (e) {
    console.error("signal handler error", e);
    res.status(500).json({ error: e.toString() });
  }
}
