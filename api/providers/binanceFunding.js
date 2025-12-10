export async function getLatestFundingRate(symbol) {
  const res = await fetch(
    `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`,
    { cache: "no-store" }
  );
  const data = await res.json();
  return Number(data[0]?.fundingRate || 0);
}