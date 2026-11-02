import {getAssessment,gradeAssessment,assessText,nextActivity,simulationTurn,reportSession,packs} from '../../server/engine.js';
export async function previewApi(path,body){switch(path){
case 'health':return {ok:true,coachConfigured:false,languagePacks:Object.keys(packs)};
case 'assessment':return body?gradeAssessment(body.answers||{}):{questions:getAssessment()};
case 'feedback':return assessText(String(body?.text||''));
case 'recommendation':return nextActivity(body?.profile||{});
case 'simulation':return {...simulationTurn(body.scenario,body.turns||[],body.text||''),mode:'guided'};
case 'report':return reportSession(body.scenario,body.turns||[]);
case 'coach':throw Error('Live AI is available in the EC2 build when configured.');
case 'leads':{
  const name=String(body?.name||'').trim(),email=String(body?.email||'').trim(),phone=String(body?.phone||'').trim();
  if(name.length<2||!/^\S+@\S+\.\S+$/.test(email)||phone.replace(/\D/g,'').length<8)throw Error('راجع الاسم والبريد ورقم الهاتف.');
  const reference='DEMO-'+Math.random().toString(36).slice(2,10).toUpperCase();
  const previous=JSON.parse(localStorage.getItem('usam.language.demoLeads')||'[]');
  localStorage.setItem('usam.language.demoLeads',JSON.stringify([{...body,reference,createdAt:new Date().toISOString()},...previous].slice(0,20)));
  return {ok:true,reference,previewOnly:true};
}
default:throw Error('This interaction needs the EC2 backend.');}}
