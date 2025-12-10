export function interpretOiFunding({ oiNow, oiPrev, priceChange, funding }) {
  const notes = [];
  let bias = 0;

  if (oiNow != null && oiPrev != null) {
    const deltaOi = oiNow - oiPrev;
    const relOi = oiPrev ? deltaOi / oiPrev : 0;
    if (relOi > 0.02 && priceChange > 0) {
      notes.push("OI↑ + Fiyat↑ (trend devamı)");
      bias += 0.3;
    } else if (relOi < -0.02 && priceChange > 0) {
      notes.push("OI↓ + Fiyat↑ (short squeeze olasılığı)");
      bias += 0.4;
    } else if (relOi > 0.02 && priceChange < 0) {
      notes.push("OI↑ + Fiyat↓ (long squeeze olasılığı)");
      bias -= 0.4;
    } else if (relOi < -0.02 && priceChange < 0) {
      notes.push("OI↓ + Fiyat↓ (trend zayıflıyor)");
    }
  }

  if (typeof funding === "number") {
    if (funding > 0.0005) {
      notes.push("Funding yüksek pozitif (long crowded, short lehine risk)");
      bias -= 0.2;
    } else if (funding < -0.0005) {
      notes.push("Funding yüksek negatif (short crowded, long lehine risk)");
      bias += 0.2;
    }
  }

  return { bias, notes };
}
