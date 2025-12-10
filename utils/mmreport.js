import { getActivePairs } from "./pairsStore.js";
import { fetchMMFullAnalysis } from "./mmcore.js";

export async function generateMMReport() {
  const pairs = await getActivePairs();
  let txt = "📊 <b>MM Rapor</b>\n\n";

  for (const pair of pairs) {
    const d = await fetchMMFullAnalysis(pair);

    txt += `<b>${pair}</b>\n`;
    txt += `• Price: ${d.price}\n`;
    txt += `• MMYON: ${d.mmDir}\n`;
    txt += `• Funding: ${d.funding}\n`;
    txt += `• OI: ${d.oi}\n`;
    txt += `• L/S: ${d.longShort}\n`;
    txt += `• Nearest Liq: ${d.nearest}\n`;
    txt += `• Cluster: ${d.cluster}\n\n`;
  }

  return txt;
}
