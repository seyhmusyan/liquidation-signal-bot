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
// Binance Liquidation REST (pseudo realtime)
// ==============================
async function fetchBinanceLiquidations(symbol, price) {
  // Futures force orders endpoint (REST simülasyonu)
  try {
    const r = await fetch(
      `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${symbol}&limit=50`
    );
    if (!r.ok) return { nearest: null, biggestCluster: null, mmSide: null };

    const data = await r.json();
    if (!Array.isArray(data) || !data.length) {
      return { nearest: null, biggestCluster: null, mmSide: null };
    }

    let nearest = null;
    const buckets = new Map(); // price bucket -> total notional
    let longQty = 0;
    let shortQty = 0;

    for (const o of data) {
      const p = Number(o.price);
      const qty = Number(o.origQty);
      if (!Number.isFinite(p) || !Number.isFinite(qty) || qty <= 0) continue;

      const notional = p * qty;
      const distPct = Math.abs(p - price) / price * 100;

      // nearest
      if (!nearest || distPct < nearest.distPct) {
        nearest = {
          price: p,
          distPct,
          notional
        };
      }

      // cluster (bucket)
      const bucketKey = Math.round(p);
      buckets.set(bucketKey, (buckets.get(bucketKey) || 0) + notional);

      // side belirleme: 
      // BUY genelde short liquidation, SELL long liquidation gibi davranırız
      if (o.side === "BUY") {
        shortQty += notional;
      } else if (o.side === "SELL") {
        longQty += notional;
      }
    }

    let biggestCluster = null;
    for (const [bk, val] of buckets.entries()) {
      if (!biggestCluster || val > biggestCluster.notional) {
        const distPct = Math.abs(bk - price) / price * 100;
        biggestCluster = {
          price: bk,
          notional: val,
          distPct
        };
      }
    }

    let mmSide = null;
    if (longQty > shortQty * 1.3) mmSide = "LONG";
    else if (shortQty > longQty * 1.3) mmSide = "SHORT";

    return { nearest, biggestCluster, mmSide };
  } catch (e) {
    console.error("Binance liq error", symbol, e);
    return { nearest: null, biggestCluster: null, mmSide: null };
  }
}

// ==============================
// Coinglass liquidation + OI + Funding + L/S
// ==============================
async function fetchCoinglassMetrics(symbol, price) {
  const key = process.env.COINGLASS_API;
  if (!key) {
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
    const bids = d.bids?.slice(0, 10).reduce((a,b)=>a+Number(b[1]),0) || 0;
    const asks = d.asks?.slice(0, 10).reduce((a,b)=>a+Number(b[1]),0) || 0;
    if (bids + asks > 0) mexOb = bids / (bids + asks);
  } catch (e) {
    console.error("MEXC depth error", symbol, e);
  }

  try {
    const t = await fetch(
      `https://api.mexc.com/api/v3/trades?symbol=${symbol}&limit=20`
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

// ==============================
// MM Brain: MMYON direction
// ==============================
function computeMMBrain({
  cgNearestLong,
  cgNearestShort,
  binanceNearest,
  binanceCluster,
  fundingRate,
  longShort,
  price
}) {
  let scoreLong = 0;
  let scoreShort = 0;
  const notes = [];

  // Coinglass nearest liq
  if (cgNearestLong && cgNearestLong.distPct < 2) {
    scoreShort += 1;
    notes.push("Yakın LONG liq (aşağı fitil riski)");
  }
  if (cgNearestShort && cgNearestShort.distPct < 2) {
    scoreLong += 1;
    notes.push("Yakın SHORT liq (yukarı fitil riski)");
  }

  // Binance nearest liq
  if (binanceNearest) {
    if (binanceNearest.price > price) {
      scoreLong += 0.5;
      notes.push("Üst tarafta Binance liq birikimi");
    } else {
      scoreShort += 0.5;
      notes.push("Alt tarafta Binance liq birikimi");
    }
  }

  // Binance biggest cluster
  if (binanceCluster) {
    if (binanceCluster.price > price) {
      scoreLong += 0.7;
      notes.push("Yukarıda büyük likidasyon cluster");
    } else {
      scoreShort += 0.7;
      notes.push("Aşağıda büyük likidasyon cluster");
    }
  }

  // Funding
  if (typeof fundingRate === "number") {
    if (fundingRate > 0) {
      scoreShort += 0.3;
      notes.push("Funding pozitif (long crowded)");
    } else if (fundingRate < 0) {
      scoreLong += 0.3;
      notes.push("Funding negatif (short crowded)");
    }
  }

  // Long / Short ratio
  if (typeof longShort === "number") {
    if (longShort > 1.2) {
      scoreShort += 0.5;
      notes.push("Long çoğunlukta (MM short tarafı destekleyebilir)");
    } else if (longShort < 0.8) {
      scoreLong += 0.5;
      notes.push("Short çoğunlukta (MM long tarafı destekleyebilir)");
    }
  }

  let mmDir = "AVOID";
  if (scoreLong > scoreShort * 1.2) mmDir = "LONG";
  else if (scoreShort > scoreLong * 1.2) mmDir = "SHORT";

  return {
    mmDir,
    scoreLong,
    scoreShort,
    notes
  };
}

// ==============================
// Combined Trading Score
// ==============================
function buildCombinedScore({ cgScore, mexOb, mexMom, mmDir }) {
  let base = cgScore ?? 0.5;

  // Orderbook & momentum
  base = base * 0.6 + (mexOb ?? 0.5) * 0.2 + (mexMom ?? 0.5) * 0.2;

  // MM direction ile ufak bias
  if (mmDir === "LONG") base += 0.05;
  if (mmDir === "SHORT") base -= 0.05;

  return Math.max(0, Math.min(1, base));
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
      const mex = await fetchMexcMetrics(symbol);
      const bxLiq = await fetchBinanceLiquidations(symbol, price);

      const mmBrain = computeMMBrain({
        cgNearestLong: cg.nearestLong,
        cgNearestShort: cg.nearestShort,
        binanceNearest: bxLiq.nearest,
        binanceCluster: bxLiq.biggestCluster,
        fundingRate: cg.fundingRate,
        longShort: cg.longShort,
        price
      });

      const score = buildCombinedScore({
        cgScore: cg.cgScore,
        mexOb: mex.mexOb,
        mexMom: mex.mexMom,
        mmDir: mmBrain.mmDir
      });

      const signal = buildSignal({ symbol, price, score, volSpike });

      // Mod: scalp / swing seçimi (şimdilik otomatik)
      const mode = Math.abs(changePct) > 0.3 ? "SCALP" : "SWING";

      infos.push({
        symbol,
        price,
        changePct,
        volSpike,
        score,
        fundingRate: cg.fundingRate,
        oi: cg.oi,
        longShort: cg.longShort,
        cgNearestLong: cg.nearestLong,
        cgNearestShort: cg.nearestShort,
        binanceNearest: bxLiq.nearest,
        binanceCluster: bxLiq.biggestCluster,
        mmBrain,
        signal,
        mode
      });
    }

    // ======================================
    // 📍 NEAREST LIQUIDATION SNAPSHOT (HER ÇAĞRIDA)
    // ======================================
    if (infos.length) {
      let txt = `📍 <b>Nearest Liquidity Snapshot</b>\n\n`;
      for (const x of infos) {
        txt += `<b>${x.symbol}</b> — Price: ${x.price.toFixed(2)}\n`;

        if (x.cgNearestLong) {
          txt += `• Coinglass LONG: ${x.cgNearestLong.price.toFixed(2)} (${x.cgNearestLong.distPct.toFixed(2)}%)\n`;
        }
        if (x.cgNearestShort) {
          txt += `• Coinglass SHORT: ${x.cgNearestShort.price.toFixed(2)} (${x.cgNearestShort.distPct.toFixed(2)}%)\n`;
        }
        if (x.binanceNearest) {
          txt += `• Binance liq: ${x.binanceNearest.price.toFixed(2)} (${x.binanceNearest.distPct.toFixed(2)}%)\n`;
        }
        if (x.binanceCluster) {
          txt += `• Binance cluster: ${x.binanceCluster.price.toFixed(2)} (~${x.binanceCluster.notional.toFixed(0)})\n`;
        }
        txt += `\n`;
      }
      await sendTelegramMessage(txt);
    }

    // ======================================
    // ⏱ 1m PRICE + MMYON SUMMARY
    // ======================================
    if (infos.length) {
      let txt = `⏱ <b>1m Price & MMYON Summary</b>\n\n`;
      for (const x of infos) {
        txt += `<b>${x.symbol}</b> ${x.price.toFixed(2)} (${x.changePct.toFixed(2)}%) — MMYON: ${x.mmBrain.mmDir}, Mode: ${x.mode}\n`;
      }
      await sendTelegramMessage(txt);
    }

    // ======================================
    // 💎 PRO SIGNAL (EĞER VARSA)
    // ======================================
    for (const x of infos) {
      if (!x.signal) continue;

      const s = x.signal;

      let mmNotes = "";
      if (x.mmBrain.notes.length) {
        mmNotes = x.mmBrain.notes.map(n => `• ${n}`).join("\n");
      }

      const msg = `
💎 <b>PRO SIGNAL</b>

<b>${x.symbol}</b>
MMYON: <b>${x.mmBrain.mmDir}</b>
Mode: <b>${x.mode}</b>

Side: <b>${s.side}</b>
Entry: <b>${s.entry.toFixed(2)}</b>
TP1: <b>${s.tp1.toFixed(2)}</b>
TP2: <b>${s.tp2.toFixed(2)}</b>
SL: <b>${s.sl.toFixed(2)}</b>
Confidence: <b>${s.confidence}%</b>

Score: ${(x.score * 100).toFixed(0)}%
Change 1m: ${x.changePct.toFixed(2)}%
Vol Spike: ${x.volSpike.toFixed(2)}x

Funding: ${x.fundingRate != null ? x.fundingRate.toFixed(4) : "N/A"}
OI: ${x.oi != null ? x.oi.toFixed(0) : "N/A"}
Long/Short: ${x.longShort != null ? x.longShort.toFixed(2) : "N/A"}

MM Notes:
${mmNotes || "N/A"}

TradingView:
${buildTradingViewLink(x.symbol)}

Time: ${now.toISOString()}
      `.trim();

      await sendTelegramMessage(msg);
    }

    return res.status(200).json({ ok: true, count: infos.length });
  } catch (e) {
    console.error("signal error", e);
    return res.status(500).json({ error: e.toString() });
  }
}
