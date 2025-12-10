export const config = { runtime: "nodejs" };

import { getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { buildSignal } from "./strategy.js";
import { buildTradingViewLink } from "../utils/tradingview.js";

// ==============================
// Fallback Price Engine
// ==============================
async function fetchFallbackPrice(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) return Number((await r.json()).price);
  } catch {}

  try {
    const r = await fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) return Number((await r.json()).price);
  } catch {}

  try {
    const id = symbol.replace("USDT","").toLowerCase();
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`
    );
    if (r.ok) {
      const j = await r.json();
      if (j[id]?.usd) return Number(j[id].usd);
    }
  } catch {}

  return null;
}

// ==============================
// Binance 1m + volume spike
// ==============================
async function fetchBinance1m(symbol) {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=3`
    );

    if (!r.ok) {
      return { price: await fetchFallbackPrice(symbol), changePct: 0, volSpike: 1 };
    }

    const data = await r.json();
    if (!Array.isArray(data) || data.length < 2) {
      return { price: await fetchFallbackPrice(symbol), changePct: 0, volSpike: 1 };
    }

    const last = data[data.length - 1];
    const prev = data[data.length - 2];

    const lastClose = Number(last[4]);
    const prevClose = Number(prev[4]);
    const lastVol   = Number(last[5]);
    const prevVol   = Number(prev[5]);

    let finalPrice = Number.isFinite(lastClose)
      ? lastClose
      : await fetchFallbackPrice(symbol);

    if (!Number.isFinite(finalPrice) || !Number.isFinite(prevClose) || prevClose === 0) {
      finalPrice = await fetchFallbackPrice(symbol);
      if (!Number.isFinite(finalPrice)) {
        return { price: null, changePct: 0, volSpike: 1 };
      }
    }

    const changePct = ((finalPrice - prevClose) / prevClose * 100);
    const volSpike  = prevVol > 0 ? lastVol / prevVol : 1;

    return { price: finalPrice, changePct, volSpike };
  } catch {
    return { price: await fetchFallbackPrice(symbol), changePct: 0, volSpike: 1 };
  }
}

// ==============================
// Coinglass liquidation map
// ==============================
async function fetchCoinglassMetrics(symbol, price) {
  const key = process.env.COINGLASS_API;
  if (!key) {
    return {
      cgScore: 0.5,
      nearestLong: null,
      nearestShort: null
    };
  }

  const base = symbol.replace("USDT","");

  let nearestLong = null;
  let nearestShort = null;
  let cgScore = 0.5;

  try {
    const r = await fetch(
      `https://open-api.coinglass.com/public/v2/liquidationMap?symbol=${base}`,
      { headers: { coinglassSecret: key } }
    );

    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.data)) {

        let boost = 0;

        for (const lvl of j.data) {
          const lp = Number(lvl.price);
          const val = Number(lvl.value);
          const side = (lvl.side || "").toLowerCase();

          if (!Number.isFinite(lp) || !Number.isFinite(val)) continue;

          const distPct = Math.abs(lp - price) / price * 100;

          if (side === "long") {
            if (!nearestLong || distPct < nearestLong.distPct) {
              nearestLong = { price: lp, value: val, distPct };
            }
          } else {
            if (!nearestShort || distPct < nearestShort.distPct) {
              nearestShort = { price: lp, value: val, distPct };
            }
          }

          if (distPct < 2) {
            boost = Math.max(boost, val / 1_000_000);
          }
        }

        cgScore = Math.min(1, Math.max(0.5, boost));
      }
    }

  } catch {}

  return { cgScore, nearestLong, nearestShort };
}

// ==============================
// MEXC orderbook + momentum
// ==============================
async function fetchMexcMetrics(symbol) {
  let mexOb = 0.5;
  let mexMom = 0.5;

  try {
    const d = await fetch(
      `https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=50`
    ).then(r => r.json());

    const bids = d.bids?.slice(0,10).reduce((a,b)=>a+Number(b[1]),0) || 0;
    const asks = d.asks?.slice(0,10).reduce((a,b)=>a+Number(b[1]),0) || 0;

    if (bids + asks > 0) {
      mexOb = bids / (bids + asks);
    }
  } catch {}

  try {
    const t = await fetch(
      `https://api.mexc.com/api/v3/trades?symbol=${symbol}&limit=20`
    ).then(r => r.json());

    let buy = 0, sell = 0;
    for (const x of t) {
      const qty = Number(x.qty);
      if (x.isBuyerMaker) sell += qty;
      else buy += qty;
    }

    const total = buy + sell;
    if (total > 0) mexMom = buy / total;

  } catch {}

  return { mexOb, mexMom };
}

// ==============================
// Combined Score
// ==============================
function buildCombinedScore({ cgScore, mexOb, mexMom }) {
  return (
    cgScore * 0.6 +
    mexOb * 0.2 +
    mexMom * 0.2
  );
}

// ==============================
// MAIN HANDLER
// ==============================
export default async function handler(req, res) {
  try {
    const pairs = await getActivePairs();
    const now = new Date();

    const infos = [];

    for (const symbol of pairs) {
      const { price, changePct, volSpike } = await fetchBinance1m(symbol);
      if (!Number.isFinite(price)) continue;

      const cg = await fetchCoinglassMetrics(symbol, price);
      const mx = await fetchMexcMetrics(symbol);
      const score = buildCombinedScore({
        cgScore: cg.cgScore,
        mexOb: mx.mexOb,
        mexMom: mx.mexMom
      });

      const signal = buildSignal({ symbol, price, score, volSpike });

      infos.push({
        symbol,
        price,
        changePct,
        volSpike,
        score,
        nearestLong: cg.nearestLong,
        nearestShort: cg.nearestShort,
        signal
      });
    }

    // ======================================
    // 📍 NEAREST LIQUIDATION SNAPSHOT (HER ÇAĞRIDA)
    // ======================================
    if (infos.length) {
      let txt = `📍 <b>Nearest Liquidity Snapshot</b>\\n\\n`;
      for (const x of infos) {
        txt += `<b>${x.symbol}</b> ${x.price.toFixed(2)}\\n`;

        if (x.nearestLong) {
          txt += `• Long: ${x.nearestLong.price.toFixed(2)} (${x.nearestLong.distPct.toFixed(2)}%)\\n`;
        }
        if (x.nearestShort) {
          txt += `• Short: ${x.nearestShort.price.toFixed(2)} (${x.nearestShort.distPct.toFixed(2)}%)\\n`;
        }

        txt += "\\n";
      }
      await sendTelegramMessage(txt);
    }

    // ======================================
    // ⏱ 1m SUMMARY (HER ÇAĞRIDA)
    // ======================================
    if (infos.length) {
      let txt = `⏱ <b>1m Price Summary</b>\\n\\n`;
      for (const x of infos) {
        txt += `<b>${x.symbol}</b> ${x.price.toFixed(2)} (${x.changePct.toFixed(2)}%)\\n`;
      }
      await sendTelegramMessage(txt);
    }

    // ======================================
    // 💎 PRO SIGNAL (EĞER VARSA)
    // ======================================
    for (const x of infos) {
      if (!x.signal) continue;

      const s = x.signal;

      const msg = `
💎 <b>PRO SIGNAL</b>

<b>${x.symbol}</b>
Side: <b>${s.side}</b>
Entry: <b>${s.entry.toFixed(2)}</b>
TP1: <b>${s.tp1.toFixed(2)}</b>
TP2: <b>${s.tp2.toFixed(2)}</b>
SL: <b>${s.sl.toFixed(2)}</b>
Confidence: <b>${s.confidence}%</b>

Score: ${(x.score * 100).toFixed(0)}%
Change 1m: ${x.changePct.toFixed(2)}%
Vol Spike: ${x.volSpike.toFixed(2)}x

TradingView:
${buildTradingViewLink(x.symbol)}

Time: ${now.toISOString()}
      `;

      await sendTelegramMessage(msg);
    }

    return res.status(200).json({ ok: true, count: infos.length });

  } catch (e) {
    console.error("signal error", e);
    return res.status(500).json({ error: e.toString() });
  }
}
