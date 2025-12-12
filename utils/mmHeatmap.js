// utils/mmHeatmap.js
const CG_BASE = "https://open-api.coinglass.com/public/v2/liqMap"; // v2 liqMap :contentReference[oaicite:4]{index=4}

function normalizeSymbol(input) {
  const t = (input || "").toUpperCase().replace("/", "").replace(" ", "");
  if (!t) return null;
  if (t.endsWith("USDT")) return t;
  return t + "USDT";
}

function tfToInterval(tf) {
  if (tf === "1h") return "1h";
  if (tf === "12h") return "12h";
  return "1d";
}

function pickBest(levels, price, side) {
  // levels: [{price,value,side}] varsayımı
  let best = null;
  for (const x of levels || []) {
    const p = Number(x.price);
    const v = Number(x.value ?? x.size ?? x.liq ?? 0);
    if (!Number.isFinite(p) || !Number.isFinite(v) || v <= 0) continue;

    if (side === "long" && p >= price) continue;
    if (side === "short" && p <= price) continue;

    const distPct = Math.abs(p - price) / price * 100;
    const score = v / Math.max(distPct, 0.05);

    if (!best || score > best.score) best = { price: p, value: v, distPct, score };
  }
  return best;
}

function sumSide(levels, price, side) {
  let s = 0;
  for (const x of levels || []) {
    const p = Number(x.price);
    const v = Number(x.value ?? x.size ?? x.liq ?? 0);
    if (!Number.isFinite(p) || !Number.isFinite(v) || v <= 0) continue;
    if (side === "long" && p < price) s += v;
    if (side === "short" && p > price) s += v;
  }
  return s;
}

export async function getCoinglassMMHeatmap({ baseSymbol, price, tf }) {
  const key = process.env.COINGLASS_API;
  if (!key) return null;

  const symbol = `Binance_${baseSymbol}`; // örnek: Binance_BTCUSDT :contentReference[oaicite:5]{index=5}
  const interval = tfToInterval(tf);

  const r = await fetch(`${CG_BASE}?symbol=${encodeURIComponent(symbol)}&interval=${interval}`, {
    headers: { coinglassSecret: key, accept: "application/json" }
  });

  if (!r.ok) return null;
  const j = await r.json();

  // Coinglass response şeması plana göre değişebiliyor.
  // Burada data içindeki level listelerini tek listeye indiriyoruz.
  const levels =
    j?.data?.liquidationMap ??
    j?.data?.map ??
    j?.data ??
    [];

  const nearestLong = pickBest(levels, price, "long");
  const nearestShort = pickBest(levels, price, "short");

  const longPool = sumSide(levels, price, "long");
  const shortPool = sumSide(levels, price, "short");

  const mmTarget =
    shortPool > longPool * 1.15 ? "SHORTS" :
    longPool > shortPool * 1.15 ? "LONGS" :
    "UNCLEAR";

  const strength = Math.min(1, Math.max(longPool, shortPool) / Math.max(price * 100, 1));

  return { tf, mmTarget, strength, nearestLong, nearestShort, longPool, shortPool };
}

export function buildMMPlan({ price, mmTarget, nearestLong, nearestShort, symbol }) {
  // Entry/TP: heatmap seviyelerine göre
  // MM Target SHORTS => yukarı likidite avı => LONG bias
  // MM Target LONGS  => aşağı likidite avı => SHORT bias
  let side = "AVOID";
  if (mmTarget === "SHORTS") side = "LONG";
  if (mmTarget === "LONGS") side = "SHORT";

  let entry = price;
  let tp1 = null;
  let tp2 = null;
  let sl = null;

  if (side === "LONG") {
    tp1 = nearestShort?.price ?? price * 1.004;
    tp2 = nearestShort?.price ? nearestShort.price * 1.003 : price * 1.008;
    sl  = nearestLong?.price ?? price * 0.996;
  }

  if (side === "SHORT") {
    tp1 = nearestLong?.price ?? price * 0.996;
    tp2 = nearestLong?.price ? nearestLong.price * 0.997 : price * 0.992;
    sl  = nearestShort?.price ?? price * 1.004;
  }

  return { symbol, side, entry, tp1, tp2, sl };
}

export function majorityMM(tfResults) {
  const votes = { LONGS: 0, SHORTS: 0, UNCLEAR: 0 };
  for (const x of tfResults) votes[x.mmTarget] = (votes[x.mmTarget] || 0) + 1;

  let final = "UNCLEAR";
  if (votes.LONGS >= 2) final = "LONGS";
  if (votes.SHORTS >= 2) final = "SHORTS";

  const conf =
    votes.LONGS === 3 || votes.SHORTS === 3 ? 82 :
    votes.LONGS === 2 || votes.SHORTS === 2 ? 66 :
    55;

  return { final, conf };
}
