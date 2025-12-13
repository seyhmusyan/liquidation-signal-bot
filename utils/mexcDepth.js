// utils/mexcDepth.js

function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function sumTop(levels, n = 20) {
  let s = 0;
  for (let i = 0; i < Math.min(levels.length, n); i++) {
    const p = safeNum(levels[i]?.[0]);
    const q = safeNum(levels[i]?.[1]);
    if (!p || !q) continue;
    s += p * q;
  }
  return s;
}

export async function getMexcLikiditeOnayi(symbol) {
  try {
    const r = await fetch(`https://api.mexc.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=50`);
    if (!r.ok) return { var: false, durum: "MEXC veri yok" };

    const j = await r.json();
    const bids = Array.isArray(j.bids) ? j.bids : [];
    const asks = Array.isArray(j.asks) ? j.asks : [];

    if (!bids.length || !asks.length) return { var: false, durum: "MEXC depth boş" };

    const bidTop = sumTop(bids, 20);
    const askTop = sumTop(asks, 20);
    const total = bidTop + askTop;

    if (!total) return { var: false, durum: "MEXC depth zayıf" };

    const oran = bidTop / Math.max(askTop, 1);
    let yon = "DENGE";
    if (oran >= 1.35) yon = "ALIM_BASKISI";
    if (oran <= 0.74) yon = "SATIS_BASKISI";

    return {
      var: true,
      durum: "OK",
      bidTop,
      askTop,
      oran,
      yon
    };
  } catch {
    return { var: false, durum: "MEXC hata" };
  }
}
