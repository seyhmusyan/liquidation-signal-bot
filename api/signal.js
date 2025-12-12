export const config = { runtime: "nodejs" };

import { sendTelegramMessage } from "../utils/telegram.js";
import { buildTradingViewLink } from "../utils/tradingview.js";

import { getFunding, getOI } from "../utils/futures.js";
import { getLiquidityMap } from "../utils/liquidity.js";
import { detectWhales } from "../utils/whale.js";
import { detectArbitrage } from "../utils/arbitrage.js";
import { detectManipulation } from "../utils/manipulation.js";
import { interpretOiFunding } from "../utils/oi_funding.js";
import { computeMMYON } from "../utils/mmbrain.js";
import { getAdvancedLSR } from "../utils/lsr.js";

import {
  getCoinglassMMHeatmap,
  buildMMPlan,
  resolveMMTargetWithFallback
} from "../utils/mmHeatmap.js";

import { getState, setState, makeKey } from "../utils/proState.js";

const f2 = (x) => (x == null || !Number.isFinite(x)) ? "N/A" : Number(x).toFixed(2);

async function fetch1mPack(symbol, limit = 30) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}`);
    if (!r.ok) return null;
    const k = await r.json();
    if (!Array.isArray(k) || k.length < 5) return null;
    return k;
  } catch {
    return null;
  }
}

function calcWickRisk(klines) {
  // Fake breakout / wick heuristic
  // Son mumun wick oranına bakıyoruz (uzun üst wick => fake pump riski, uzun alt wick => fake dump riski)
  const last = klines[klines.length - 1];
  const o = Number(last[1]);
  const h = Number(last[2]);
  const l = Number(last[3]);
  const c = Number(last[4]);

  if (![o, h, l, c].every(Number.isFinite)) return { risk: "N/A", notes: [] };

  const body = Math.abs(c - o);
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  const notes = [];
  let score = 0;

  const denom = Math.max(body, 0.0000001);

  if (upperWick / denom >= 2.5 && upperWick > lowerWick * 1.3) {
    notes.push("Üst wick çok uzun: fake pump (stop hunt) ihtimali");
    score += 1;
  }
  if (lowerWick / denom >= 2.5 && lowerWick > upperWick * 1.3) {
    notes.push("Alt wick çok uzun: fake dump (stop hunt) ihtimali");
    score += 1;
  }

  if (body === 0 && (upperWick > 0 || lowerWick > 0)) {
    notes.push("Doji + wick: belirsizlik ve av ihtimali");
    score += 0.5;
  }

  const risk =
    score >= 1 ? "HIGH" :
    score >= 0.5 ? "MED" :
    "LOW";

  return { risk, notes };
}

function detectTP1Hit(prevPrice, curPrice, plan) {
  if (!plan?.tp1 || !Number.isFinite(plan.tp1)) return false;
  if (!Number.isFinite(prevPrice) || !Number.isFinite(curPrice)) return false;

  // LONG: fiyat tp1 üstüne geçerse
  if (plan.side === "LONG") return prevPrice < plan.tp1 && curPrice >= plan.tp1;

  // SHORT: fiyat tp1 altına inerse
  if (plan.side === "SHORT") return prevPrice > plan.tp1 && curPrice <= plan.tp1;

  return false;
}

function fundingFlip(prevFunding, curFunding) {
  if (prevFunding == null || curFunding == null) return false;
  if (!Number.isFinite(prevFunding) || !Number.isFinite(curFunding)) return false;
  return (prevFunding >= 0 && curFunding < 0) || (prevFunding <= 0 && curFunding > 0);
}

function buildProSignalText({ symbol, price, mmTarget, conf, plan, info, wick }) {
  const tv = buildTradingViewLink(symbol);

  let out = `💎 <b>PRO SIGNAL</b>\n`;
  out += `<b>${symbol}</b>\n\n`;
  out += `MM Target: <b>${mmTarget}</b>\n`;
  out += `Confidence: <b>${conf}%</b>\n`;
  out += `MMYON: <b>${info.mm.mmDir}</b>\n\n`;

  out += `Yön: <b>${plan.side}</b>\n`;
  out += `Entry: <b>${f2(plan.entry)}</b>\n`;
  out += `TP1: <b>${f2(plan.tp1)}</b>\n`;
  out += `TP2: <b>${f2(plan.tp2)}</b>\n`;
  out += `SL: <b>${f2(plan.sl)}</b>\n\n`;

  out += `Funding: ${info.funding != null ? info.funding.toFixed(5) : "N/A"}\n`;
  out += `OI: ${info.oiNow != null ? info.oiNow.toFixed(0) : "N/A"}\n`;
  out += `Long/Short: ${info.lsr ? info.lsr.ratio.toFixed(2) + " (" + info.lsr.source + ")" : "N/A"}\n`;
  out += `Manip Score: ${info.manip.manipulationScore.toFixed(2)}\n`;
  out += `Wick Risk: ${wick?.risk || "N/A"}\n\n`;

  if (wick?.notes?.length) {
    out += `Notlar:\n`;
    out += wick.notes.map(x => `• ${x}`).join("\n") + "\n\n";
  }

  out += `TradingView:\n${tv}`;
  return out.trim();
}

async function analyzeSymbol(symbol) {
  const kl = await fetch1mPack(symbol, 30);
  if (!kl) return null;

  const last = kl[kl.length - 1];
  const price = Number(last[4]);
  if (!Number.isFinite(price)) return null;

  const [funding, oiNow, liq, whales, arb, manip] = await Promise.all([
    getFunding(symbol),
    getOI(symbol),
    getLiquidityMap(symbol, price),
    detectWhales(symbol),
    detectArbitrage(symbol),
    detectManipulation(symbol)
  ]);

  const wick = calcWickRisk(kl);

  const oiInterp = interpretOiFunding({
    oiNow,
    oiPrev: oiNow,
    priceChange: 0,
    funding
  });

  const lsr = await getAdvancedLSR(symbol, {
    funding,
    oiBias: oiInterp.bias,
    whales
  });

  const mm = computeMMYON({
    liqScore: liq?.score ?? 0,
    oiBias: oiInterp.bias,
    whaleSide: whales.side,
    pumpDumpLabel: null,
    manipScore: manip.manipulationScore,
    arbSide: arb.side
  });

  return {
    symbol,
    price,
    funding,
    oiNow,
    lsr,
    liq,
    whales,
    arb,
    manip,
    oiInterp,
    mm,
    wick
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST" || !req.body?.message) {
      return res.json({ ok: true });
    }

    const msg = req.body.message;
    const chatId = msg.chat.id;
    const textRaw = (msg.text || "").trim();
    const text = textRaw.toLowerCase();

    if (text === "/pairs") {
      await sendTelegramMessage(
        "Komutlar:\n/mm BTC\n/mm AVAX\n/mm SOL\n/mm ETH\n\nHerhangi bir USDT paritesi yazabilirsin.",
        chatId
      );
      return res.json({ ok: true });
    }

    if (text.startsWith("/mm")) {
      const coin = textRaw.split(" ")[1] || "BTC";
      const symbol = coin.toUpperCase().endsWith("USDT")
        ? coin.toUpperCase()
        : coin.toUpperCase() + "USDT";

      const info = await analyzeSymbol(symbol);
      if (!info) {
        await sendTelegramMessage(`${symbol} için veri alınamadı`, chatId);
        return res.json({ ok: true });
      }

      const price = info.price;

      // Heatmap timeframes
      const tfs = ["1h", "12h", "24h"];
      const results = [];
      for (const tf of tfs) {
        const r = await getCoinglassMMHeatmap({ baseSymbol: symbol, price, tf });
        if (r) results.push(r);
      }

      // Fallback engine: Funding > LSR > OI
      const mm = resolveMMTargetWithFallback(results, {
        funding: info.funding,
        lsr: info.lsr?.ratio,
        oiBias: info.oiInterp?.bias
      });

      const base = results[0] || {};
      const plan = buildMMPlan({
        price,
        mmTarget: mm.target,
        nearestLong: base.nearestLong,
        nearestShort: base.nearestShort,
        symbol
      });

      // ===== Alerts: funding flip + tp1 hit -> SL BE (best effort cache) =====
      const key = makeKey(symbol);
      const prev = getState(key) || {};
      const prevPrice = prev.price;
      const prevFunding = prev.funding;

      const flip = fundingFlip(prevFunding, info.funding);
      const tp1Hit = detectTP1Hit(prevPrice, price, plan);

      setState(key, {
        price,
        funding: info.funding,
        lastPlan: { side: plan.side, entry: plan.entry, tp1: plan.tp1, tp2: plan.tp2, sl: plan.sl },
        ts: Date.now()
      });

      // Fake breakout: wick risk high => alarm
      const wick = info.wick;

      // ===== Main /mm message =====
      let out = `<b>${symbol} MM Heatmap</b>\n\n`;
      out += `MM Target: <b>${mm.target}</b>\n`;
      out += `Confidence: <b>${mm.conf}%</b>\n`;
      out += `MMYON: <b>${info.mm.mmDir}</b>\n\n`;

      out += `Yön: <b>${plan.side}</b>\n`;
      out += `Entry: <b>${f2(plan.entry)}</b>\n`;
      out += `TP1: <b>${f2(plan.tp1)}</b>\n`;
      out += `TP2: <b>${f2(plan.tp2)}</b>\n`;
      out += `SL: <b>${f2(plan.sl)}</b>\n\n`;

      out += `Funding: ${info.funding != null ? info.funding.toFixed(5) : "N/A"}\n`;
      out += `OI: ${info.oiNow != null ? info.oiNow.toFixed(0) : "N/A"}\n`;
      out += `Long/Short: ${info.lsr ? info.lsr.ratio.toFixed(2) + " (" + info.lsr.source + ")" : "N/A"}\n`;
      out += `Manip Score: ${info.manip.manipulationScore.toFixed(2)}\n`;
      out += `Wick Risk: ${wick?.risk || "N/A"}\n\n`;

      if (results.length) {
        for (const r of results) out += `${r.tf} → ${r.mmTarget}\n`;
        out += `\n`;
      }

      // Alerts section
      const alerts = [];
      if (wick?.risk === "HIGH") alerts.push("FAKE BREAKOUT ALARM: wick riski yüksek");
      if (flip) alerts.push("FUNDING FLIP: funding işaret değiştirdi");
      if (tp1Hit) alerts.push("TP1 HIT: SL BE önerisi (stop entry seviyesine)");

      if (alerts.length) {
        out += `<b>ALERTS</b>\n`;
        out += alerts.map(a => `• ${a}`).join("\n") + "\n\n";
      }

      out += `TradingView:\n${buildTradingViewLink(symbol)}`;

      await sendTelegramMessage(out.trim(), chatId);

      // ===== Auto PRO SIGNAL if confidence >= 70 and direction not AVOID =====
      if (mm.conf >= 70 && plan.side !== "AVOID") {
        const proText = buildProSignalText({
          symbol,
          price,
          mmTarget: mm.target,
          conf: mm.conf,
          plan,
          info,
          wick
        });
        await sendTelegramMessage(proText, chatId);
      }

      return res.json({ ok: true });
    }

    await sendTelegramMessage("Komutlar:\n/pairs\n/mm BTC\n/mm AVAX\n/mm SOL\n/mm ETH", chatId);
    return res.json({ ok: true });

  } catch (e) {
    console.error("signal error", e);
    return res.status(500).json({ error: e.toString() });
  }
}
