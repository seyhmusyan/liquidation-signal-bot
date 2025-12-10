export async function getRecentLiquidations(symbol) {
  const now = Date.now();
  const start = now - 5 * 60 * 1000;

  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=${symbol}&startTime=${start}&endTime=${now}`,
    { cache: "no-store" }
  );
  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data.map(x => {
    const price = Number(x.ap || x.p);
    const qty = Number(x.q);
    const notional = price * qty;
    const side = x.S === "SELL" ? "long" : "short";
    return { price, qty, notional, side };
  });
}