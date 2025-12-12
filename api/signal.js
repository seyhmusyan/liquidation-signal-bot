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

// ---------------- PRICE ENGINE ----------------

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

// ---------------- PRO SIGNAL ----------------

function buildSignal({ symbol, price, score }) {
  if (!Number.isFinite(price)) return null;
  const s = Math.max(0, Math.min(2, score || 0));
  const norm = Math.min(1, s / 1.5);
  const confidence = Math.round(50 + norm * 50);
  if (confidence < 70) return null;

  const side = norm >= 0.5 ? "LONG" : "SHORT";

  const tp1 = side === "LONG" ? price * 1.004 : price * 0.996;
  const tp2 = side === "LONG" ? price * 1.008 : price * 0.992;
  const sl  = side === "LONG" ? price * 0.992 : price * 1.008;

  return { symbol, side, entry: price, tp1, tp2, sl, confidence };
}

// ---------------- POSITION DIRECTION ENGINE ----------------

function buildPositionDirection(info) {
  const { symbol, price, mm, oiInterp, lsr, funding, whales, manip, pumpDump } = info;

  let dir = mm.mmDir; // LONG / SHORT / AVOID
  let scoreLong = mm.scoreLong ?? 0;
  let scoreShort = mm.scoreShort ?? 0;

  // OI bias ek ağırlık
  if (oiInterp.bias > 0.05) scoreLong += 0.2;
  if (oiInterp.bias < -0.05) scoreShort += 0.2;

  // Long/Short ratio >1.1 ise long baskın, <0.9 ise short baskın
  if (lsr && lsr.ratio) {
    if (lsr.ratio > 1.1) scoreLong += 0.2;
    if (lsr.ratio < 0.9) scoreShort += 0.2;
  }

  // Funding yüksek pozitif → short lehine
  if (typeof funding === "number" && funding > 0.0007) scoreShort += 0.2;
  if (typeof funding === "number" && funding < -0.0007) scoreLong += 0.2;

  // Whale tarafı
  if (whales.side === "BUY") scoreLong += 0.3;
  if (whales.side === "SELL") scoreShort += 0.3;

  // Pump/Dump etiketi
  if (pumpDump.label === "PUMP") scoreLong += 0.2;
  if (pumpDump.label === "DUMP") scoreShort += 0.2;

  // Manip yüksek ise pozisyon açmama yönünde
  let avoidBoost = 0;
  if (manip.manipulationScore > 0.7) {
    avoidBoost = 0.5;
  }

  let finalDir = "AVOID";
  if (scoreLong > scoreShort * 1.1 && scoreLong > 0.5) finalDir = "LONG";
  else if (scoreShort > scoreLong * 1.1 && scoreShort > 0.5) finalDir = "SHORT";

  if (avoidBoost > 0 && manip.manipulationScore > 0.7) {
    // manip çok yüksek → her zaman AVOID
    finalDir = "AVOID";
  }

  // Confidence hesapla
  let rawConf = Math.max(scoreLong, scoreShort);
  rawConf += Math.abs(oiInterp.bias) * 0.5;
  if (lsr && lsr.ratio) rawConf += Math.abs(lsr.ratio - 1) * 0.3;
  rawConf = Math.min(rawConf, 2.5);

  let confidence = Math.round(50 + (rawConf / 2.5) * 49); // 50–99
  if (finalDir === "AVOID") confidence = Math.min(confidence, 70);

  const reasons = [];

  if (finalDir === "LONG") reasons.push("Ağırlıklar long yönünü destekliyor");
  if (finalDir === "SHORT") reasons.push("Ağırlıklar short yönünü destekliyor");
  if (finalDir === "AVOID") reasons.push("Manipülasyon / kararsız yapı nedeniyle pozisyon kaçınma öneriliyor");

  if (oiInterp.notes?.length) reasons.push(...oiInterp.notes);
  if (pumpDump.notes?.length) reasons.push(...pumpDump.notes);
  if (manip.notes?.length) reasons.push(...manip.notes);

  return {
    symbol,
    direction: finalDir,
    confidence,
    reasons
  };
}

// ---------------- ORTAK ANALİZ FONKSİYONU ----------------

async function analyzeSymbol(symbol) {
  const { price, changePct, volSpike } = await fetchBinance1m(symbol);
  if (!Number.isFinite(price)) {
    console.log("Price missing for", symbol);
    return null;
  }

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

  const lsr = await getAdvancedLSR(symbol, {
    funding,
    oiBias: oiInterp.bias,
    whales
  });

  const mm = computeMMYON({
    liqScore: liq.score,
    oiBias: oiInterp.bias,
    whaleSide: whales.side,
    pumpDumpLabel: pumpDump.label,
    manipScore: manip.manipulationScore,
    arbSide: arb.side
  });

  const combinedScore = Math.max(mm.totalScore, pumpDump.pumpScore, pumpDump.dumpScore);
  const signal = buildSignal({ symbol, price, score: combinedScore });

  return {
    symbol,
    price,
    changePct,
    volSpike,
    funding,
    oiNow,
    lsr,
    liq,
    whales,
    arb,
    manip,
    pumpDump,
    oiInterp,
    mm,
    combinedScore,
    signal
  };
}

// ---------------- HANDLER ----------------

export default async function handler(req, res) {
  try {
    // TELEGRAM WEBHOOK / KOMUTLAR
    if (req.method === "POST" && req.body?.message) {
      const msg = req.body.message;
      const chatId = msg.chat.id;
      const textRaw = (msg.text || "").trim();
      const text = textRaw.toLowerCase();

      if (text === "/pairs") {
        await sendTelegramMessage("📊 Aktif Pariteler:\n• BTCUSDT\n• AVAXUSDT", chatId);
        return res.json({ ok: true });
      }

      if (text === "/btc" || text.startsWith("/btc@")) {
        const info = await analyzeSymbol("BTCUSDT");
        if (!info) {
          await sendTelegramMessage("BTC analizi alınamadı.", chatId);
          return res.json({ ok: true });
        }
        const pos = buildPositionDirection(info);

        const msgText = `
<b>BTCUSDT Pozisyon Yönü</b>

Yön: <b>${pos.direction}</b>
Confidence: <b>${pos.confidence}%</b>
MMYON: <b>${info.mm.mmDir}</b>

Fiyat: ${info.price.toFixed(2)} (${info.changePct.toFixed(2)}% 1m)
Funding: ${info.funding != null ? info.funding.toFixed(5) : "N/A"}
OI: ${info.oiNow != null ? info.oiNow.toFixed(0) : "N/A"}
Long/Short: ${info.lsr ? info.lsr.ratio.toFixed(2) + " (" + info.lsr.source + ")" : "N/A"}
Manip Score: ${info.manip.manipulationScore.toFixed(2)}

Bid Cluster: ${info.liq.nearestLong ? info.liq.nearestLong.price.toFixed(2) + " (" + info.liq.nearestLong.dist.toFixed(2) + "%)" : "N/A"}
Ask Cluster: ${info.liq.nearestShort ? info.liq.nearestShort.price.toFixed(2) + " (" + info.liq.nearestShort.dist.toFixed(2) + "%)" : "N/A"}

Özet:
${pos.reasons.length ? pos.reasons.map(r => "• " + r).join("\n") : "N/A"}

TradingView:
${buildTradingViewLink("BTCUSDT")}
        `.trim();

        await sendTelegramMessage(msgText, chatId);
        return res.json({ ok: true });
      }

      if (text === "/avax" || text.startsWith("/avax@")) {
        const info = await analyzeSymbol("AVAXUSDT");
        if (!info) {
          await sendTelegramMessage("AVAX analizi alınamadı.", chatId);
          return res.json({ ok: true });
        }
        const pos = buildPositionDirection(info);

        const msgText = `
<b>AVAXUSDT Pozisyon Yönü</b>

Yön: <b>${pos.direction}</b>
Confidence: <b>${pos.confidence}%</b>
MMYON: <b>${info.mm.mmDir}</b>

Fiyat: ${info.price.toFixed(2)} (${info.changePct.toFixed(2)}% 1m)
Funding: ${info.funding != null ? info.funding.toFixed(5) : "N/A"}
OI: ${info.oiNow != null ? info.oiNow.toFixed(0) : "N/A"}
Long/Short: ${info.lsr ? info.lsr.ratio.toFixed(2) + " (" + info.lsr.source + ")" : "N/A"}
Manip Score: ${info.manip.manipulationScore.toFixed(2)}

Bid Cluster: ${info.liq.nearestLong ? info.liq.nearestLong.price.toFixed(2) + " (" + info.liq.nearestLong.dist.toFixed(2) + "%)" : "N/A"}
Ask Cluster: ${info.liq.nearestShort ? info.liq.nearestShort.price.toFixed(2) + " (" + info.liq.nearestShort.dist.toFixed(2) + "%)" : "N/A"}

Özet:
${pos.reasons.length ? pos.reasons.map(r => "• " + r).join("\n") : "N/A"}

TradingView:
${buildTradingViewLink("AVAXUSDT")}
        `.trim();

        await sendTelegramMessage(msgText, chatId);
        return res.json({ ok: true });
      }

      if (text === "/dir" || text.startsWith("/dir@")) {
        const [btcInfo, avaxInfo] = await Promise.all([
          analyzeSymbol("BTCUSDT"),
          analyzeSymbol("AVAXUSDT")
        ]);

        let out = "<b>Pozisyon Yön Özeti</b>\n\n";

        if (btcInfo) {
          const p = buildPositionDirection(btcInfo);
          out += `<b>BTCUSDT</b>\nYön: <b>${p.direction}</b> (${p.confidence}%)  |  MMYON: ${btcInfo.mm.mmDir}\n\n`;
        } else {
          out += "BTCUSDT analizi alınamadı.\n\n";
        }

        if (avaxInfo) {
          const p = buildPositionDirection(avaxInfo);
          out += `<b>AVAXUSDT</b>\nYön: <b>${p.direction}</b> (${p.confidence}%)  |  MMYON: ${avaxInfo.mm.mmDir}\n`;
        } else {
          out += "AVAXUSDT analizi alınamadı.\n";
        }

        await sendTelegramMessage(out.trim(), chatId);
        return res.json({ ok: true });
      }

      // default
      await sendTelegramMessage("Komutlar:\n/pairs\n/btc\n/avax\n/dir", chatId);
      return res.json({ ok: true });
    }

    // CRON / GET → periyodik tam analiz
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

    // Snapshot
    let snap = "📍 <b>Nearest Liquidity Snapshot</b>\n\n";
    for (const x of infos) {
      snap += `<b>${x.symbol}</b> — ${x.price.toFixed(2)}\n`;
      if (x.liq.nearestLong) {
        snap += `• Bid Cluster: ${x.liq.nearestLong.price.toFixed(2)} (${x.liq.nearestLong.dist.toFixed(2)}%)\n`;
      }
      if (x.liq.nearestShort) {
        snap += `• Ask Cluster: ${x.liq.nearestShort.price.toFixed(2)} (${x.liq.nearestShort.dist.toFixed(2)}%)\n`;
      }
      snap += "\n";
    }
    await sendTelegramMessage(snap);

    // MMYON summary
    let sum = "⏱ <b>1m Price & MMYON</b>\n\n";
    for (const x of infos) {
      sum += `<b>${x.symbol}</b> ${x.price.toFixed(2)} (${x.changePct.toFixed(2)}%) — MMYON: ${x.mm.mmDir}\n`;
    }
    await sendTelegramMessage(sum);

    // Detaylı Premium raporlar
    for (const x of infos) {
      const alerts = [];

      if (x.pumpDump.label === "PUMP") alerts.push("🔥 Pump Alert");
      if (x.pumpDump.label === "DUMP") alerts.push("⚠ Dump Alert");
      if (x.whales.whaleScore > 0) alerts.push("🐋 Whale Activity");
      if (x.manip.manipulationScore > 0.7) alerts.push("🎭 Manipulation Risk");
      if (Math.abs(x.arb.spreadPct) >= 0.15) alerts.push("🔁 Arbitrage Anomaly");

      const alertLine = alerts.length ? alerts.join(" | ") : "—";

      const notes = [
        ...x.pumpDump.notes,
        ...x.oiInterp.notes,
        ...x.mm.notes,
        ...x.manip.notes
      ].filter(Boolean);

      const notesText = notes.length ? notes.map(n => "• " + n).join("\n") : "N/A";

      const sig = x.signal;

      const msg = `
<b>${x.symbol}</b> Premium MM Raporu

Durum: ${alertLine}
MMYON: <b>${x.mm.mmDir}</b>

Fiyat: ${x.price.toFixed(2)} (${x.changePct.toFixed(2)}% 1m)
Funding: ${x.funding != null ? x.funding.toFixed(5) : "N/A"}
OI: ${x.oiNow != null ? x.oiNow.toFixed(0) : "N/A"}
Long/Short: ${x.lsr ? x.lsr.ratio.toFixed(2) + " (" + x.lsr.source + ")" : "N/A"}
Arb: ${x.arb.spreadPct.toFixed(3)}% (${x.arb.side || "N/A"})

Bid Cluster: ${x.liq.nearestLong ? x.liq.nearestLong.price.toFixed(2) + " (" + x.liq.nearestLong.dist.toFixed(2) + "%)" : "N/A"}
Ask Cluster: ${x.liq.nearestShort ? x.liq.nearestShort.price.toFixed(2) + " (" + x.liq.nearestShort.dist.toFixed(2) + "%)" : "N/A"}

Whale trades: ${x.whales.whaleScore}
Pump/Dump: ${x.pumpDump.label || "Yok"}
Manip Score: ${x.manip.manipulationScore.toFixed(2)}

Notlar:
${notesText}

TradingView:
${buildTradingViewLink(x.symbol)}

${sig ? `
<b>PRO SIGNAL</b>
Side: <b>${sig.side}</b>
Entry: <b>${sig.entry.toFixed(2)}</b>
TP1: <b>${sig.tp1.toFixed(2)}</b>
TP2: <b>${sig.tp2.toFixed(2)}</b>
SL: <b>${sig.sl.toFixed(2)}</b>
Confidence: <b>${sig.confidence}%</b>
`.trim() : ""}
      `.trim();

      await sendTelegramMessage(msg);
    }

    return res.status(200).json({ ok: true, count: infos.length });
  } catch (e) {
    console.error("signal handler error", e);
    return res.status(500).json({ error: e.toString() });
  }
}
