export async function getOrderbook(symbol) {
  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=500`,
    { cache: "no-store" }
  );
  const json = await res.json();
  return {
    bids: json.bids.map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
    asks: json.asks.map(([p, q]) => ({ price: Number(p), qty: Number(q) }))
  };
}