export function buildSignal({ symbol, price, score, volSpike }) {
  if (!Number.isFinite(price)) return null;

  const s = Math.max(0, Math.min(1, score || 0));
  let confidence = Math.round(40 + s * 60);
  if (volSpike && volSpike > 2) confidence = Math.min(100, confidence + 5);

  if (confidence < 60) return null;

  const side = s >= 0.5 ? "LONG" : "SHORT";
  const tp1 = side === "LONG" ? price * 1.005 : price * 0.995;
  const tp2 = side === "LONG" ? price * 1.01 : price * 0.99;
  const sl  = side === "LONG" ? price * 0.99 : price * 1.01;

  return { symbol, side, entry: price, tp1, tp2, sl, confidence };
}
