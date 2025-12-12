export const config = { runtime: "nodejs" };

import { getActivePairs } from "../utils/pairsStore.js";
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

function fmtNotional(v) {
  if (!Number.isFinite(v)) return "N/A";
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + "B";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(2) + "K";
  return v.toFixed(0);
}

function pickEntryByLiquidity(direction, price, liq) {
  if (direction === "LONG") {
    if (liq?.nearestBid && liq.nearestBid.dist <= 0.4) return liq.nearestBid.price * 1.0005;
    if (liq?.topLong?.[0] && liq.topLong[0].dist <= 1.0) return liq.topLong[0].price * 1.0005;
    return price;
  }
  if (direction === "SHORT") {
    if (liq?.nearestAsk && liq.nearestAsk.dist <= 0.4) return liq.nearestAsk.price * 0.9995;
    if (liq?.topShort?.[0] && liq.topShort[0].dist <= 1.0) return liq.topShort[0].price * 0.9995;
    return price;
  }
  return price;
}

function getMMTarget({ funding, lsr, liq }) {
  let longCrowded = false;
  let shortCrowded = false;

  if (typeof funding === "number") {
    if (funding > 0.0003) longCrowded = true;
    if (funding < -0.0003) shortCrowded = true;
  }
  if (lsr?.ratio) {
    if (lsr.ratio >= 1.15) longCrowded = true;
    if (lsr.ratio <= 0.87) shortCrowded = true;
  }

  if (longCrowded && !shortCrowded) return "LONGS";
  if (shortCrowded && !longCrowded) return "SHORTS";

  const longPool = (liq?.topLong?.[0]?.value || 0) + (liq?.topLong?.[1]?.value || 0);
  const shortPool = (liq?.topShort?.[0]?.value || 0) + (liq?.topShort?.[1]?.value || 0);

  if (longPool > shortPool * 1.2) return "LONGS";
  if (shortPool > longPool * 1.2) return "SHORTS";
  return "UNCLEAR";
}

function buildPositionLevels(direction, price, liq) {
  const entry = pickEntryByLiquidity(direction, price, liq);

  if (direction === "SHORT") {
    const tp1 = liq?.topLong?.[0]?.price ?? null;
    const tp2 = liq?.topLong?.[1]?.price ?? null;
    const sl  = liq?.topShort?.[0]?.price ?? (liq?.nearestAsk?.price ?? null);
    return { entry, tp1, tp2, sl };
  }

  if (direction === "LONG") {
    const tp1 = liq?.topShort?.[0]?.price ?? null;
    const tp2 = liq?.topShort?.[1]?.price ?? null;
    const sl  = liq?.topLong?.[0]?.price ?? (liq?.nearestBid?.price ?? null);
    return { entry, tp1, tp2, sl };
  }

  return { entry, tp1: null, tp2: null, sl: null };
}

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
  return null;
}

async function fetchBinance1m(symbol) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=3`);
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
    const lastVol = Number(last[5]);
    const prevVol = Number(prev[5]);

    let price = Number.isFinite(lastClose) ? lastClose : await fetchFallbackPrice(symbol);
    if (!Number.isFinite(price) || !Number.isFinite(prevClose) || prevClose === 0) {
      const fp = await fetchFallbackPrice(symbol);
      return { price: fp, changePct: 0, volSpike: 1 };
    }

    const changePct = (price - prevClose) / prevClose * 100;
    const volSpike = prevVol > 0 ? lastVol / prevVol : 1;
    return { price, changePct, volSpike };
  } catch (e) {
    console.error("Binance 1m error", symbol, e);
    const fp = await fetchFallbackPrice(symbol);
    return { price: fp, changePct: 0, volSpike: 1 };
  }
}

function buildPositionDirection(info) {
  const { mm, oiInterp, lsr, funding, whales, manip, pumpDump } = info;

  let scoreLong = mm.scoreLong ?? 0;
  let scoreShort = mm.scoreShort ?? 0;

  if (oiInterp.bias > 0.05) scoreLong += 0.2;
  if (oiInterp.bias < -0.05) scoreShort += 0.2;

  if (lsr?.ratio) {
    if (lsr.ratio > 1.1) scoreLong += 0.2;
    if (lsr.ratio < 0.9) scoreShort += 0.2;
  }

  if (typeof funding === "number" && funding > 0.0007) scoreShort += 0.2;
  if (typeof funding === "number" && funding < -0.0007) scoreLong += 0.2;

  if (whales.side === "BUY") scoreLong += 0.3;
  if (whales.side === "SELL") scoreShort += 0.3;

  if (pumpDump.label === "PUMP") scoreLong += 0.2;
  if (pumpDump.label === "DUMP") scoreShort += 0.2;

  let direction = "AVOID";
  if (scoreLong > scoreShort * 1.1 && scoreLong > 0.5) direction = "LONG";
  else if (scoreShort > scoreLong * 1.1 && scoreShort > 0.5) direction = "SHORT";

  if (manip.manipulationScore > 0.7) direction = "AVOID";

  let rawConf = Math.max(scoreLong, scoreShort);
  rawConf += Math.abs(oiInterp.bias) * 0.5;
  if (lsr?.ratio) rawConf += Math.abs(lsr.ratio - 1) * 0.3;
  rawConf = Math.min(rawConf, 2.5);

  let confidence = Math.round(50 + (rawConf / 2.5) * 49);
  if (direction === "AVOID") confidence = Math.min(confidence, 70);

  const reasons = [];
  if (direction === "LONG") reasons.push("Ağırlıklar long yönünü destekliyor");
  if (direction === "SHORT") reasons.push("Ağırlıklar short yönünü destekliyor");
  if (direction === "AVOID") reasons.push("Manipülasyon / kararsız yapı nedeniyle pozisyon kaçınma öneriliyor");

  if (oiInterp.notes?.length) reasons.push(...oiInterp.notes);
  if (pumpDump.notes?.length) reasons.push(...pumpDump.notes);
  if (manip.notes?.length) reasons.push(...manip.notes);

  return { direction, confidence, reasons };
}

async function analyzeSymbol(symbol) {
  const { price, changePct, volSpike } = await fetchBinance1m(symbol);
  if (!Number.isFinite(price)) return null;

  const [funding, oiNow, liq, whales, arb, manip] = await Promise.all([
    getFunding(symbol),
    getOI(symbol),
    getLiquidityMap(symbol, price),
    detectWhales(symbol),
    detectArbitrage(symbol),
    detectManipulation(symbol)
  ]);

  const pumpDump = detectPumpDump({ changePct, volSpike });

  const oiInterp = interpretOiFunding({
    oiNow,
    oiPrev: oiNow,
    priceChange: changePct,
    funding
  });

  const lsr = await getAdvancedLSR(symbol, { funding, oiBias: oiInterp.bias, whales });

  const mm = computeMMYON({
    liqScore: liq.score,
    oiBias: oiInterp.bias,
    whaleSide: whales.side,
    pumpDumpLabel: pumpDump.label,
    manipScore: manip.manipulationScore,
    arbSide: arb.side
  });

  return { symbol, price, changePct, volSpike, funding, oiNow, lsr, liq, whales, arb, manip, pumpDump, oiInterp, mm };
}

function renderLiquidityZones(liq) {
  const lines = [];
  const long1 = liq?.topLong?.[0];
  const long2 = liq?.topLong?.[1];
  const short1 = liq?.topShort?.[0];
  const short2 = liq?.topShort?.[1];

  if (long1) lines.push(`• Nearest LONG: ${long1.price.toFixed(2)} | ${fmtNotional(long1.value)} | ${long1.dist.toFixed(2)}%`);
  if (long2) lines.push(`• Next LONG: ${long2.price.toFixed(2)} | ${fmtNotional(long2.value)} | ${long2.dist.toFixed(2)}%`);
  if (short1) lines.push(`• Nearest SHORT: ${short1.price.toFixed(2)} | ${fmtNotional(short1.value)} | ${short1.dist.toFixed(2)}%`);
  if (short2) lines.push(`• Next SHORT: ${short2.price.toFixed(2)} | ${fmtNotional(short2.value)} | ${short2.dist.toFixed(2)}%`);

  return lines.length ? lines.join("\n") : "N/A";
}

function renderLevels(levels) {
  const f = (x) => (x == null || !Number.isFinite(x)) ? "N/A" : Number(x).toFixed(2);
  return `Entry: <b>${f(levels.entry)}</b>\nTP1: <b>${f(levels.tp1)}</b>\nTP2: <b>${f(levels.tp2)}</b>\nSL: <b>${f(levels.sl)}</b>`;
}

export default async function handler(req, res) {
  try {
    if (req.method === "POST" && req.body?.message) {
      const msg = req.body.message;
      const chatId = msg.chat.id;
      const textRaw = (msg.text || "").trim();
      const text = textRaw.toLowerCase();

      if (text === "/pairs") {
        await sendTelegramMessage("📊 Aktif Pariteler:\n• BTCUSDT\n• AVAXUSDT", chatId);
        return res.json({ ok: true });
      }

      const cmd =
        text === "/btc" || text.startsWith("/btc@") ? "BTCUSDT" :
        text === "/avax" || text.startsWith("/avax@") ? "AVAXUSDT" :
        text === "/dir" || text.startsWith("/dir@") ? "DIR" :
        null;

      if (cmd === "DIR") {
        const [btc, avax] = await Promise.all([analyzeSymbol("BTCUSDT"), analyzeSymbol("AVAXUSDT")]);
        let out = "<b>Pozisyon Yön Özeti</b>\n\n";
        if (btc) {
          const pos = buildPositionDirection(btc);
          out += `<b>BTCUSDT</b> — <b>${pos.direction}</b> (${pos.confidence}%) | MMYON: ${btc.mm.mmDir}\n`;
        }
        if (avax) {
          const pos = buildPositionDirection(avax);
          out += `<b>AVAXUSDT</b> — <b>${pos.direction}</b> (${pos.confidence}%) | MMYON: ${avax.mm.mmDir}\n`;
        }
        await sendTelegramMessage(out.trim(), chatId);
        return res.json({ ok: true });
      }

      if (cmd) {
        const info = await analyzeSymbol(cmd);
        if (!info) {
          await sendTelegramMessage(`${cmd} analizi alınamadı.`, chatId);
          return res.json({ ok: true });
        }

        const pos = buildPositionDirection(info);
        const mmTarget = getMMTarget({ funding: info.funding, lsr: info.lsr, liq: info.liq });
        const levels = buildPositionLevels(pos.direction, info.price, info.liq);

        const msgText = `
<b>${cmd} Pozisyon Analizi</b>

Yön: <b>${pos.direction}</b>
Confidence: <b>${pos.confidence}%</b>
MMYON: <b>${info.mm.mmDir}</b>

Market Maker Target:
Likely to liquidate: <b>${mmTarget}</b>

${renderLevels(levels)}

Liquidity Zones:
${renderLiquidityZones(info.liq)}

Fiyat: ${info.price.toFixed(2)} (${info.changePct.toFixed(2)}% 1m)
Funding: ${info.funding != null ? info.funding.toFixed(5) : "N/A"}
OI: ${info.oiNow != null ? info.oiNow.toFixed(0) : "N/A"}
Long/Short: ${info.lsr ? info.lsr.ratio.toFixed(2) + " (" + info.lsr.source + ")" : "N/A"}
Manip Score: ${info.manip.manipulationScore.toFixed(2)}

Özet:
${pos.reasons.length ? pos.reasons.map(r => "• " + r).join("\n") : "N/A"}

TradingView:
${buildTradingViewLink(cmd)}
        `.trim();

        await sendTelegramMessage(msgText, chatId);
        return res.json({ ok: true });
      }

      await sendTelegramMessage("Komutlar:\n/pairs\n/btc\n/avax\n/dir", chatId);
      return res.json({ ok: true });
    }

    const pairs = await getActivePairs();
    const infos = [];
    for (const symbol of pairs) {
      const info = await analyzeSymbol(symbol);
      if (info) infos.push(info);
    }

    if (!infos.length) {
      await sendTelegramMessage("⚠️ Fiyat verisi alınamadı, Binance/MEXC erişimini kontrol et.");
      return res.status(200).json({ ok: true, count: 0 });
    }

    let snap = "📍 <b>Nearest Liquidity Snapshot</b>\n\n";
    for (const x of infos) {
      snap += `<b>${x.symbol}</b> — ${x.price.toFixed(2)}\n`;
      if (x.liq.nearestBid) snap += `• Bid: ${x.liq.nearestBid.price.toFixed(2)} (${x.liq.nearestBid.dist.toFixed(2)}%)\n`;
      if (x.liq.nearestAsk) snap += `• Ask: ${x.liq.nearestAsk.price.toFixed(2)} (${x.liq.nearestAsk.dist.toFixed(2)}%)\n`;
      snap += "\n";
    }
    await sendTelegramMessage(snap);

    let sum = "⏱ <b>1m Price & MMYON</b>\n\n";
    for (const x of infos) {
      sum += `<b>${x.symbol}</b> ${x.price.toFixed(2)} (${x.changePct.toFixed(2)}%) — MMYON: ${x.mm.mmDir}\n`;
    }
    await sendTelegramMessage(sum);

    return res.status(200).json({ ok: true, count: infos.length });
  } catch (e) {
    console.error("signal handler error", e);
    return res.status(500).json({ error: e.toString() });
  }
}

import { getCoinglassMMHeatmap, buildMMPlan, majorityMM } from "../utils/mmHeatmap.js";

// ...
if (text.startsWith("/mm")) {
  const parts = textRaw.split(" ").filter(Boolean);
  const coin = parts[1] || "BTC";
  const baseSymbol = coin.toUpperCase().endsWith("USDT") ? coin.toUpperCase() : coin.toUpperCase() + "USDT";

  // fiyatı senin mevcut fiyat fonksiyonundan al (binance 1m kapanış)
  const info = await analyzeSymbol(baseSymbol);
  if (!info) {
    await sendTelegramMessage(`${baseSymbol} için fiyat alınamadı`, chatId);
    return res.json({ ok: true });
  }

  const price = info.price;

  const tfs = ["1h","12h","24h"];
  const results = [];
  for (const tf of tfs) {
    const cg = await getCoinglassMMHeatmap({ baseSymbol, price, tf });
    if (cg) results.push(cg);
  }

  if (!results.length) {
    await sendTelegramMessage(`${baseSymbol} heatmap verisi alınamadı (COINGLASS_API kontrol et)`, chatId);
    return res.json({ ok: true });
  }

  const maj = majorityMM(results);
  const bestTf = results.find(x => x.tf === "1h") || results[0];

  const plan = buildMMPlan({
    price,
    mmTarget: maj.final,
    nearestLong: bestTf.nearestLong,
    nearestShort: bestTf.nearestShort,
    symbol: baseSymbol
  });

  const fmt = (x) => x == null ? "N/A" : Number(x).toFixed(2);

  let out = `<b>${baseSymbol} MM Heatmap</b>\n\n`;
  out += `MM Target: <b>${maj.final}</b>\n`;
  out += `Confidence: <b>${maj.conf}%</b>\n\n`;
  out += `Yön: <b>${plan.side}</b>\n`;
  out += `Entry: <b>${fmt(plan.entry)}</b>\nTP1: <b>${fmt(plan.tp1)}</b>\nTP2: <b>${fmt(plan.tp2)}</b>\nSL: <b>${fmt(plan.sl)}</b>\n\n`;

  for (const r of results) {
    out += `<b>${r.tf}</b> — Target: ${r.mmTarget}\n`;
    out += `Nearest Long: ${r.nearestLong ? fmt(r.nearestLong.price) + " (" + r.nearestLong.distPct.toFixed(2) + "%)" : "N/A"}\n`;
    out += `Nearest Short: ${r.nearestShort ? fmt(r.nearestShort.price) + " (" + r.nearestShort.distPct.toFixed(2) + "%)" : "N/A"}\n\n`;
  }

  await sendTelegramMessage(out.trim(), chatId);
  return res.json({ ok: true });
}
