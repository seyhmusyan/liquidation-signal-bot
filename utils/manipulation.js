export async function detectManipulation(symbol) {
  let score = 0;
  const notes = [];

  try {
    const depth = await fetch(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=50`).then(r => r.json());
    const bids = depth.bids || [];
    const asks = depth.asks || [];

    const topBids = bids.slice(0, 10).map(b => Number(b[1]));
    const topAsks = asks.slice(0, 10).map(a => Number(a[1]));

    const bidSum = topBids.reduce((a,b)=>a+(Number.isFinite(b)?b:0),0);
    const askSum = topAsks.reduce((a,b)=>a+(Number.isFinite(b)?b:0),0);

    if (bidSum > askSum * 3) { score += 0.5; notes.push("Orderbook: aşırı bid yığılması (spoof ihtimali)"); }
    if (askSum > bidSum * 3) { score += 0.5; notes.push("Orderbook: aşırı ask yığılması (spoof ihtimali)"); }
  } catch (e) {
    console.error("manip depth error", symbol, e);
  }

  try {
    const trades = await fetch(`https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=50`).then(r => r.json());
    let buy = 0, sell = 0;
    for (const t of trades || []) {
      const price = Number(t.price);
      const qty = Number(t.qty);
      if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
      const notional = price * qty;
      if (t.isBuyerMaker) sell += notional; else buy += notional;
    }
    const total = buy + sell;
    if (total > 0) {
      const ratio = buy / total;
      if (ratio > 0.8 || ratio < 0.2) { score += 0.5; notes.push("Aggressive tek taraflı işlem akışı (layering olasılığı)"); }
    }
  } catch (e) {
    console.error("manip trades error", symbol, e);
  }

  return { manipulationScore: score, notes };
}
