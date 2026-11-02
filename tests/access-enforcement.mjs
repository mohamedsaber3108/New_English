// Verifies that paid-content access enforcement is INDEPENDENT of payment-provider configuration.
// Security requirement: absence of Paymob keys must NOT open paid learning content to the public (fail closed).
// Run: node tests/access-enforcement.mjs
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const admin='a'.repeat(40);

function startServer(extraEnv){
  return mkdtemp(join(tmpdir(),'usam-access-')).then(dir=>{
    const port=4200+Math.floor(Math.random()*300);
    const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:String(port),CUSTOMER_DB_FILE:join(dir,'customers.json'),LEADS_FILE:join(dir,'leads.jsonl'),ADMIN_ACCESS_TOKEN:admin,NODE_ENV:'test',...extraEnv},stdio:['ignore','pipe','pipe']});
    return {dir,port,child,origin:`http://127.0.0.1:${port}`};
  });
}

async function waitReady(origin){
  for(let i=0;i<50;i++){try{if((await fetch(origin+'/api/health')).ok)return true}catch{}await new Promise(r=>setTimeout(r,100))}
  throw Error('server did not start');
}

async function stop({child,dir}){child.kill('SIGTERM');await rm(dir,{recursive:true,force:true})}

// A paid learning endpoint. /api/feedback is gated by paid(). Without an entitlement it must be blocked when enforced.
async function callFeedback(origin,cookie){
  const r=await fetch(origin+'/api/feedback',{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify({text:'I would like to practice my English today.'})});
  return r.status;
}

let failures=0;
const assert=(cond,msg)=>{if(cond){console.log('  PASS:',msg)}else{console.error('  FAIL:',msg);failures++}};

// Case 1: default (no ACCESS_ENFORCEMENT, no Paymob keys) MUST fail closed -> anonymous paid request is rejected.
{
  const s=await startServer({});
  try{
    await waitReady(s.origin);
    const health=await (await fetch(s.origin+'/api/health')).json();
    assert(health.accessEnforcement===true,'default deployment enforces access (fail closed)');
    assert(health.paymentConfigured===false,'payment is not configured in this test');
    const status=await callFeedback(s.origin);
    assert(status===401||status===402,`anonymous paid request is blocked by default (got ${status})`);
  }finally{await stop(s)}
}

// Case 2: ACCESS_ENFORCEMENT=open MUST serve paid content without an entitlement (explicit free/preview opt-in).
{
  const s=await startServer({ACCESS_ENFORCEMENT:'open'});
  try{
    await waitReady(s.origin);
    const health=await (await fetch(s.origin+'/api/health')).json();
    assert(health.accessEnforcement===false,'ACCESS_ENFORCEMENT=open disables enforcement');
    const status=await callFeedback(s.origin);
    assert(status===200,`open mode serves paid content without entitlement (got ${status})`);
  }finally{await stop(s)}
}

// Case 3: enforced mode + a registered user WITHOUT entitlement MUST be rejected with 402 (login ok, no subscription).
{
  const s=await startServer({ACCESS_ENFORCEMENT:'enforced'});
  try{
    await waitReady(s.origin);
    const reg=await fetch(s.origin+'/api/customer/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'No Sub',email:`nosub-${Date.now()}-${Math.random().toString(36).slice(2,8)}@example.com`,phone:'01000000000',password:'correct-horse-battery'})});
    const cookie=(reg.headers.get('set-cookie')||'').split(';')[0];
    assert(reg.status===201&&cookie,'registered a user and received a session cookie');
    const status=await callFeedback(s.origin,cookie);
    assert(status===402,`logged-in user without entitlement is blocked (got ${status})`);
  }finally{await stop(s)}
}

if(failures){console.error(`\nAccess-enforcement test FAILED (${failures} assertion(s)).`);process.exit(1)}
console.log('\nAccess-enforcement test passed.');
