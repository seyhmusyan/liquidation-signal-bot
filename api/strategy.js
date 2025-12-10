/**
 * Çok basit bir confidence algoritması.
 * Daha sonra gerçek heatmap mantığı ile güncelleyebilirsin.
 */
export function buildSignal({ symbol, price, heatScore }) {
  if (!Number.isFinite(price)) return null;

  // heatScore 0-1 aralığında bekleniyor
  const clamped = Math.max(0, Math.min(1, Number(heatScore) || 0));
  const confidence = Math.round(40 + clamped * 60); // 40-100

  if (confidence < 60) return null;

  const side = clamped >= 0.5 ? "LONG" : "SHORT";

  const tp = side === "LONG" ? price * 1.01 : price * 0.99;
  const sl = side === "LONG" ? price * 0.99 : price * 1.01;

  return {
    symbol,
    side,
    entry: price,
    tp,
    sl,
    confidence
  };
}
