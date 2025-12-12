export async function detectArbitrage(symbol) {
  try {
    const [bRes, mRes] = await Promise.all([
      fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`),
      fetch(`https://api.mexc.com/api/v3/ticker/price?symbol=${symbol}`)
    ]);

    if (!bRes.ok || !mRes.ok) return { spreadPct: 0, side: null };

    const bPrice = Number((await bRes.json()).price);
    const mPrice = Number((await mRes.json()).price);
    if (!Number.isFinite(bPrice) || !Number.isFinite(mPrice) || !bPrice) return { spreadPct: 0, side: null };

    const spreadPct = (mPrice - bPrice) / bPrice * 100;
    let side = null;
    if (Math.abs(spreadPct) >= 0.15) side = spreadPct > 0 ? "UP" : "DOWN";
    return { spreadPct, side };
  } catch (e) {
    console.error("arb detect error", symbol, e);
    return { spreadPct: 0, side: null };
  }
}
