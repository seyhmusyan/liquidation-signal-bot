export const config = { runtime: "nodejs" };

import { getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { buildSignal } from "./strategy.js";
import { buildTradingViewLink } from "../utils/tradingview.js";

async function fetchPrice(symbol) {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );
    if (!r.ok) return null;
    const j = await r.json();
    return Number(j.price);
  } catch (e) {
    console.error("Binance price error", symbol, e);
    return null;
  }
}

async function fetchOneMinChange(symbol) {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=2`
    );
    if (!r.ok) return { changePct: 0 };
    const data = await r.json();
    if (!Array.isArray(data) || data.length < 2) return { changePct: 0 };
    const prevClose = Number(data[0][4]);
    const lastClose = Number(data[1][4]);
    if (!Number.isFinite(prevClose) || !Number.isFinite(lastClose) || prevClose === 0) {
      return { changePct: 0 };
    }
    const changePct = (lastClose - prevClose) / prevClose * 100;
    return { changePct };
  } catch (e) {
    console.error("1m change error", symbol, e);
    return { changePct: 0 };
  }
}

async function fetchScoreAndNearest(symbol, price) {
  const key = process.env.COINGLASS_API;
  if (!key) {
    throw new Error("COINGLASS_API missing");
  }

  let nearest = null;
  let cgScore = 0.5;

  try {
    const base = symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
    const r = await fetch(
      `https://open-api.coinglass.com/public/v2/liquidationMap?symbol=${base}`,
      { headers: { coinglassSecret: key } }
    );
    if (r.ok) {
      const j = await r.json();
      if (j?.data && Array.isArray(j.data)) {
        let bestScore = 0;
        for (const lvl of j.data) {
          const lp = Number(lvl.price);
          const val = Number(lvl.value);
          if (!Number.isFinite(lp) || !Number.isFinite(val)) continue;
          const distPct = Math.abs(lp - price) / price * 100;

          if (!nearest || distPct < nearest.distPct) {
            const side = String(lvl.side || lvl.longShort || "").toLowerCase();
            nearest = { price: lp, value: val, side, distPct };
          }

          if (distPct < 2) {
            const levelScore = val / 1_000_000;
            if (levelScore > bestScore) bestScore = levelScore;
          }
        }
        cgScore = Math.min(1, bestScore || 0.5);
      }
    }
  } catch (e) {
    console.error("Coinglass error", symbol, e);
    throw new Error("Coinglass fetch failed");
  }

  // MEXC orderbook
  let mexOb = 0.5;
  try {
    const d = await fetch(
      `https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=100`
    ).then(r => r.json());
    const bids = d.bids?.slice(0, 20).reduce((a, b) => a + Number(b[1]), 0) || 0;
    const asks = d.asks?.slice(0, 20).reduce((a, b) => a + Number(b[1]), 0) || 0;
    if (bids + asks > 0) {
      mexOb = bids / (bids + asks);
    }
  } catch (e) {
    console.error("MEXC depth error", symbol, e);
  }

  // MEXC trades momentum
  let mexMom = 0.5;
  try {
    const t = await fetch(
      `https://api.mexc.com/api/v3/trades?symbol=${symbol}&limit=50`
    ).then(r => r.json());
    let buy = 0, sell = 0;
    for (const x of t || []) {
      const qty = Number(x.qty);
      if (!Number.isFinite(qty)) continue;
      if (x.isBuyerMaker) sell += qty;
      else buy += qty;
    }
    const total = buy + sell;
    if (total > 0) mexMom = buy / total;
  } catch (e) {
    console.error("MEXC trades error", symbol, e);
  }

  const combined = cgScore * 0.6 + mexOb * 0.25 + mexMom * 0.15;

  let pumpDumpTag = "";
  if (combined >= 0.8) pumpDumpTag = "PUMP RISK (LONG PRESSURE)";
  else if (combined <= 0.2) pumpDumpTag = "DUMP RISK (SHORT PRESSURE)";

  return { score: combined, nearest, pumpDumpTag };
}

export default async function handler(req, res) {
  try {
    const pairs = await getActivePairs();
    const now = new Date();
    const sec = now.getUTCSeconds();
    const shouldSummary = sec < 5;

    const infos = [];

    for (const symbol of pairs) {
      const price = await fetchPrice(symbol);
      if (!Number.isFinite(price)) continue;

      const { changePct } = await fetchOneMinChange(symbol);
      const { score, nearest, pumpDumpTag } = await fetchScoreAndNearest(symbol, price);
      const signal = buildSignal({ symbol, price, score });

      infos.push({ symbol, price, changePct, score, nearest, pumpDumpTag, signal });
    }

    // Premium signals
    for (const info of infos) {
      if (!info.signal) continue;
      const s = info.signal;

      const nearestText = info.nearest
        ? `Nearest liq: ${info.nearest.price.toFixed(2)} (${info.nearest.side || "n/a"}, ${info.nearest.distPct.toFixed(2)}%, ~${info.nearest.value.toFixed(0)})`
        : "Nearest liq: N/A";

      const pumpLine = info.pumpDumpTag ? `🚨 ${info.pumpDumpTag}\n` : "";

      const msg = `
💎 <b>PREMIUM SIGNAL</b>

${pumpLine}<b>${info.symbol}</b>

Side: <b>${s.side}</b>
Entry: <b>${s.entry.toFixed(2)}</b>
TP: <b>${s.tp.toFixed(2)}</b>
SL: <b>${s.sl.toFixed(2)}</b>
Confidence: <b>${s.confidence}%</b>

${nearestText}
1m Change: ${info.changePct.toFixed(2)}%

TradingView:
${buildTradingViewLink(info.symbol, "15")}

Time: ${now.toISOString()}
      `.trim();

      await sendTelegramMessage(msg);
    }

    // Nearest liquidation snapshot every tick
    if (infos.length) {
      let liqText = `📍 Nearest Liquidations (live)\n\n`;
      for (const info of infos) {
        if (!info.nearest) continue;
        liqText += `<b>${info.symbol}</b>\n`;
        liqText += `• Price: ${info.price.toFixed(2)}\n`;
        liqText += `• Nearest liq: ${info.nearest.price.toFixed(2)} (${info.nearest.side || "n/a"})\n`;
        liqText += `• Distance: ${info.nearest.distPct.toFixed(2)}%\n`;
        liqText += `• Size: ~${info.nearest.value.toFixed(0)}\n\n`;
      }
      await sendTelegramMessage(liqText.trim());
    }

    // 1m price & change summary roughly once per minute
    if (shouldSummary && infos.length) {
      let sumText = `⏱ <b>1m Price & Change Summary</b>\n\n`;
      for (const info of infos) {
        sumText += `<b>${info.symbol}</b>: ${info.price.toFixed(2)} (${info.changePct.toFixed(2)}%)\n`;
      }
      await sendTelegramMessage(sumText.trim());
    }

    res.status(200).json({ ok: true, count: infos.length });
  } catch (e) {
    console.error("signal handler error", e);
    res.status(500).json({ error: e.toString() });
  }
}
