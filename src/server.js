import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import fetch from 'node-fetch';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY) : null;

let state = {
  price:null, prevPrice:null, bids:[], asks:[], buyVol:0, sellVol:0,
  tickDir:0, trades:[], lastScore:null, lastVerdict:null,
  connected:false, lastUpdate:null, priceHistory:[], flowHistory:[],
  polyMarkets:{
    dip78:{question:'BTC dip to $78k',side:'NO',price:0.60,implied:91.0},
    reach84:{question:'BTC reach $84k',side:'NO',price:0.62,implied:91.8}
  }
};

let binanceWS=null, reconnectTimer=null;
let diag = { connectAttempts:0, lastConnectAt:null, lastOpenAt:null, lastErrorAt:null, lastErrorMsg:null, lastCloseAt:null, lastCloseCode:null, lastCloseReason:null, lastRestErrorAt:null, lastRestErrorMsg:null };
function connectBinance(){
  if(binanceWS) try{binanceWS.terminate();}catch(e){}
  diag.connectAttempts++; diag.lastConnectAt=new Date().toISOString();
  binanceWS=new WebSocket('wss://stream.binance.com:9443/stream?streams=btcusdt@depth10@100ms/btcusdt@aggTrade');
  binanceWS.on('open',()=>{state.connected=true;diag.lastOpenAt=new Date().toISOString();console.log('[binance] connected');clearTimeout(reconnectTimer);});
  binanceWS.on('message',(raw)=>{
    try{
      const msg=JSON.parse(raw.toString());
      if(!msg.data)return;
      const d=msg.data;
      if(d.e==='depthUpdate'||d.bids)processDepth(d);
      else if(d.e==='aggTrade')processTrade(d);
      state.lastUpdate=new Date().toISOString();
      const snap=compute();
      if(snap)broadcast(snap);
    }catch(e){}
  });
  binanceWS.on('error',(err)=>{state.connected=false;diag.lastErrorAt=new Date().toISOString();diag.lastErrorMsg=err&&err.message?err.message:String(err);console.error('[binance] error',diag.lastErrorMsg);});
  binanceWS.on('close',(code,reason)=>{state.connected=false;diag.lastCloseAt=new Date().toISOString();diag.lastCloseCode=code;diag.lastCloseReason=reason?reason.toString():null;console.warn('[binance] close',code,diag.lastCloseReason);reconnectTimer=setTimeout(connectBinance,3000);});
}

async function restFallback(){
  if(state.connected)return;
  try{
    const [depthRes,priceRes]=await Promise.all([
      fetch('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=10'),
      fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT')
    ]);
    processDepth(await depthRes.json());
    state.price=parseFloat((await priceRes.json()).price);
    state.lastUpdate=new Date().toISOString();
    const snap=compute();if(snap)broadcast(snap);
  }catch(e){diag.lastRestErrorAt=new Date().toISOString();diag.lastRestErrorMsg=e.message;console.error('[rest]',e.message);}
}
setInterval(restFallback,5000);
setTimeout(restFallback,2000);

// Liveness watchdog. Binance's depth/aggTrade stream sometimes goes
// quiet without firing 'close' or 'error', leaving state.connected
// stuck at true while no compute() runs. If lastUpdate is older than
// 30s, force the connection to recycle.
setInterval(() => {
  if (!state.lastUpdate) return;
  const ageMs = Date.now() - new Date(state.lastUpdate).getTime();
  if (ageMs > 30000) {
    console.warn('[watchdog] stream silent for ' + (ageMs / 1000).toFixed(0) + 's — reconnecting');
    state.connected = false;
    try { binanceWS && binanceWS.terminate(); } catch (e) {}
    connectBinance();
  }
}, 10000);

function processDepth(d){
  const bids=(d.bids||d.b||[]).slice(0,10).map(b=>({p:parseFloat(b[0]),s:parseFloat(b[1])}));
  const asks=(d.asks||d.a||[]).slice(0,10).map(a=>({p:parseFloat(a[0]),s:parseFloat(a[1])}));
  if(bids.length)state.bids=bids;
  if(asks.length)state.asks=asks;
  if(state.bids.length&&state.asks.length){
    const mid=(state.bids[0].p+state.asks[0].p)/2;
    state.prevPrice=state.price;
    if(state.prevPrice&&mid!==state.prevPrice)state.tickDir=mid>state.prevPrice?1:-1;
    state.price=mid;
  }
}
function processTrade(d){
  const vol=parseFloat(d.q),isBuy=!d.m;
  if(isBuy)state.buyVol+=vol;else state.sellVol+=vol;
  state.trades.push({t:Date.now(),p:parseFloat(d.p),v:vol,buy:isBuy});
  if(state.trades.length>500)state.trades.shift();
}
setInterval(()=>{state.buyVol*=0.7;state.sellVol*=0.7;},60000);

function clamp(v){return Math.max(-1,Math.min(1,v));}
function compute(){
  if(!state.price||!state.bids.length||!state.asks.length)return null;
  const bestBid=state.bids[0].p,bestAsk=state.asks[0].p;
  const spread=bestAsk-bestBid,spreadPct=(spread/bestAsk)*100;
  const bidDepth=state.bids.reduce((s,b)=>s+b.s*b.p,0);
  const askDepth=state.asks.reduce((s,a)=>s+a.s*a.p,0);
  const totalDepth=bidDepth+askDepth;
  const imbalance=totalDepth>0?(bidDepth-askDepth)/totalDepth:0;
  const depthRatio=askDepth>0?bidDepth/askDepth:1;
  const totalFlow=state.buyVol+state.sellVol;
  const buyPct=totalFlow>0?state.buyVol/totalFlow:0.5;
  const p78Signal=(state.polyMarkets.dip78.implied/100-0.5)*2;
  const p84Signal=(1-state.polyMarkets.reach84.implied/100-0.5)*2;
  const sigOB=clamp(imbalance*3),sigFlow=clamp((buyPct-0.5)*4);
  const sigSpread=spreadPct<0.02?0.3:spreadPct<0.05?0:-0.2;
  const sigDepth=clamp((depthRatio-1)*2),sigTick=state.tickDir*0.5;
  const sigPoly=clamp((p78Signal+p84Signal)/2);
  const composite=sigOB*0.30+sigFlow*0.25+sigSpread*0.10+sigDepth*0.15+sigTick*0.10+sigPoly*0.10;
  const score=Math.round((composite+1)*50);
  state.priceHistory.push(state.price);
  state.flowHistory.push(parseFloat(composite.toFixed(4)));
  if(state.priceHistory.length>120){state.priceHistory.shift();state.flowHistory.shift();}
  const [verdict,detail]=getVerdict(score);
  state.lastScore=score;state.lastVerdict=verdict;
  maybeLog(score,verdict,composite,imbalance,buyPct,spreadPct);
  return{type:'snapshot',ts:state.lastUpdate,price:state.price,prevPrice:state.prevPrice,
    spread:parseFloat(spread.toFixed(2)),spreadPct:parseFloat(spreadPct.toFixed(4)),
    imbalance:parseFloat(imbalance.toFixed(4)),depthRatio:parseFloat(depthRatio.toFixed(4)),
    buyPct:parseFloat(buyPct.toFixed(4)),tickDir:state.tickDir,score,verdict,detail,
    composite:parseFloat(composite.toFixed(4)),
    signals:{sigOB,sigFlow,sigSpread,sigDepth,sigTick,sigPoly},
    bids:state.bids.slice(0,8),asks:state.asks.slice(0,8),
    priceHistory:state.priceHistory.slice(-60),flowHistory:state.flowHistory.slice(-60),
    polyMarkets:state.polyMarkets,connected:state.connected};
}
function getVerdict(score){
  if(score>=70)return['BULLISH','Strong upward pressure — buy side dominant'];
  if(score>=60)return['MILD BULL','Slight buying edge — watch for confirmation'];
  if(score>=50)return['NEUTRAL','Balanced order flow — low conviction signal'];
  if(score>=40)return['MILD BEAR','Light sell pressure — proceed with caution'];
  return['BEARISH','Strong downward pressure — sell side dominant'];
}
// Local JSONL log alongside the Supabase write. Same 30s debounce, but
// always-on (no env var needed). Used by the polymarket backtest harness
// to pair model signals with realized BTC moves 15 min later.
const LOG_DIR = join(__dirname, '..', 'logs');
const LOG_FILE = join(LOG_DIR, 'snapshots.jsonl');
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
let lastLogTime=0,lastLogScore=null;
async function maybeLog(score,verdict,composite,imbalance,buyPct,spreadPct){
  const now=Date.now();
  if(now-lastLogTime<30000&&score===lastLogScore)return;
  lastLogTime=now;lastLogScore=score;
  const row={ts:new Date(now).toISOString(),score,verdict,composite,price:state.price,imbalance,buy_pct:buyPct,spread_pct:spreadPct,tick_dir:state.tickDir};
  try{appendFileSync(LOG_FILE, JSON.stringify(row)+'\n');}catch(e){}
  if(!supabase)return;
  try{await supabase.from('btc_momentum').insert({score,verdict,composite,price:state.price,imbalance,buy_pct:buyPct,spread_pct:spreadPct,tick_dir:state.tickDir});}catch(e){}
}
function broadcast(data){
  const msg=JSON.stringify(data);
  wss.clients.forEach(c=>{if(c.readyState===WebSocket.OPEN)try{c.send(msg);}catch(e){}});
}
wss.on('connection',(ws)=>{
  const snap=compute();if(snap)ws.send(JSON.stringify(snap));
  ws.on('message',(raw)=>{
    try{const msg=JSON.parse(raw.toString());if(msg.type==='update_poly')Object.assign(state.polyMarkets,msg.markets);}catch(e){}
  });
});
app.use(express.static(join(__dirname,'../public')));
app.use(express.json());
app.get('/api/state',(req,res)=>res.json(compute()||{error:'no data yet'}));
app.get('/health',(req,res)=>res.json({ok:true,connected:state.connected,score:state.lastScore,price:state.price}));
app.get('/diag',(req,res)=>res.json({connected:state.connected,lastUpdate:state.lastUpdate,price:state.price,...diag}));
app.patch('/api/poly',(req,res)=>{
  if(req.body.dip78)Object.assign(state.polyMarkets.dip78,req.body.dip78);
  if(req.body.reach84)Object.assign(state.polyMarkets.reach84,req.body.reach84);
  broadcast({type:'poly_update',polyMarkets:state.polyMarkets});
  res.json({ok:true,polyMarkets:state.polyMarkets});
});
server.listen(PORT,()=>{console.log('[server] :'+PORT);connectBinance();});
