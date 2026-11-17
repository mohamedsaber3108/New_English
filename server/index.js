import 'dotenv/config';
import express from 'express';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {customerRouter} from './customer.js';
import {createRateLimiter} from './ratelimit.js';
import {createRoomHub} from './rooms.js';
import {adminRouter} from './admin.js';
import {operationsRouter} from './operations.js';
import {getAssessment,gradeAssessment,assessText,nextActivity,simulationTurn,reportSession,packs} from './engine.js';
import {log,requestMiddleware,errorHandler,installProcessHandlers,metricsHandler} from './observability.js';
import {checkConfig} from './config.js';
installProcessHandlers();
// Configuration check: log every finding; refuse to start on fatal ones (e.g. non-HTTPS origin in production).
const configFindings=checkConfig();
for(const f of configFindings)log(f.level==='fatal'?'error':'warn','configuration',{key:f.key,detail:f.message});
if(configFindings.some(f=>f.level==='fatal')){log('error','refusing to start: fix the fatal configuration findings above');process.exit(1)}
const app=express();app.set('trust proxy','loopback');const server=createServer(app);const root=join(dirname(fileURLToPath(import.meta.url)),'..');const port=Number(process.env.PORT||4100);
app.disable('x-powered-by');app.use(requestMiddleware());app.use(express.json({limit:'96kb'}));app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(), geolocation=(), payment=()');res.setHeader('Cross-Origin-Opener-Policy','same-origin');
// CSP: scripts only from this origin (no inline/eval) — the main XSS defence. Inline style attributes are needed by
// React style props (progress bars). Fonts are self-hosted. Paymob checkout is a top-level navigation (not framed).
res.setHeader('Content-Security-Policy',["default-src 'self'","script-src 'self'","style-src 'self' 'unsafe-inline'","font-src 'self' data:","img-src 'self' data: blob:","media-src 'self' blob:","connect-src 'self' ws: wss:","worker-src 'self'","manifest-src 'self'","frame-ancestors 'none'","base-uri 'self'","form-action 'self'","object-src 'none'"].join('; '));
res.setHeader('X-Frame-Options','DENY');next()});
// Shared rate limiting (Redis when REDIS_URL is set, otherwise per-process memory). 120 req/min/IP on the API.
const limiter=createRateLimiter();
app.use('/api',limiter.middleware({name:'api',limit:Number(process.env.API_RATE_LIMIT_PER_MIN||120),windowMs:60000}));
const customer=customerRouter();
app.use('/api',(req,res,next)=>{if(['GET','HEAD','OPTIONS'].includes(req.method))return next();const origin=req.get('origin');if(origin&&origin!==`${req.protocol}://${req.get('host')}`)return res.status(403).json({error:'Invalid origin'});next()});
app.use('/api',customer.router);
app.use('/api',operationsRouter(customer,{root}));
// Admin operations (individual accounts + RBAC). Integration status reports only whether a provider is
// configured, never the secret itself.
app.use('/api',adminRouter(customer,{root,leadsFile:process.env.LEADS_FILE||join(root,'data','leads.jsonl'),integrations:()=>({
  storage:customer.storageBackend(),
  payments:customer.paymentEnabled()?'configured':'awaiting credentials',
  email:process.env.RESEND_API_KEY&&process.env.EMAIL_FROM?'configured':'awaiting credentials',
  ai:process.env.OPENAI_API_KEY?'configured':'awaiting credentials',
  rateLimit:limiter.status().backend,
  rooms:hub.status().backend,
  auditKeyed:!!process.env.AUDIT_HMAC_KEY,
  accessEnforcement:customer.enforcementEnabled()?'enforced':'open',
}),configFindings:()=>configFindings}));
// Paid-content gate. Access enforcement is INDEPENDENT of payment-provider configuration (fail closed).
// Only ACCESS_ENFORCEMENT=open serves learning content without an entitlement; the absence of Paymob keys never opens it.
const paid=(tier='essential')=>(req,res,next)=>{if(!customer.enforcementEnabled())return next();return customer.requireUser(req,res,()=>customer.active(req.customer,'English',tier)?next():res.status(402).json({error:'اشتراك الإنجليزية غير نشط. افتح صفحة حسابك لاختيار باقة.'}))};
// Liveness: process is up. Cheap, no dependencies — safe for load-balancer liveness probes.
app.get('/api/health',(_req,res)=>res.json({ok:true,coachConfigured:!!process.env.OPENAI_API_KEY,paymentConfigured:customer.paymentEnabled(),accessEnforcement:customer.enforcementEnabled(),accessMode:customer.accessMode(),storageBackend:customer.storageBackend(),languagePacks:Object.keys(packs)}));
// Readiness: storage is reachable. Use this for load-balancer readiness/rolling-deploy gates.
// Readiness = storage reachable. Rate-limit degradation is reported but does not fail readiness
// (the limiter fails open to per-instance memory so the service stays available).
app.get('/api/ready',async(_req,res)=>{try{const h=await customer.storageHealth();res.json({ready:true,...h,rateLimit:limiter.status(),rooms:hub.status()})}catch(e){res.status(503).json({ready:false,error:'storage unavailable',rateLimit:limiter.status(),rooms:hub.status()})}});
// Lead anti-spam: 5 successfully saved leads per IP per hour (shared across instances when Redis is configured).
const LEAD_LIMIT=5,LEAD_WINDOW=3600000;
const todayCairo=()=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`};
app.post('/api/leads',async(req,res)=>{
  const ip=req.ip||'local';
  if(!(await limiter.peek(`lead:${ip}`,LEAD_LIMIT,LEAD_WINDOW)).allowed)return res.status(429).json({error:'طلبات كثيرة من هذا الجهاز. جرّب لاحقًا.'});
  const b=req.body||{},clean=(v,n)=>String(v||'').trim().slice(0,n);
  const name=clean(b.name,80),email=clean(b.email,120).toLowerCase(),phone=clean(b.phone,25);
  const kind=clean(b.kind,20),language=clean(b.language,20),plan=clean(b.plan,20),term=clean(b.term,20);
  const allowedKinds=['subscription','meeting','language','question'];
  if(name.length<2||!/^\S+@\S+\.\S+$/.test(email)||phone.replace(/\D/g,'').length<8||!allowedKinds.includes(kind))return res.status(400).json({error:'راجع الاسم والبريد ورقم الهاتف ونوع الطلب.'});
  if(!['English','German','Spanish','French'].includes(language))return res.status(400).json({error:'اختار لغة صحيحة.'});
  if(kind==='subscription'&&(!['essential','plus'].includes(plan)||!['monthly','yearly'].includes(term)))return res.status(400).json({error:'اختار باقة ومدة صحيحتين.'});
  const preferredDate=clean(b.preferredDate,10),preferredTime=clean(b.preferredTime,5);
  if(kind==='meeting'&&(!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)||preferredDate<todayCairo()||!['10:00','12:00','15:00','17:00'].includes(preferredTime)))return res.status(400).json({error:'اختار تاريخًا ووقتًا مفضلًا صالحين.'});
  const reference='UL-'+randomUUID().slice(0,8).toUpperCase();
  const lead={reference,createdAt:new Date().toISOString(),name,email,phone,company:clean(b.company,100),kind,language,plan:kind==='subscription'?plan:null,term:kind==='subscription'?term:null,groupSize:kind==='meeting'?Math.min(10000,Math.max(2,Number(b.groupSize)||2)):null,preferredDate:kind==='meeting'?preferredDate:null,preferredTime:kind==='meeting'?preferredTime:null,message:clean(b.message,1500),status:'new'};
  // Leads are persisted in the primary store (JSON or PostgreSQL) so staff can update them and they are backed
  // up with everything else. A legacy LEADS_FILE (JSONL) is imported once by the admin module.
  try{await customer.repo.leads.create(await customer.db(),lead);await limiter.consume(`lead:${ip}`,LEAD_LIMIT,LEAD_WINDOW);res.status(201).json({ok:true,reference,message:'Request received. Meeting time requires confirmation.'})}catch{res.status(503).json({error:'تعذر حفظ الطلب الآن. حاول لاحقًا.'})}
});
app.get('/api/assessment',(_req,res)=>res.json({questions:getAssessment()}));
// Placement: graded on the server (the answer key never leaves it). For a signed-in learner the result is stored
// (assessment history; the latest result drives the level and skill estimates shown in the app).
app.post('/api/assessment',async(req,res)=>{
  const answers=req.body?.answers&&typeof req.body.answers==='object'&&!Array.isArray(req.body.answers)?Object.fromEntries(Object.entries(req.body.answers).slice(0,50).map(([k,v])=>[String(k).slice(0,20),Number(v)])):{};
  const result=gradeAssessment(answers);
  try{const s=await customer.sessionFromRequest(req);if(s){const row=await customer.learning.recordAssessment(await customer.db(),s.user.id,answers,result);return res.json({...result,stored:true,assessmentId:row.id})}}catch(e){log('warn','assessment not stored',{error:e.message})}
  res.json({...result,stored:false});
});
app.post('/api/feedback',paid(),(req,res)=>res.json(assessText(String(req.body.text||'').slice(0,2500))));
app.post('/api/recommendation',paid(),(req,res)=>res.json(nextActivity(req.body.profile||{})));
app.post('/api/simulation',paid(),async(req,res)=>{const s=req.body.scenario;if(!s||typeof s.opening!=='string')return res.status(400).json({error:'Invalid scenario'});const turns=Array.isArray(req.body.turns)?req.body.turns.slice(-20):[];const text=String(req.body.text||'').slice(0,1000);if(!process.env.OPENAI_API_KEY)return res.json({...simulationTurn(s,turns,text),mode:'guided'});try{const n=turns.filter(t=>t.role==='user').length;const history=turns.map(t=>({role:t.role==='user'?'user':'assistant',content:String(t.text||'').slice(0,1000)}));const response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4o-mini',temperature:.65,messages:[{role:'system',content:`You are the ${String(s.roles||'conversation partner').split('↔')[1]?.trim()||'conversation partner'} in a language-learning simulation. Scene: ${String(s.title).slice(0,100)}; goal: ${String(s.goal).slice(0,180)}; level ${String(s.level).slice(0,4)}. Target vocabulary: ${(s.words||[]).slice(0,8).join(', ')}. Continue naturally based on the user's exact reply; do not use a fixed script or supply the user's response. Keep your turn under 60 words, ask at most one question, and match the learner's level. Do not correct every error. If the user needs help, offer a short hint without giving the full answer. On or after the learner's second turn, introduce this situation naturally: ${String(s.event).slice(0,230)}. Remain in character. Do not claim to have evaluated pronunciation.`},...history]})});const data=await response.json();if(!response.ok)throw Error('AI provider unavailable');const reply=data.choices?.[0]?.message?.content;if(!reply)throw Error('Empty AI response');return res.json({reply,analysis:assessText(text),hint:s.hint,turn:n,mode:'live'})}catch{return res.json({...simulationTurn(s,turns,text),mode:'guided',notice:'Live AI paused. The guided scene continued.'})}});
app.post('/api/report',paid(),(req,res)=>{const s=req.body.scenario;if(!s||typeof s.title!=='string')return res.status(400).json({error:'Invalid scenario'});res.json(reportSession(s,Array.isArray(req.body.turns)?req.body.turns.slice(-40):[]))});
app.post('/api/coach',paid('plus'),async(req,res)=>{if(!process.env.OPENAI_API_KEY)return res.status(503).json({error:'Live AI is not configured on this deployment.'});const messages=Array.isArray(req.body.messages)?req.body.messages.slice(-16).map(m=>({role:m.role==='assistant'?'assistant':'user',content:String(m.content||'').slice(0,1500)})):[];if(!messages.length)return res.status(400).json({error:'Write something to the coach.'});try{const response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4o-mini',temperature:.7,messages:[{role:'system',content:`You are a warm, rigorous English tutor for a learner at ${String(req.body.level||'A2').slice(0,6)}. Respond mainly in English. Adapt to the learner's goal ${String(req.body.goal||'everyday English').slice(0,80)}. Continue natural conversation. Correct only important errors, prefer a hint and self-retry, never invent a proficiency score or claim phoneme-level analysis. Keep responses under 90 words and ask one useful follow-up. If asked for Arabic explanation, give a concise Arabic explanation.`},...messages]})});const data=await response.json();if(!response.ok)throw Error('AI provider unavailable');res.json({reply:data.choices?.[0]?.message?.content||'Could you say that another way?'})}catch{res.status(502).json({error:'The coach is temporarily unavailable.'})}});
// Prometheus metrics (requires METRICS_TOKEN). Gauges are collected at scrape time.
app.get('/api/metrics',metricsHandler(async()=>{const s=(await customer.db()).stats?.()||{},r=limiter.status(),h=hub.status();return{
  db_pool_connections_total:{value:s.total,help:'PostgreSQL pool: open connections.'},
  db_pool_connections_idle:{value:s.idle,help:'PostgreSQL pool: idle connections.'},
  db_pool_waiting_requests:{value:s.waiting,help:'PostgreSQL pool: queries waiting for a connection (saturation).'},
  ratelimit_degraded:{value:r.degraded?1:0,help:'1 when the shared (Redis) rate limiter is unavailable and memory fallback is active.'},
  rooms_local_active:{value:h.localRooms,help:'Group rooms with members connected to this instance.'},
  websocket_clients:{value:wss.clients.size,help:'Open WebSocket connections on this instance.'}}}));
// Unknown API paths are JSON 404s (never the SPA page with status 200).
app.use('/api',(_req,res)=>res.status(404).json({error:'Not found'}));
app.use(errorHandler());
app.use(express.static(join(root,'dist'),{maxAge:'1h'}));app.get('*',(_req,res)=>res.sendFile(join(root,'dist/index.html')));
// Group practice rooms (WebSocket). Coordination is delegated to the room hub: Redis-backed when REDIS_URL is set,
// so learners connected to different app instances share one room and the 4-person cap holds globally.
const hub=createRoomHub();
const wss=new WebSocketServer({server,path:'/api/rooms',maxPayload:4096});
const safeName=v=>String(v||'').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,24)||'Learner';
const ROOM_MSG_LIMIT=20,ROOM_MSG_WINDOW=10000;
const memberList=async code=>(await hub.members(code)).map(m=>m.name);
wss.on('connection',async(ws,req)=>{
  if(customer.enforcementEnabled()&&!await customer.hasAccess(req)){ws.close(1008,'Subscription required');return}
  const u=new URL(req.url,'http://localhost');
  const code=(u.searchParams.get('code')||'').replace(/[^A-Z0-9]/gi,'').slice(0,8).toUpperCase();
  if(code.length<4){ws.close(1008,'Invalid room');return}
  // Prefer the authenticated account's name; the query parameter is only a fallback for open deployments.
  let accountName=null;try{const s=await customer.sessionFromRequest(req);if(s)accountName=s.user.name?.split(/\s+/)[0]}catch{}
  const name=safeName(accountName||u.searchParams.get('name'));
  const member={id:randomUUID(),name};
  const joined=await hub.join(code,member,ws);
  if(!joined.ok){ws.close(1008,'Room full');return}
  ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true});
  let sent=[];
  await hub.publish(code,{type:'members',members:await memberList(code)});
  ws.on('message',async raw=>{
    const now=Date.now();sent=sent.filter(t=>now-t<ROOM_MSG_WINDOW);
    if(sent.length>=ROOM_MSG_LIMIT){if(ws.readyState===1)ws.send(JSON.stringify({type:'notice',text:'You are sending messages too quickly. Please wait a moment.'}));return}
    let msg;try{msg=JSON.parse(raw)}catch{return}
    if(msg.type!=='message')return;
    const text=String(msg.text||'').trim().slice(0,600);if(!text)return;
    sent.push(now);
    await hub.publish(code,{type:'message',name,text,time:now});
    if(/\b(help|hint)\b/i.test(text)&&(await hub.members(code)).length>1)await hub.publish(code,{type:'coach',text:'Try asking a follow-up question, then give your partner time to answer.'});
  });
  ws.on('close',async()=>{await hub.leave(code,member.id);await hub.publish(code,{type:'members',members:await memberList(code)})});
});
// Liveness: terminate sockets that stop answering pings so they release their room seat.
const roomPing=setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue}ws.isAlive=false;try{ws.ping()}catch{}}},30000);
wss.on('close',()=>clearInterval(roomPing));
// Open the database (migrations + one-time legacy import) before accepting traffic, so a broken database fails the
// start instead of the first request. The listener then serves; readiness reflects storage health.
let shuttingDown=false;
customer.db().then(()=>server.listen(port,'0.0.0.0',()=>log('info','listening',{port,storage:customer.storageBackend()})))
  .catch(e=>{log('error','database unavailable at startup',{error:e.message});process.exit(1)});
// Graceful shutdown (systemd SIGTERM, Ctrl+C, or an IPC 'shutdown' message from a supervising process/test):
// stop accepting connections, let in-flight requests finish (max 5 s), close sockets, rooms, limiter and the database.
async function shutdown(reason){
  if(shuttingDown)return;shuttingDown=true;
  log('info','shutting down',{reason});
  const force=setTimeout(()=>process.exit(0),5000);force.unref();
  try{for(const ws of wss.clients)ws.close(1001,'Server restarting');await new Promise(r=>server.close(()=>r()));}catch{}
  try{await hub.close()}catch{}
  try{await limiter.close()}catch{}
  try{await customer.storageClose()}catch{}
  process.exit(0);
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('message',m=>{if(m==='shutdown')shutdown('ipc')});
