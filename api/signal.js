export const config = { runtime: "nodejs" };

import { getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { buildSignal } from "./strategy.js";
import { buildTradingViewLink } from "../utils/tradingview.js";

// Fiyat fallback: Binance -> MEXC -> Coingecko
async function fetchFallbackPrice(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) {
      const j = await r.json();
      const p = Number(j.price);
      if (Number.isFinite(p)) return p;
    }
  } catch {}

  try {
    const r = await fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) {
      const j = await r.json();
      const p = Number(j.price);
      if (Number.isFinite(p)) return p;
    }
  } catch {}

  try {
    const id = symbol.replace("USDT", "").toLowerCase();
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`
    );
    if (r.ok) {
      const j = await r.json();
      if (j[id]?.usd) {
        const p = Number(j[id].usd);
        if (Number.isFinite(p)) return p;
      }
    }
  } catch {}

  return null;
}

// Binance 1m + volume spike + fallback
async function fetchBinance1m(symbol) {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=3`
    );
    if (!r.ok) {
      const fp = await fetchFallbackPrice(symbol);
      return { price: fp, changePct: 0, volSpike: 1 };
    }

    const data = await r.json();
    if (!Array.isArray(data) || data.length < 2) {
      const fp = await fetchFallbackPrice(symbol);
      return { price: fp, changePct: 0, volSpike: 1 };
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

    const changePct = (finalPrice - prevClose) / prevClose * 100;
    const volSpike  = Number.isFinite(lastVol) && Number.isFinite(prevVol) && prevVol > 0
      ? lastVol / prevVol
      : 1;

    return { price: finalPrice, changePct, volSpike };
  } catch {
    const fp = await fetchFallbackPrice(symbol);
    return { price: fp, changePct: 0, volSpike: 1 };
  }
}

// Coinglass: liq + funding + OI + long/short
async function fetchCoinglassMetrics(symbol, price) {
  const key = process.env.COINGLASS_API;
  if (!key) {
    console.log("COINGLASS_API missing, using neutral metrics");
    return {
      cgScore: 0.5,
      nearestLong: null,
      nearestShort: null,
      fundingRate: null,
      oi: null,
      longShort: null
    };
  }

  const base = symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;

  let nearestLong = null;
  let nearestShort = null;
  let cgScore = 0.5;
  let fundingRate = null;
  let oi = null;
  let longShort = null;

  // liquidation map
  try {
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
          const side = String(lvl.side || "").toLowerCase();

          if (side === "long") {
            if (!nearestLong || distPct < nearestLong.distPct || val > nearestLong.value) {
              nearestLong = { price: lp, value: val, distPct };
            }
          } else if (side === "short") {
            if (!nearestShort || distPct < nearestShort.distPct || val > nearestShort.value) {
              nearestShort = { price: lp, value: val, distPct };
            }
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
    console.error("Coinglass liq error", symbol, e);
  }

  // funding
  try {
    const fr = await fetch(
      `https://open-api.coinglass.com/public/v2/fundingRate?symbol=${base}`,
      { headers: { coinglassSecret: key } }
    );
    if (fr.ok) {
      const j = await fr.json();
      if (j?.data && Array.isArray(j.data) && j.data.length) {
        const row = j.data[0];
        fundingRate = Number(row.fundingRate ?? row.fundingRateValue ?? 0);
      }
    }
  } catch (e) {
    console.error("Coinglass funding error", symbol, e);
  }

  // OI
  try {
    const oiRes = await fetch(
      `https://open-api.coinglass.com/public/v2/openInterest?symbol=${base}`,
      { headers: { coinglassSecret: key } }
    );
    if (oiRes.ok) {
      const j = await oiRes.json();
      if (j?.data && Array.isArray(j.data) && j.data.length) {
        const row = j.data[0];
        oi = Number(row.openInterest ?? row.sumOpenInterest ?? 0);
      }
    }
  } catch (e) {
    console.error("Coinglass OI error", symbol, e);
  }

  // long/short ratio
  try {
    const lr = await fetch(
      `https://open-api.coinglass.com/public/v2/longShort?symbol=${base}`,
      { headers: { coinglassSecret: key } }
    );
    if (lr.ok) {
      const j = await lr.json();
      if (j?.data && Array.isArray(j.data) && j.data.length) {
        const row = j.data[0];
        longShort = Number(row.longShortRatio ?? row.ratio ?? 1);
      }
    }
  } catch (e) {
    console.error("Coinglass longShort error", symbol, e);
  }

  return { cgScore, nearestLong, nearestShort, fundingRate, oi, longShort };
}

// MEXC orderbook + momentum
async function fetchMexcMetrics(symbol) {
  let mexOb = 0.5;
  let mexMom = 0.5;

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

  return { mexOb, mexMom };
}

// Combined score (0–1)
function buildCombinedScore({ cgScore, mexOb, mexMom, longShort, fundingRate }) {
  let score = 0.5;

  const lsScore = longShort
    ? Math.max(0, Math.min(1, longShort / 2))
    : 0.5;

  const fundScore = fundingRate
    ? Math.max(0, Math.min(1, 0.5 + fundingRate * 50))
    : 0.5;

  score =
    (cgScore ?? 0.5) * 0.5 +
    (mexOb ?? 0.5) * 0.2 +
    (mexMom ?? 0.5) * 0.15 +
    lsScore * 0.1 +
    fundScore * 0.05;

  return Math.max(0, Math.min(1, score));
}

export default async function handler(req, res) {
  try {
    const pairs = await getActivePairs();
    const now = new Date();
    const sec = now.getUTCSeconds();
    const shouldSummary = sec < 5; // her dakika başı özet

    const infos = [];

    for (const symbol of pairs) {
      const { price, changePct, volSpike } = await fetchBinance1m(symbol);
      if (!Number.isFinite(price)) continue;

      const cg = await fetchCoinglassMetrics(symbol, price);
      const mx = await fetchMexcMetrics(symbol);
      const score = buildCombinedScore({
        cgScore: cg.cgScore,
        mexOb: mx.mexOb,
        mexMom: mx.mexMom,
        longShort: cg.longShort,
        fundingRate: cg.fundingRate
      });

      const signal = buildSignal({ symbol, price, score, volSpike });

      let pumpDumpTag = "";
      if (score >= 0.8) pumpDumpTag = "PUMP RISK (LONG PRESSURE)";
      else if (score <= 0.2) pumpDumpTag = "DUMP RISK (SHORT PRESSURE)";

      infos.push({
        symbol,
        price,
        changePct,
        volSpike,
        score,
        pumpDumpTag,
        nearestLong: cg.nearestLong,
        nearestShort: cg.nearestShort,
        fundingRate: cg.fundingRate,
        oi: cg.oi,
        longShort: cg.longShort,
        signal
      });
    }

    // PRO SIGNAL mesajları
    for (const info of infos) {
      if (!info.signal) continue;
      const s = info.signal;

      const nearestLongLine = info.nearestLong
        ? `Liq LONG: ${info.nearestLong.price.toFixed(2)} (${info.nearestLong.distPct.toFixed(2)}%, ~${info.nearestLong.value.toFixed(0)})`
        : "Liq LONG: N/A";
      const nearestShortLine = info.nearestShort
        ? `Liq SHORT: ${info.nearestShort.price.toFixed(2)} (${info.nearestShort.distPct.toFixed(2)}%, ~${info.nearestShort.value.toFixed(0)})`
        : "Liq SHORT: N/A";

      const pumpLine = info.pumpDumpTag ? `🚨 ${info.pumpDumpTag}\\n` : "";

      const msg = `
💎 <b>PRO SIGNAL</b>

${pumpLine}<b>${info.symbol}</b>

Side: <b>${s.side}</b>
Entry: <b>${s.entry.toFixed(2)}</b>
TP1: <b>${s.tp1.toFixed(2)}</b>
TP2: <b>${s.tp2.toFixed(2)}</b>
SL: <b>${s.sl.toFixed(2)}</b>
Confidence: <b>${s.confidence}%</b>

Score: ${(info.score * 100).toFixed(0)}%
1m Change: ${info.changePct.toFixed(2)}%
Volume Spike: ${info.volSpike.toFixed(2)}x

Funding: ${info.fundingRate != null ? info.fundingRate.toFixed(4) : "N/A"}
OI: ${info.oi != null ? info.oi.toFixed(0) : "N/A"}
Long/Short: ${info.longShort != null ? info.longShort.toFixed(2) : "N/A"}

${nearestLongLine}
${nearestShortLine}

TradingView:
${buildTradingViewLink(info.symbol, "15")}

Time: ${now.toISOString()}
      `.trim();

      await sendTelegramMessage(msg);
    }

    // Her tick'te nearest liquidity snapshot
    if (infos.length) {
      let liqText = `📍 Nearest Liquidity Snapshot\\n\\n`;
      for (const info of infos) {
        liqText += `<b>${info.symbol}</b> — Price: ${info.price.toFixed(2)}\\n`;
        if (info.nearestLong) {
          liqText += `• Long: ${info.nearestLong.price.toFixed(2)} (${info.nearestLong.distPct.toFixed(2)}%, ~${info.nearestLong.value.toFixed(0)})\\n`;
        }
        if (info.nearestShort) {
          liqText += `• Short: ${info.nearestShort.price.toFixed(2)} (${info.nearestShort.distPct.toFixed(2)}%, ~${info.nearestShort.value.toFixed(0)})\\n`;
        }
        liqText += "\\n";
      }
      await sendTelegramMessage(liqText.trim());
    }

    // Her dakika 1m price + liq summary
    if (shouldSummary && infos.length) {
      let sumText = `⏱ <b>1m Price & Liq Summary</b>\\n\\n`;
      for (const info of infos) {
        const longTxt = info.nearestLong
          ? `L: ${info.nearestLong.price.toFixed(0)} (${info.nearestLong.distPct.toFixed(2)}%)`
          : "L: N/A";
        const shortTxt = info.nearestShort
          ? `S: ${info.nearestShort.price.toFixed(0)} (${info.nearestShort.distPct.toFixed(2)}%)`
          : "S: N/A";
        sumText += `<b>${info.symbol}</b>: ${info.price.toFixed(2)} (${info.changePct.toFixed(2)}%) — ${longTxt} | ${shortTxt}\\n`;
      }
      await sendTelegramMessage(sumText.trim());
    }

    res.status(200).json({ ok: true, count: infos.length });
  } catch (e) {
    console.error("signal handler error", e);
    res.status(500).json({ error: e.toString() });
  }
}
