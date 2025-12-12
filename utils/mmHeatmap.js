// utils/mmHeatmap.js

const CG_BASE = "https://open-api.coinglass.com/public/v2/liqMap";

const FALLBACK_PCT = {
  BTCUSDT: { tp1: 0.35, tp2: 0.70, sl: 0.40 },
  AVAXUSDT: { tp1: 0.60, tp2: 1.20, sl: 0.70 }
};

function tfToInterval(tf) {
  if (tf === "1h") return "1h";
  if (tf === "12h") return "12h";
  return "1d"; // 24h
}

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function pickBest(levels, price, side) {
  let best = null;

  for (const x of levels || []) {
    const p = safeNum(x.price ?? x.p);
    const v = safeNum(x.value ?? x.size ?? x.liq ?? x.amount ?? 0);
    const s = String(x.side ?? x.type ?? "").toLowerCase();

    if (!p || !v || v <= 0) continue;

    // Eğer response side ile geliyorsa ona da uyalım
    if (s) {
      if (side === "long" && s !== "long") continue;
      if (side === "short" && s !== "short") continue;
    }

    if (side === "long" && p >= price) continue;
    if (side === "short" && p <= price) continue;

    const distPct = Math.abs(p - price) / price * 100;
    const score = v / Math.max(distPct, 0.05);

    if (!best || score > best.score) best = { price: p, value: v, distPct, score };
  }

  return best;
}

function sumSide(levels, price, side) {
  let sum = 0;

  for (const x of levels || []) {
    const p = safeNum(x.price ?? x.p);
    const v = safeNum(x.value ?? x.size ?? x.liq ?? x.amount ?? 0);
    const s = String(x.side ?? x.type ?? "").toLowerCase();

    if (!p || !v || v <= 0) continue;

    if (s) {
      if (side === "long" && s !== "long") continue;
      if (side === "short" && s !== "short") continue;
    }

    if (side === "long" && p < price) sum += v;
    if (side === "short" && p > price) sum += v;
  }

  return sum;
}

function deriveHeatmapLevels(coinglassJson) {
  // Coinglass response şeması değişebiliyor
  const d = coinglassJson?.data;

  // Bazı varyantlar:
  // data: { liquidationMap: [...] }
  // data: [...]
  // data: { map: [...] }
  const levels =
    d?.liquidationMap ||
    d?.map ||
    d?.data ||
    d ||
    [];

  return Array.isArray(levels) ? levels : [];
}

export async function getCoinglassMMHeatmap({ baseSymbol, price, tf }) {
  const key = process.env.COINGLASS_API;
  if (!key) return null;

  // Coinglass için genelde Binance_ prefix kullanılıyor
  // Not: bazı planlarda sadece BTC/ETH base istenebiliyor, bu yüzden fallback deniyoruz
  const symbolA = `Binance_${baseSymbol}`;
  const symbolB = baseSymbol.replace("USDT", "");
  const interval = tfToInterval(tf);

  const headers = { coinglassSecret: key, accept: "application/json" };

  async function tryFetch(sym) {
    try {
      const url = `${CG_BASE}?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}`;
      const r = await fetch(url, { headers });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  const j1 = await tryFetch(symbolA);
  const j2 = j1 ? null : await tryFetch(symbolB);

  const j = j1 || j2;
  if (!j) return null;

  const levels = deriveHeatmapLevels(j);

  const nearestLong = pickBest(levels, price, "long");
  const nearestShort = pickBest(levels, price, "short");

  const longPool = sumSide(levels, price, "long");
  const shortPool = sumSide(levels, price, "short");

  let mmTarget = "UNCLEAR";
  if (shortPool > longPool * 1.15) mmTarget = "SHORTS";
  else if (longPool > shortPool * 1.15) mmTarget = "LONGS";

  // heatmap strength (0..1)
  const strengthBase = baseSymbol.startsWith("BTC") ? 10_000_000 : 2_000_000;
  const strength = Math.min(1, Math.max(longPool, shortPool) / strengthBase);

  return { tf, mmTarget, strength, nearestLong, nearestShort, longPool, shortPool };
}

/**
 * PRIORITY B: Funding > Long/Short Ratio > OI
 * context: { funding, lsr, oiBias }
 */
export function resolveMMTargetWithFallback(tfResults, context = {}) {
  const funding = safeNum(context.funding);
  const lsr = safeNum(context.lsr);
  const oiBias = safeNum(context.oiBias);

  // 1) Heatmap majority (varsa)
  const votes = { LONGS: 0, SHORTS: 0, UNCLEAR: 0 };
  let heatStrength = 0;

  for (const x of tfResults || []) {
    votes[x.mmTarget] = (votes[x.mmTarget] || 0) + 1;
    heatStrength = Math.max(heatStrength, safeNum(x.strength) ?? 0);
  }

  if (votes.LONGS >= 2) return { target: "LONGS", conf: 66 + Math.round(heatStrength * 12), reason: "HEATMAP_MAJ" };
  if (votes.SHORTS >= 2) return { target: "SHORTS", conf: 66 + Math.round(heatStrength * 12), reason: "HEATMAP_MAJ" };

  // 2) FUNDING (Priority 1)
  // Pozitif funding: long crowded -> MM longları liq etmeye çalışır -> target LONGS
  // Negatif funding: short crowded -> target SHORTS
  if (funding != null) {
    if (funding >= 0.0003) return { target: "LONGS", conf: 62, reason: "FUNDING" };
    if (funding <= -0.0003) return { target: "SHORTS", conf: 62, reason: "FUNDING" };
  }

  // 3) LSR (Priority 2)
  // LSR yüksekse long crowded -> target LONGS
  // LSR düşükse short crowded -> target SHORTS
  if (lsr != null) {
    if (lsr >= 1.15) return { target: "LONGS", conf: 60, reason: "LSR" };
    if (lsr <= 0.87) return { target: "SHORTS", conf: 60, reason: "LSR" };
  }

  // 4) OI bias (Priority 3) - zayıf karar
  // oiBias pozitif -> trend continuation long bias, fakat crowded ölçmez. düşük ağırlık
  if (oiBias != null) {
    if (oiBias <= -0.25) return { target: "LONGS", conf: 57, reason: "OI_BIAS" };  // long squeeze olasılığı -> longlar patlayabilir
    if (oiBias >= 0.25) return { target: "SHORTS", conf: 57, reason: "OI_BIAS" };
  }

  // 5) Heatmap strongest side (majority yoksa)
  let longPoolSum = 0;
  let shortPoolSum = 0;
  for (const x of tfResults || []) {
    longPoolSum += safeNum(x.longPool) ?? 0;
    shortPoolSum += safeNum(x.shortPool) ?? 0;
  }

  if (shortPoolSum > longPoolSum * 1.1) return { target: "SHORTS", conf: 56, reason: "HEATMAP_SUM" };
  if (longPoolSum > shortPoolSum * 1.1) return { target: "LONGS", conf: 56, reason: "HEATMAP_SUM" };

  return { target: "UNCLEAR", conf: 55, reason: "NONE" };
}

function applyPct(direction, entry, pct, kind) {
  const p = pct / 100;
  if (kind === "tp") return direction === "LONG" ? entry * (1 + p) : entry * (1 - p);
  return direction === "LONG" ? entry * (1 - p) : entry * (1 + p);
}

export function buildMMPlan({ price, mmTarget, nearestLong, nearestShort, symbol }) {
  // MM Target SHORTS => kısa squeeze -> LONG bias
  // MM Target LONGS  => long flush -> SHORT bias
  let side = "AVOID";
  if (mmTarget === "SHORTS") side = "LONG";
  if (mmTarget === "LONGS") side = "SHORT";

  const entry = price;

  // Heatmap seviyeleri varsa onları kullan
  let tp1 = null, tp2 = null, sl = null;

  if (side === "LONG") {
    tp1 = nearestShort?.price ?? null;
    tp2 = nearestShort?.price ? nearestShort.price * 1.003 : null;
    sl = nearestLong?.price ?? null;
  }

  if (side === "SHORT") {
    tp1 = nearestLong?.price ?? null;
    tp2 = nearestLong?.price ? nearestLong.price * 0.997 : null;
    sl = nearestShort?.price ?? null;
  }

  // Eğer heatmap boşsa PCT fallback (BTC/AVAX ayrı)
  const fb = FALLBACK_PCT[symbol] || { tp1: 0.4, tp2: 0.8, sl: 0.5 };

  if (side === "LONG") {
    if (!Number.isFinite(tp1)) tp1 = applyPct("LONG", entry, fb.tp1, "tp");
    if (!Number.isFinite(tp2)) tp2 = applyPct("LONG", entry, fb.tp2, "tp");
    if (!Number.isFinite(sl))  sl  = applyPct("LONG", entry, fb.sl,  "sl");
  }

  if (side === "SHORT") {
    if (!Number.isFinite(tp1)) tp1 = applyPct("SHORT", entry, fb.tp1, "tp");
    if (!Number.isFinite(tp2)) tp2 = applyPct("SHORT", entry, fb.tp2, "tp");
    if (!Number.isFinite(sl))  sl  = applyPct("SHORT", entry, fb.sl,  "sl");
  }

  return { symbol, side, entry, tp1, tp2, sl };
}

// Backward compatible
export function majorityMM(tfResults) {
  const votes = { LONGS: 0, SHORTS: 0, UNCLEAR: 0 };
  let bestStrength = 0;

  for (const x of tfResults || []) {
    votes[x.mmTarget] = (votes[x.mmTarget] || 0) + 1;
    bestStrength = Math.max(bestStrength, safeNum(x.strength) ?? 0);
  }

  let final = "UNCLEAR";
  if (votes.LONGS >= 2) final = "LONGS";
  if (votes.SHORTS >= 2) final = "SHORTS";

  const conf =
    votes.LONGS === 3 || votes.SHORTS === 3 ? 82 + Math.round(bestStrength * 10) :
    votes.LONGS === 2 || votes.SHORTS === 2 ? 66 + Math.round(bestStrength * 10) :
    55;

  return { final, conf };
}
