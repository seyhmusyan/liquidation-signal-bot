export const config = { runtime: "nodejs" };

import { addPair, removePair, getActivePairs } from "../utils/pairsStore.js";
import { sendTelegramMessage } from "../utils/telegram.js";

function parse(req){
  if(req.body) return req.body;
  return new Promise(res=>{
    let d=""; req.on("data",c=>d+=c);
    req.on("end",()=>{ try{res(JSON.parse(d));}catch{res({})} });
  });
}

export default async function handler(req,res){
  const body = await parse(req);
  const msg = body.message;
  if (!msg?.text) return res.json({ok:true});

  const t = msg.text.trim();
  const chat = msg.chat.id;
  const reply = m=>sendTelegramMessage(m,chat);

  if (t==="/pairs") {
    const p = await getActivePairs();
    await reply("Pairs:\n"+p.join("\n"));
    return res.json({ok:true});
  }

  if (t.startsWith("/add ")) {
    const s = t.split(" ")[1];
    const p = await addPair(s);
    await reply("Added: "+p.join(", "));
    return res.json({ok:true});
  }

  if (t.startsWith("/remove ")) {
    const s = t.split(" ")[1];
    const p = await removePair(s);
    await reply("Removed: "+p.join(", "));
    return res.json({ok:true});
  }

  await reply("Commands:\n/pairs\n/add BTCUSDT\n/remove BTCUSDT");
  return res.json({ok:true});
}
