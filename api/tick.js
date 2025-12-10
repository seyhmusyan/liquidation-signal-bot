export const config = { runtime: "nodejs" };

function wait(ms){return new Promise(r=>setTimeout(r,ms));}

export default async function handler(req,res){
  const base = process.env.VERCEL_URL;
  if (!base) return res.json({ok:false});

  for (let i=0;i<4;i++){
    await fetch(base+"/api/signal");
    if (i<3) await wait(15000);
  }

  return res.json({ok:true});
}
