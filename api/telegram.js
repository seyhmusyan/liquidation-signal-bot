import { addPair, removePair, getActivePairs } from "../../utils/pairsStore";
import { sendTelegramMessage } from "../../utils/telegram";

export const config = { runtime: "nodejs" };

export default async function handler(req) {
  const body = await req.json();
  const msg = body.message;
  if (!msg) return new Response("OK");

  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === "/pairs") {
    const pairs = await getActivePairs();
    return sendTelegramMessage("📊 Aktif Coinler:\n" + pairs.map(x => "• " + x).join("\n"), chatId);
  }

  if (text.startsWith("/add ")) {
    const p = text.split(" ")[1];
    const list = await addPair(p);
    return sendTelegramMessage(`Eklendi: ${list.join(", ")}`, chatId);
  }

  if (text.startsWith("/remove ")) {
    const p = text.split(" ")[1];
    const list = await removePair(p);
    return sendTelegramMessage(`Silindi: ${list.join(", ")}`, chatId);
  }

  return sendTelegramMessage("Komutlar:\n/pairs\n/add BTCUSDT\n/remove BTCUSDT", chatId);
}
