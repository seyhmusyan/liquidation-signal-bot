export function computeMMYON({
  liqScore,
  oiBias,
  whaleSide,
  pumpDumpLabel,
  manipScore,
  arbSide
}) {
  let scoreLong = 0;
  let scoreShort = 0;
  const notes = [];

  if (liqScore != null && liqScore > 0.7) {
    notes.push("Güçlü likidasyon/likidite cluster aktif");
  }

  if (oiBias > 0.05) {
    scoreLong += 0.5;
    notes.push("OI/Funding bias LONG yönü destekliyor");
  } else if (oiBias < -0.05) {
    scoreShort += 0.5;
    notes.push("OI/Funding bias SHORT yönü destekliyor");
  }

  if (whaleSide === "BUY") {
    scoreLong += 0.4;
    notes.push("Whale akışı alım yönünde");
  } else if (whaleSide === "SELL") {
    scoreShort += 0.4;
    notes.push("Whale akışı satış yönünde");
  }

  if (pumpDumpLabel === "PUMP") {
    scoreLong += 0.3;
    notes.push("Pump sinyali algılandı");
  } else if (pumpDumpLabel === "DUMP") {
    scoreShort += 0.3;
    notes.push("Dump sinyali algılandı");
  }

  if (manipScore > 0.7) {
    notes.push("Manipülasyon riski yüksek, nötr kalma ihtimali artıyor");
    scoreLong *= 0.7;
    scoreShort *= 0.7;
  }

  if (arbSide === "UP") {
    scoreLong += 0.1;
    notes.push("Arb: MEXC fiyatı daha yüksek (yukarı baskı olasılığı)");
  } else if (arbSide === "DOWN") {
    scoreShort += 0.1;
    notes.push("Arb: MEXC fiyatı daha düşük (aşağı baskı olasılığı)");
  }

  let mmDir = "AVOID";
  if (scoreLong > scoreShort * 1.2 && scoreLong > 0.4) mmDir = "LONG";
  else if (scoreShort > scoreLong * 1.2 && scoreShort > 0.4) mmDir = "SHORT";

  const totalScore = Math.max(scoreLong, scoreShort);

  return { mmDir, scoreLong, scoreShort, totalScore, notes };
}
