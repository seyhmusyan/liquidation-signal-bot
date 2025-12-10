export const config = { runtime: "nodejs18.x" };

import { addPair, removePair, getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";

function parseBody(req) {
  if (req.body) return req.body;
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(200).json({ ok: true });
    return;
  }

  const body = await parseBody(req);
  const msg = body.message;
  if (!msg || !msg.text) {
    res.status(200).json({ ok: true });
    return;
  }

  const text = msg.text.trim();
  const chatId = msg.chat?.id;

  async function reply(t) {
    await sendTelegramMessage(t, chatId);
  }

  if (text === "/pairs") {
    const pairs = await getActivePairs();
    await reply("📊 Aktif Pariteler:\n" + pairs.map((p) => "• " + p).join("\n"));
    res.status(200).json({ ok: true });
    return;
  }

  if (text.startsWith("/add ")) {
    const symbol = text.split(" ")[1];
    if (!symbol) {
      await reply("Kullanim: /add BTCUSDT");
    } else {
      const pairs = await addPair(symbol);
      await reply("Eklendi. Yeni liste:\n" + pairs.join(", "));
    }
    res.status(200).json({ ok: true });
    return;
  }

  if (text.startsWith("/remove ")) {
    const symbol = text.split(" ")[1];
    if (!symbol) {
      await reply("Kullanim: /remove BTCUSDT");
    } else {
      const pairs = await removePair(symbol);
      await reply("Silindi. Yeni liste:\n" + pairs.join(", "));
    }
    res.status(200).json({ ok: true });
    return;
  }

  await reply("Komutlar:\n/pairs\n/add BTCUSDT\n/remove BTCUSDT");
  res.status(200).json({ ok: true });
}
