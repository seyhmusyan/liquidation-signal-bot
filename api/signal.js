export const config = { runtime: "nodejs" };

// ===== IMPORTS =====
import { sendTelegramMessage } from "../utils/telegram.js";
import { buildTradingViewLink } from "../utils/tradingview.js";

import { getFunding, getOI } from "../utils/futures.js";
import { getLiquidityMap } from "../utils/liquidity.js";
import { detectPumpDump } from "../utils/pumpdump.js";
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

// ===== HELPERS =====
const f = (x) => (x == null || !Number.isFinite(x)) ? "N/A" : Number(x).toFixed(2);

// ===== CORE ANALYSIS =====
async function analyzeSymbol(symbol) {
  const r = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=2`
  );
  if (!r.ok) return null;

  const k = await r.json();
  const price = Number(k[1][4]);
  if (!Number.isFinite(price)) return null;

  const [funding, oiNow, liq, whales, arb, manip] = await Promise.all([
    getFunding(symbol),
    getOI(symbol),
    getLiquidityMap(symbol, price),
    detectWhales(symbol),
    detectArbitrage(symbol),
    detectManipulation(symbol)
  ]);

  const pumpDump = detectPumpDump({ changePct: 0, volSpike: 1 });

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
    pumpDumpLabel: pumpDump.label,
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
    pumpDump,
    oiInterp,
    mm
  };
}

// ===== HANDLER =====
export default async function handler(req, res) {
  try {
    if (req.method !== "POST" || !req.body?.message) {
      return res.json({ ok: true });
    }

    const msg = req.body.message;
    const chatId = msg.chat.id;
    const textRaw = (msg.text || "").trim();
    const text = textRaw.toLowerCase();

    // ===== /pairs =====
    if (text === "/pairs") {
      await sendTelegramMessage(
        "📊 Komut Kullanımı:\n/mm BTC\n/mm AVAX\n/mm SOL\n/mm DOGE\n\nHerhangi bir USDT paritesi yazabilirsin.",
        chatId
      );
      return res.json({ ok: true });
    }

    // ===== /mm COIN =====
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
      const tfs = ["1h", "12h", "24h"];
      const results = [];

      for (const tf of tfs) {
        const r = await getCoinglassMMHeatmap({
          baseSymbol: symbol,
          price,
          tf
        });
        if (r) results.push(r);
      }

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

      let out = `<b>${symbol} MM Heatmap</b>\n\n`;
      out += `MM Target: <b>${mm.target}</b>\n`;
      out += `Confidence: <b>${mm.conf}%</b>\n`;
      out += `MMYON: <b>${info.mm.mmDir}</b>\n\n`;

      out += `Yön: <b>${plan.side}</b>\n`;
      out += `Entry: <b>${f(plan.entry)}</b>\n`;
      out += `TP1: <b>${f(plan.tp1)}</b>\n`;
      out += `TP2: <b>${f(plan.tp2)}</b>\n`;
      out += `SL: <b>${f(plan.sl)}</b>\n\n`;

      out += `Funding: ${info.funding != null ? info.funding.toFixed(5) : "N/A"}\n`;
      out += `OI: ${info.oiNow != null ? info.oiNow.toFixed(0) : "N/A"}\n`;
      out += `Long/Short: ${
        info.lsr ? info.lsr.ratio.toFixed(2) + " (" + info.lsr.source + ")" : "N/A"
      }\n`;
      out += `Manip Score: ${info.manip.manipulationScore.toFixed(2)}\n\n`;

      if (results.length) {
        for (const r of results) {
          out += `${r.tf} → ${r.mmTarget}\n`;
        }
      }

      out += `\nTradingView:\n${buildTradingViewLink(symbol)}`;

      await sendTelegramMessage(out.trim(), chatId);
      return res.json({ ok: true });
    }

    // ===== DEFAULT =====
    await sendTelegramMessage(
      "Komutlar:\n/mm BTC\n/mm AVAX\n/mm SOL\n/mm ETH\n/mm DOGE",
      chatId
    );
    return res.json({ ok: true });

  } catch (e) {
    console.error("signal error", e);
    return res.status(500).json({ error: e.toString() });
  }
}
