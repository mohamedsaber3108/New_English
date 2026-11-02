import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'usam-language-')),port=4199,origin=`http://127.0.0.1:${port}`,admin='a'.repeat(40);
const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:String(port),CUSTOMER_DB_FILE:join(dir,'customers.json'),LEADS_FILE:join(dir,'leads.jsonl'),ADMIN_ACCESS_TOKEN:admin,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
let cookie='';const call=async(path,{method='GET',body,auth}={})=>{const r=await fetch(origin+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...(auth?{Authorization:`Bearer ${auth}`}:{})},body:body?JSON.stringify(body):undefined});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];let data={};try{data=await r.json()}catch{}return {r,data}};
try{for(let i=0;i<40;i++){try{if((await call('/api/health')).r.ok)break}catch{}await new Promise(r=>setTimeout(r,100))}
let x=await call('/api/customer/register',{method:'POST',body:{name:'Test Learner',email:'learner@example.com',phone:'01000000000',password:'correct-horse-battery'}});if(x.r.status!==201)throw Error('register '+x.r.status);
if(!(await call('/api/customer/me')).r.ok)throw Error('me');
if(!(await call('/api/customer/preferences',{method:'PUT',body:{product:true,learning:false,marketing:true}})).r.ok)throw Error('preferences');
if((await call('/api/customer/support',{method:'POST',body:{category:'technical',subject:'Smoke test',message:'A useful test support message'}})).r.status!==201)throw Error('support');
const cat=await call('/api/customer/catalog');if(!cat.r.ok)throw Error('catalog');if(cat.data.prices?.essential?.monthly!==300||cat.data.prices?.essential?.yearly!==3000||cat.data.prices?.plus?.monthly!==450||cat.data.prices?.plus?.yearly!==4500)throw Error('catalog prices (server is the source of truth) changed unexpectedly: '+JSON.stringify(cat.data.prices));
if((await call('/api/customer/orders',{method:'POST',body:{plan:'essential',term:'monthly',language:'English'}})).r.status!==201)throw Error('order');
if((await call('/api/admin/overview')).r.status!==401)throw Error('admin deny');
if(!(await call('/api/admin/overview',{auth:admin})).r.ok)throw Error('admin allow');
if(!(await call('/api/customer/logout',{method:'POST'})).r.ok)throw Error('logout');
if((await call('/api/customer/me')).r.status!==401)throw Error('logout session');
console.log('API smoke test passed');
}finally{child.kill('SIGTERM');await rm(dir,{recursive:true,force:true})}
