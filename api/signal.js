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
import { getMexcLikiditeOnayi } from "../utils/mexcDepth.js";

const sayi2 = (x) => (x == null || !Number.isFinite(x)) ? "Yok" : Number(x).toFixed(2);

async function fetchKlines(symbol, limit = 30) {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=${limit}`);
    if (!r.ok) return null;
    const k = await r.json();
    return Array.isArray(k) && k.length >= 5 ? k : null;
  } catch {
    return null;
  }
}

function wickRiskiHesapla(klines) {
  const last = klines[klines.length - 1];
  const o = Number(last[1]);
  const h = Number(last[2]);
  const l = Number(last[3]);
  const c = Number(last[4]);
  if (![o, h, l, c].every(Number.isFinite)) return { risk: "BILINMIYOR", notlar: [] };

  const body = Math.abs(c - o);
  const upper = h - Math.max(o, c);
  const lower = Math.min(o, c) - l;

  const notlar = [];
  let score = 0;
  const denom = Math.max(body, 0.0000001);

  if (upper / denom >= 2.5 && upper > lower * 1.3) {
    notlar.push("Üst fitil çok uzun, sahte yükseliş ve stop avı ihtimali");
    score += 1;
  }
  if (lower / denom >= 2.5 && lower > upper * 1.3) {
    notlar.push("Alt fitil çok uzun, sahte düşüş ve stop avı ihtimali");
    score += 1;
  }
  if (body === 0 && (upper > 0 || lower > 0)) {
    notlar.push("Doji ve fitil, kararsızlık ve av ihtimali");
    score += 0.5;
  }

  const risk = score >= 1 ? "YUKSEK" : score >= 0.5 ? "ORTA" : "DUSUK";
  return { risk, notlar };
}

function modBelirle(results, mmConf, wickRisk) {
  const t24 = results.find(x => x.tf === "24h")?.mmTarget;
  const t12 = results.find(x => x.tf === "12h")?.mmTarget;

  const swingOnayi = (t24 && t12 && t24 !== "UNCLEAR" && t24 === t12 && mmConf >= 66 && wickRisk !== "YUKSEK");
  return swingOnayi ? "SWING" : "SCALP";
}

function yuzdeBüyüklük(mmConf, wickRisk, manipSkor, mmYon) {
  let size = 100;

  if (mmConf < 60) size -= 25;
  else if (mmConf < 66) size -= 15;
  else if (mmConf < 75) size -= 5;

  if (wickRisk === "YUKSEK") size -= 40;
  if (wickRisk === "ORTA") size -= 20;

  if (manipSkor >= 0.7) size -= 30;
  else if (manipSkor >= 0.4) size -= 15;

  if (mmYon === "AVOID") size -= 20;

  if (size < 10) size = 10;
  if (size > 100) size = 100;
  return size;
}

function onayBekleGerekiyorMu(mmYon, wickRisk, mmConf) {
  if (mmYon === "AVOID") return true;
  if (wickRisk === "YUKSEK") return true;
  if (mmConf < 60) return true;
  return false;
}

function tp1GecildiMi(prevPrice, curPrice, plan) {
  if (!plan?.tp1 || !Number.isFinite(plan.tp1)) return false;
  if (!Number.isFinite(prevPrice) || !Number.isFinite(curPrice)) return false;

  if (plan.side === "LONG") return prevPrice < plan.tp1 && curPrice >= plan.tp1;
  if (plan.side === "SHORT") return prevPrice > plan.tp1 && curPrice <= plan.tp1;
  return false;
}

function fundingFlip(prevFunding, curFunding) {
  if (prevFunding == null || curFunding == null) return false;
  if (!Number.isFinite(prevFunding) || !Number.isFinite(curFunding)) return false;
  return (prevFunding >= 0 && curFunding < 0) || (prevFunding <= 0 && curFunding > 0);
}

function mexcOnayYaz(mexc, planSide) {
  if (!mexc?.var) return { ok: false, yazi: `MEXC Likidite Onayı: ${mexc?.durum || "Yok"}` };

  let uyum = "BELIRSIZ";
  if (planSide === "LONG" && mexc.yon === "ALIM_BASKISI") uyum = "UYUMLU";
  if (planSide === "SHORT" && mexc.yon === "SATIS_BASKISI") uyum = "UYUMLU";

  if (uyum === "BELIRSIZ") uyum = "KARSIT veya ZAYIF";

  const yazi =
    `MEXC Likidite Onayı: ${mexc.yon} | Oran: ${mexc.oran.toFixed(2)} | Durum: ${uyum}`;

  return { ok: uyum === "UYUMLU", yazi };
}

async function analyzeSymbol(symbol) {
  const kl = await fetchKlines(symbol, 30);
  if (!kl) return null;

  const last = kl[kl.length - 1];
  const price = Number(last[4]);
  if (!Number.isFinite(price)) return null;

  const [funding, oiNow, liq, whales, arb, manip, mexc] = await Promise.all([
    getFunding(symbol),
    getOI(symbol),
    getLiquidityMap(symbol, price),
    detectWhales(symbol),
    detectArbitrage(symbol),
    detectManipulation(symbol),
    getMexcLikiditeOnayi(symbol)
  ]);

  const wick = wickRiskiHesapla(kl);

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
    wick,
    mexc
  };
}

function proSinyalMetni({ symbol, mmTarget, conf, plan, info, mod, sizePct, onayBekle, mexcNote }) {
  let out = `💎 <b>PRO SİNYAL</b>\n`;
  out += `<b>${symbol}</b>\n\n`;

  out += `Market Maker Hedefi: <b>${mmTarget}</b>\n`;
  out += `Güven: <b>${conf}%</b>\n`;
  out += `Mod: <b>${mod}</b>\n`;
  out += `Pozisyon Büyüklüğü Önerisi: <b>%${sizePct}</b>\n`;
  out += `MMYON: <b>${info.mm.mmDir}</b>\n\n`;

  out += `Yön: <b>${plan.side}</b>\n`;
  out += `Giriş: <b>${sayi2(plan.entry)}</b>\n`;
  out += `TP1: <b>${sayi2(plan.tp1)}</b>\n`;
  out += `TP2: <b>${sayi2(plan.tp2)}</b>\n`;
  out += `SL: <b>${sayi2(plan.sl)}</b>\n\n`;

  out += `Funding: ${info.funding != null ? info.funding.toFixed(5) : "Yok"}\n`;
  out += `OI: ${info.oiNow != null ? info.oiNow.toFixed(0) : "Yok"}\n`;
  out += `Long Short Oranı: ${info.lsr ? info.lsr.ratio.toFixed(2) + " (" + info.lsr.source + ")" : "Yok"}\n`;
  out += `Manipülasyon Skoru: ${info.manip.manipulationScore.toFixed(2)}\n`;
  out += `Fitil Riski: ${info.wick?.risk || "BILINMIYOR"}\n`;
  out += `${mexcNote}\n`;

  if (onayBekle) {
    out += `\n<b>Onay Bekle</b>\n`;
    out += `• İşlem için 1m kapanış teyidi bekle\n`;
    out += `• Wick veya MMYON nedeniyle temkin öneriliyor\n`;
  }

  if (info.wick?.notlar?.length) {
    out += `\nNotlar\n`;
    out += info.wick.notlar.map(x => `• ${x}`).join("\n") + "\n";
  }

  out += `\nTradingView\n${buildTradingViewLink(symbol)}`;
  return out.trim();
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST" || !req.body?.message) return res.json({ ok: true });

    const msg = req.body.message;
    const chatId = msg.chat.id;
    const textRaw = (msg.text || "").trim();
    const text = textRaw.toLowerCase();

    if (text === "/pairs") {
      await sendTelegramMessage(
        "Komutlar\n/mm BTC\n/mm AVAX\n/mm SOL\n/mm ETH\n\nİstediğin herhangi bir USDT paritesini yazabilirsin",
        chatId
      );
      return res.json({ ok: true });
    }

    if (!text.startsWith("/mm")) {
      await sendTelegramMessage("Komutlar\n/pairs\n/mm BTC\n/mm AVAX\n/mm SOL\n/mm ETH", chatId);
      return res.json({ ok: true });
    }

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
      const r = await getCoinglassMMHeatmap({ baseSymbol: symbol, price, tf });
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

    const mod = modBelirle(results, mm.conf, info.wick?.risk || "BILINMIYOR");
    const sizePct = yuzdeBüyüklük(mm.conf, info.wick?.risk || "BILINMIYOR", info.manip.manipulationScore, info.mm.mmDir);
    const onayBekle = onayBekleGerekiyorMu(info.mm.mmDir, info.wick?.risk || "BILINMIYOR", mm.conf);

    const mexcEval = mexcOnayYaz(info.mexc, plan.side);
    const mexcNote = mexcEval.yazi;

    // Alert cache: funding flip ve TP1 geçildi
    const key = makeKey(symbol);
    const prev = getState(key) || {};
    const prevPrice = prev.price;
    const prevFunding = prev.funding;

    const flip = fundingFlip(prevFunding, info.funding);
    const tp1Hit = tp1GecildiMi(prevPrice, price, plan);

    setState(key, {
      price,
      funding: info.funding,
      lastPlan: { side: plan.side, entry: plan.entry, tp1: plan.tp1, tp2: plan.tp2, sl: plan.sl },
      ts: Date.now()
    });

    // Mesaj
    let out = `<b>${symbol} MM Heatmap</b>\n\n`;
    out += `Market Maker Hedefi: <b>${mm.target}</b>\n`;
    out += `Güven: <b>${mm.conf}%</b>\n`;
    out += `Mod: <b>${mod}</b>\n`;
    out += `Pozisyon Büyüklüğü Önerisi: <b>%${sizePct}</b>\n`;
    out += `MMYON: <b>${info.mm.mmDir}</b>\n\n`;

    out += `Yön: <b>${plan.side}</b>\n`;
    out += `Giriş: <b>${sayi2(plan.entry)}</b>\n`;
    out += `TP1: <b>${sayi2(plan.tp1)}</b>\n`;
    out += `TP2: <b>${sayi2(plan.tp2)}</b>\n`;
    out += `SL: <b>${sayi2(plan.sl)}</b>\n\n`;

    out += `Funding: ${info.funding != null ? info.funding.toFixed(5) : "Yok"}\n`;
    out += `OI: ${info.oiNow != null ? info.oiNow.toFixed(0) : "Yok"}\n`;
    out += `Long Short Oranı: ${info.lsr ? info.lsr.ratio.toFixed(2) + " (" + info.lsr.source + ")" : "Yok"}\n`;
    out += `Manipülasyon Skoru: ${info.manip.manipulationScore.toFixed(2)}\n`;
    out += `Fitil Riski: ${info.wick?.risk || "BILINMIYOR"}\n`;
    out += `${mexcNote}\n\n`;

    if (results.length) {
      for (const r of results) out += `${r.tf} → ${r.mmTarget}\n`;
      out += `\n`;
    }

    const uyarilar = [];
    if ((info.wick?.risk || "") === "YUKSEK") uyarilar.push("Sahte kırılım alarmı: fitil riski yüksek");
    if (flip) uyarilar.push("Funding yön değiştirdi");
    if (tp1Hit) uyarilar.push("TP1 geçildi: SL giriş seviyesine çekme önerisi");
    if (onayBekle) uyarilar.push("Onay bekle: 1m kapanış teyidi al");

    if (!mexcEval.ok && plan.side !== "AVOID") uyarilar.push("MEXC likidite onayı zayıf veya karşıt");

    if (uyarilar.length) {
      out += `<b>Uyarılar</b>\n`;
      out += uyarilar.map(x => `• ${x}`).join("\n") + "\n\n";
    }

    out += `TradingView\n${buildTradingViewLink(symbol)}`;

    await sendTelegramMessage(out.trim(), chatId);

    // Otomatik PRO sinyal: güven 70 üstü ve yön AVOID değilse
    if (mm.conf >= 70 && plan.side !== "AVOID") {
      const pro = proSinyalMetni({
        symbol,
        mmTarget: mm.target,
        conf: mm.conf,
        plan,
        info,
        mod,
        sizePct,
        onayBekle,
        mexcNote
      });
      await sendTelegramMessage(pro, chatId);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("signal error", e);
    return res.status(500).json({ error: e.toString() });
  }
}
