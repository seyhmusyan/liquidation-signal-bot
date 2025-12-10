export function detectPumpDump({ changePct, volSpike }) {
  let pumpScore = 0;
  let dumpScore = 0;
  const notes = [];

  if (changePct > 0.3) {
    pumpScore += (changePct / 0.3);
    notes.push("Fiyat kısa sürede güçlü yukarı hareket");
  }
  if (changePct < -0.3) {
    dumpScore += (Math.abs(changePct) / 0.3);
    notes.push("Fiyat kısa sürede güçlü aşağı hareket");
  }

  if (volSpike > 2) {
    pumpScore *= 1.2;
    dumpScore *= 1.2;
    notes.push(`Hacim spike: ${volSpike.toFixed(2)}x`);
  }

  let label = null;
  if (pumpScore > 1 && pumpScore >= dumpScore) label = "PUMP";
  if (dumpScore > 1 && dumpScore > pumpScore) label = "DUMP";

  return { pumpScore, dumpScore, label, notes };
}
