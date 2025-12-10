export const config = { runtime: "nodejs" };

import { getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { buildSignal } from "./strategy.js";
import { buildTradingViewLink } from "../utils/tradingview.js";

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
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (r.ok) {
      const j = await r.json();
      if (j[id]?.usd) return Number(j[id].usd);
    }
  } catch {}

  return null;
}

async function fetch1m(symbol) {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=3`
    );
    if (!r.ok) return { price: await fetchFallbackPrice(symbol), changePct: 0, volSpike: 1 };

    const data = await r.json();
    if (!Array.isArray(data) || data.length < 2)
      return { price: await fetchFallbackPrice(symbol), changePct: 0, volSpike: 1 };

    const last = data[data.length - 1];
    const prev = data[data.length - 2];

    const lastClose = Number(last[4]);
    const prevClose = Number(prev[4]);
    const lastVol   = Number(last[5]);
    const prevVol   = Number(prev[5]);

    let finalPrice = Number.isFinite(lastClose) ? lastClose : await fetchFallbackPrice(symbol);

    const changePct = (lastClose - prevClose) / prevClose * 100;
    const volSpike  = prevVol > 0 ? lastVol / prevVol : 1;

    return { price: finalPrice, changePct, volSpike };
  } catch {
    return { price: await fetchFallbackPrice(symbol), changePct: 0, volSpike: 1 };
  }
}

async function fetchCoinglass(symbol, price) {
  const key = process.env.COINGLASS_API;
  if (!key) return { cgScore:0.5,nearestLong:null,nearestShort:null,funding:null,oi:null,ratio:null };

  const base = symbol.replace("USDT","");
  let nearestLong=null, nearestShort=null;
  let cgScore=0.5, funding=null, oi=null, ratio=null;

  try {
    const r = await fetch(
      `https://open-api.coinglass.com/public/v2/liquidationMap?symbol=${base}`,
      { headers: { coinglassSecret: key } }
    );
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.data)) {
        let best=0;
        for (const lvl of j.data) {
          const lp = Number(lvl.price), val = Number(lvl.value);
          const distPct = Math.abs(lp-price)/price*100;
          const side = (lvl.side||"").toLowerCase();

          if (side==="long") {
            if (!nearestLong || distPct < nearestLong.distPct || val > nearestLong.value)
              nearestLong = { price:lp,value:val,distPct };
          } else if (side==="short") {
            if (!nearestShort|| distPct < nearestShort.distPct|| val > nearestShort.value)
              nearestShort = { price:lp,value:val,distPct };
          }

          if (distPct < 2) best = Math.max(best, val/1_000_000);
        }
        cgScore = Math.min(1,best||0.5);
      }
    }
  } catch {}

  return { cgScore, nearestLong, nearestShort, funding, oi, ratio };
}

export default async function handler(req,res) {
  const pairs = await getActivePairs();
  const now = new Date();
  const infos = [];

  for (const symbol of pairs) {
    const { price,changePct,volSpike } = await fetch1m(symbol);
    if (!Number.isFinite(price)) continue;

    const cg = await fetchCoinglass(symbol,price);
    const score = cg.cgScore;

    const signal = buildSignal({ symbol,price,score,volSpike });

    infos.push({ symbol,price,changePct,volSpike,signal,nearestLong:cg.nearestLong,nearestShort:cg.nearestShort });
  }

  for (const info of infos) {
    if (!info.signal) continue;
    await sendTelegramMessage(
      `💎 <b>PRO SIGNAL</b>
<b>${info.symbol}</b>
Side: <b>${info.signal.side}</b>
Entry: ${info.signal.entry}
TP1: ${info.signal.tp1}
TP2: ${info.signal.tp2}
SL: ${info.signal.sl}`
    );
  }

  return res.json({ ok:true, count:infos.length });
}
