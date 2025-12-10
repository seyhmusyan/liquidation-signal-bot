export function buildSignal({ price, heatmap }) {
  const MAX_DIST = 1.5;
  const BASE = 2_000_000;

  const arr = heatmap
    .map(h => ({ ...h, distance: Math.abs(h.price - price) / price * 100 }))
    .filter(x => x.distance <= MAX_DIST)
    .sort((a, b) => b.size - a.size);

  if (arr.length === 0) return null;

  const m = arr[0];
  const type = m.side === "short" ? "SHORT" : "LONG";

  const dist = ((MAX_DIST - m.distance) / MAX_DIST) * 25;
  const liq = Math.min((m.size / BASE) * 35, 35);
  const src = m.source === "coinglass" ? 25 : 15;
  const cf = 20;
  const oiScore = m.oiChange < -0.02 ? 5 : 0;
  const fdScore = Math.abs(m.funding) > 0.01 ? 5 : 0;

  let conf = dist + liq + src + cf + oiScore + fdScore;
  conf = Math.min(100, Math.round(conf));

  if (conf < 60) return null;

  return {
    type,
    entry: price,
    target: m.price,
    stop: type === "SHORT" ? m.price * 1.005 : m.price * 0.995,
    confidence: conf,
    nearestClusters: arr.slice(0, 3)
  };
}