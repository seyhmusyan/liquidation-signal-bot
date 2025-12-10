export function buildSignal({ symbol, price, heatScore }) {
  if (!Number.isFinite(price)) return null;
  const clamped = Math.max(0, Math.min(1, heatScore || 0));
  const confidence = Math.round(40 + clamped * 60);
  if (confidence < 60) return null;

  const side = clamped >= 0.5 ? "LONG" : "SHORT";
  const tp = side === "LONG" ? price * 1.01 : price * 0.99;
  const sl = side === "LONG" ? price * 0.99 : price * 1.01;

  return { symbol, side, entry: price, tp, sl, confidence };
}
