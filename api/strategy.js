export function buildSignal({ symbol, price, score }) {
  if (!Number.isFinite(price)) return null;
  const s = Math.max(0, Math.min(1, score || 0));
  const confidence = Math.round(40 + s * 60); // 40-100

  if (confidence < 60) return null;

  const side = s >= 0.5 ? "LONG" : "SHORT";
  const tp = side === "LONG" ? price * 1.01 : price * 0.99;
  const sl = side === "LONG" ? price * 0.99 : price * 1.01;

  return { symbol, side, entry: price, tp, sl, confidence };
}
