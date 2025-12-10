export async function getOpenInterestChange(symbol) {
  const res = await fetch(
    `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=2`,
    { cache: "no-store" }
  );
  const data = await res.json();
  if (!Array.isArray(data) || data.length < 2) return 0;

  const prev = Number(data[0].sumOpenInterest);
  const last = Number(data[1].sumOpenInterest);
  return (last - prev) / prev;
}