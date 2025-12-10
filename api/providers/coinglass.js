const KEY = process.env.COINGLASS_API;

export async function getCoinglassHeatmap(base) {
  if (!KEY) return [];
  const res = await fetch(
    `https://open-api.coinglass.com/public/v2/liquidationMap?symbol=${base}`,
    { headers: { coinglassSecret: KEY }, cache: "no-store" }
  );
  const json = await res.json();
  if (!json?.data) return [];

  return json.data.map(x => ({
    source: "coinglass",
    price: Number(x.price),
    side: String(x.side).toLowerCase(),
    size: Number(x.value)
  }));
}