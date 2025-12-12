export async function detectWhales(symbol) {
  let buyNotional = 0;
  let sellNotional = 0;
  const bigTrades = [];

  try {
    const r = await fetch(`https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=100`);
    if (!r.ok) return { whaleScore: 0, side: null, bigTrades };

    const trades = await r.json();
    for (const t of trades) {
      const price = Number(t.price);
      const qty = Number(t.qty);
      if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
      const notional = price * qty;

      const threshold = symbol.startsWith("BTC") ? 200_000 : 50_000;
      if (notional >= threshold) bigTrades.push({ price, qty, notional, isBuyerMaker: t.isBuyerMaker });

      if (t.isBuyerMaker) sellNotional += notional; else buyNotional += notional;
    }

    const total = buyNotional + sellNotional;
    if (!total) return { whaleScore: 0, side: null, bigTrades };

    const buyRatio = buyNotional / total;
    let side = null;
    if (buyRatio > 0.6) side = "BUY";
    else if (buyRatio < 0.4) side = "SELL";

    return { whaleScore: bigTrades.length, side, bigTrades };
  } catch (e) {
    console.error("whale detect error", symbol, e);
    return { whaleScore: 0, side: null, bigTrades: [] };
  }
}
