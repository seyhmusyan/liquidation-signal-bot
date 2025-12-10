export const config = { runtime: "nodejs" };

import { getActivePairs, addPair, removePair, toCoinglassSymbol } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";
import { buildTradingViewLink } from "../utils/tradingview.js";
import { getFunding, getOI, getLongShort, getLiqMap } from "../utils/coinglass.js";

// -----------------------------
// FİYAT FALLBACK ENGINE
// -----------------------------
async function fetchFallbackPrice(symbol) {
  // 1) Binance ticker
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) {
      const j = await r.json();
      const p = Number(j.price);
      if (Number.isFinite(p)) return p;
    }
  } catch {}

  // 2) MEXC ticker
  try {
    const r = await fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`);
    if (r.ok) {
      const j = await r.json();
      const p = Number(j.price);
      if (Number.isFinite(p)) return p;
    }
  } catch {}

  // 3) Coingecko
  try {
    const id = symbol.replace("USDT", "").toLowerCase().replace("1000", "");
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

// -----------------------------
// Binance 1m + fallback
// -----------------------------
async function fetchBinance1m(symbol) {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=2`
    );

    if (!r.ok) {
      const fp = await fetchFallbackPrice(symbol);
      return { price: fp, changePct: 0 };
    }

    const data = await r.json();
    if (!Array.isArray(data) || data.length < 2) {
      const fp = await fetchFallbackPrice(symbol);
      return { price: fp, changePct: 0 };
    }

    const prev = Number(data[0][4]);
    const last = Number(data[1][4]);

    let price = last;
    if (!Number.isFinite(price)) price = await fetchFallbackPrice(symbol);

    if (!Number.isFinite(price) || !Number.isFinite(prev) || prev === 0) {
      const fp = await fetchFallbackPrice(symbol);
      return { price: fp, changePct: 0 };
    }

    const changePct = (price - prev) / prev * 100;
    return { price, changePct };
  } catch (e) {
    console.error("Binance 1m error", symbol, e);
    const fp = await fetchFallbackPrice(symbol);
    return { price: fp, changePct: 0 };
  }
}

// -----------------------------
// MEXC metrics
// -----------------------------
async function fetchMexcMetrics(symbol) {
  let mexOb = 0.5;
  let mexMom = 0.5;

  try {
    const d = await fetch(
      `https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=50`
    ).then(r => r.json());
    const bids = d.bids?.slice(0, 10).reduce((a, b) => a + Number(b[1]), 0) || 0;
    const asks = d.asks?.slice(0, 10).reduce((a, b) => a + Number(b[1]), 0) || 0;
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

// -----------------------------
// MM Brain
// -----------------------------
function computeMMBrain({ nearestLong, nearestShort, funding, longShort }) {
  let scoreLong = 0;
  let scoreShort = 0;
  const notes = [];

  if (nearestLong && nearestLong.dist < 2) {
    scoreShort += 1;
    notes.push("Yakın LONG liq (aşağı fitil riski)");
  }
  if (nearestShort && nearestShort.dist < 2) {
    scoreLong += 1;
    notes.push("Yakın SHORT liq (yukarı fitil riski)");
  }

  if (typeof funding === "number") {
    if (funding > 0) {
      scoreShort += 0.3;
      notes.push("Funding pozitif (long crowded)");
    } else if (funding < 0) {
      scoreLong += 0.3;
      notes.push("Funding negatif (short crowded)");
    }
  }

  if (typeof longShort === "number") {
    if (longShort > 1.2) {
      scoreShort += 0.5;
      notes.push("Long çoğunlukta (MM short tarafını destekleyebilir)");
    } else if (longShort < 0.8) {
      scoreLong += 0.5;
      notes.push("Short çoğunlukta (MM long tarafını destekleyebilir)");
    }
  }

  let mmDir = "AVOID";
  if (scoreLong > scoreShort * 1.2) mmDir = "LONG";
  else if (scoreShort > scoreLong * 1.2) mmDir = "SHORT";

  return { mmDir, scoreLong, scoreShort, notes };
}

// -----------------------------
// Combined score
// -----------------------------
function buildCombinedScore({ cgScore, mexOb, mexMom, mmDir }) {
  let base = cgScore ?? 0.5;
  base = base * 0.6 + (mexOb ?? 0.5) * 0.2 + (mexMom ?? 0.5) * 0.2;
  if (mmDir === "LONG") base += 0.05;
  if (mmDir === "SHORT") base -= 0.05;
  return Math.max(0, Math.min(1, base));
}

// -----------------------------
// Basit PRO signal
// -----------------------------
function buildSignal({ symbol, price, score }) {
  if (!Number.isFinite(price)) return null;
  const s = Math.max(0, Math.min(1, score || 0.5));
  const confidence = Math.round(40 + s * 60);
  if (confidence < 60) return null;

  const side = s >= 0.5 ? "LONG" : "SHORT";

  const tp1 = side === "LONG" ? price * 1.005 : price * 0.995;
  const tp2 = side === "LONG" ? price * 1.01 : price * 0.99;
  const sl  = side === "LONG" ? price * 0.99 : price * 1.01;

  return { symbol, side, entry: price, tp1, tp2, sl, confidence };
}

// -----------------------------
// MAIN HANDLER (Telegram + Analiz)
// -----------------------------
export default async function handler(req, res) {
  try {
    // TELEGRAM WEBHOOK KOMUTLARI
    if (req.method === "POST" && req.body?.message) {
      const msg = req.body.message;
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();

      if (text === "/pairs") {
        const pairs = await getActivePairs();
        await sendTelegramMessage(
          "📊 Aktif Pariteler:\n" + pairs.map(p => "• " + p).join("\n"),
          chatId
        );
        return res.json({ ok: true });
      }

      if (text.startsWith("/addpair")) {
        const symbol = (text.split(" ")[1] || "").toUpperCase();
        if (!symbol) {
          await sendTelegramMessage("Kullanım: /addpair BTCUSDT", chatId);
          return res.json({ ok: true });
        }
        const pairs = await addPair(symbol);
        await sendTelegramMessage(
          `✅ Eklendi: ${symbol}\nYeni Liste:\n` + pairs.join("\n"),
          chatId
        );
        return res.json({ ok: true });
      }

      if (text.startsWith("/rmpair")) {
        const symbol = (text.split(" ")[1] || "").toUpperCase();
        if (!symbol) {
          await sendTelegramMessage("Kullanım: /rmpair BTCUSDT", chatId);
          return res.json({ ok: true });
        }
        const pairs = await removePair(symbol);
        await sendTelegramMessage(
          `🗑 Silindi: ${symbol}\nYeni Liste:\n` + pairs.join("\n"),
          chatId
        );
        return res.json({ ok: true });
      }

      await sendTelegramMessage(
        "Komutlar:\n/pairs\n/addpair BTCUSDT\n/rmpair BTCUSDT",
        chatId
      );
      return res.json({ ok: true });
    }

    // ANALİZ (GET / cron)
    const pairs = await getActivePairs();
    const infos = [];

    for (const symbol of pairs) {
      const { price, changePct } = await fetchBinance1m(symbol);
      if (!Number.isFinite(price)) {
        console.log("Price missing for", symbol);
        continue;
      }

      const funding = await getFunding(symbol);
      const oi = await getOI(symbol);
      const longShort = await getLongShort(symbol);
      const liq = await getLiqMap(toCoinglassSymbol(symbol), price);
      const mex = await fetchMexcMetrics(symbol);

      const mmBrain = computeMMBrain({
        nearestLong: liq.nearestLong,
        nearestShort: liq.nearestShort,
        funding,
        longShort
      });

      const score = buildCombinedScore({
        cgScore: liq.score,
        mexOb: mex.mexOb,
        mexMom: mex.mexMom,
        mmDir: mmBrain.mmDir
      });

      const signal = buildSignal({ symbol, price, score });

      infos.push({
        symbol,
        price,
        changePct,
        funding,
        oi,
        longShort,
        liq,
        mex,
        mmBrain,
        score,
        signal
      });
    }

    // Hiç fiyat alamadıysa bile uygun log
    if (!infos.length) {
      await sendTelegramMessage("⚠️ Hiçbir pair için fiyat çekilemedi. Binance/MEXC/Coingecko erişimini kontrol et.");
      return res.status(200).json({ ok: true, count: 0 });
    }

    // Snapshot
    let snap = "📍 <b>Nearest Liquidity Snapshot</b>\n\n";
    for (const x of infos) {
      snap += `<b>${x.symbol}</b> — ${x.price.toFixed(2)}\n`;
      if (x.liq.nearestLong) {
        snap += `• Long: ${x.liq.nearestLong.price.toFixed(2)} (${x.liq.nearestLong.dist.toFixed(2)}%)\n`;
      }
      if (x.liq.nearestShort) {
        snap += `• Short: ${x.liq.nearestShort.price.toFixed(2)} (${x.liq.nearestShort.dist.toFixed(2)}%)\n`;
      }
      snap += "\n";
    }
    await sendTelegramMessage(snap);

    // Summary
    let sum = "⏱ <b>1m Price & MMYON</b>\n\n";
    for (const x of infos) {
      sum += `<b>${x.symbol}</b> ${x.price.toFixed(2)} (${x.changePct.toFixed(2)}%) — MMYON: ${x.mmBrain.mmDir}\n`;
    }
    await sendTelegramMessage(sum);

    // PRO sinyaller
    for (const x of infos) {
      if (!x.signal) continue;
      const s = x.signal;

      const notes = x.mmBrain.notes.length
        ? x.mmBrain.notes.map(n => "• " + n).join("\n")
        : "N/A";

      const msg = `
💎 <b>PRO SIGNAL</b>

<b>${x.symbol}</b>
MMYON: <b>${x.mmBrain.mmDir}</b>

Side: <b>${s.side}</b>
Entry: <b>${s.entry.toFixed(2)}</b>
TP1: <b>${s.tp1.toFixed(2)}</b>
TP2: <b>${s.tp2.toFixed(2)}</b>
SL: <b>${s.sl.toFixed(2)}</b>
Confidence: <b>${s.confidence}%</b>

Score: ${(x.score * 100).toFixed(0)}%
1m: ${x.changePct.toFixed(2)}%

Funding: ${x.funding != null ? x.funding.toFixed(4) : "N/A"}
OI: ${x.oi != null ? x.oi.toFixed(0) : "N/A"}
L/S: ${x.longShort != null ? x.longShort.toFixed(2) : "N/A"}

MM Notes:
${notes}

TradingView:
${buildTradingViewLink(x.symbol)}
      `.trim();

      await sendTelegramMessage(msg);
    }

    return res.status(200).json({ ok: true, count: infos.length });
  } catch (e) {
    console.error("signal handler error", e);
    return res.status(500).json({ error: e.toString() });
  }
}
