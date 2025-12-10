export const config = { runtime: "nodejs" };

import { addPair, removePair, getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";

function parse(req) {
  if (req.body) return req.body;
  return new Promise((resolve)=> {
    let d=""; req.on("data",c=>d+=c);
    req.on("end",()=>{ try{resolve(JSON.parse(d));}catch{resolve({});} });
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.json({ ok:true });

  const body = await parse(req);
  const msg = body.message;
  if (!msg?.text) return res.json({ ok:true });

  const t = msg.text.trim();
  const chat = msg.chat.id;

  const reply = (m)=> sendTelegramMessage(m, chat);

  if (t === "/pairs") {
    const pairs = await getActivePairs();
    await reply("Pairs:\n" + pairs.join("\n"));
    return res.json({ ok:true });
  }

  if (t.startsWith("/add ")) {
    const s = t.split(" ")[1];
    const pairs = await addPair(s);
    await reply("Added:\n" + pairs.join(", "));
    return res.json({ ok:true });
  }

  if (t.startsWith("/remove ")) {
    const s = t.split(" ")[1];
    const pairs = await removePair(s);
    await reply("Removed:\n" + pairs.join(", "));
    return res.json({ ok:true });
  }

  await reply("Commands:\n/pairs\n/add BTCUSDT\n/remove BTCUSDT");
  res.json({ ok:true });
}
