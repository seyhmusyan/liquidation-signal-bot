export const config = { runtime: "nodejs" };

import { addPair, removePair, getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";

function parse(req) {
  if (req.body) return req.body;
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(d));
      } catch {
        resolve({});
      }
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  const body = await parse(req);
  const msg = body.message;
  if (!msg?.text) return res.status(200).json({ ok: true });

  const text = msg.text.trim();
  const chatId = msg.chat?.id;
  const reply = (t) => sendTelegramMessage(t, chatId);

  if (text === "/pairs") {
    const pairs = await getActivePairs();
    await reply("📊 Aktif Pariteler:\n" + pairs.map((p) => "• " + p).join("\n"));
    return res.status(200).json({ ok: true });
  }

  if (text.startsWith("/add ")) {
    const s = text.split(" ")[1];
    const pairs = await addPair(s);
    await reply("Eklendi. Yeni liste:\n" + pairs.join(", "));
    return res.status(200).json({ ok: true });
  }

  if (text.startsWith("/remove ")) {
    const s = text.split(" ")[1];
    const pairs = await removePair(s);
    await reply("Silindi. Yeni liste:\n" + pairs.join(", "));
    return res.status(200).json({ ok: true });
  }

  await reply("Komutlar:\n/pairs\n/add BTCUSDT\n/remove BTCUSDT");
  res.status(200).json({ ok: true });
}
