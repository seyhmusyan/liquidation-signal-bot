export function inferBaseFromMarketSymbol(symbol) {
  return symbol.replace("USDT", "");
}

export async function getMarket(symbol) {
  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`,
    { cache: "no-store" }
  );
  const json = await res.json();
  return { price: Number(json.price) };
}