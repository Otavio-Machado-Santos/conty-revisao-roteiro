import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';
const copy=resolve(process.argv[2]);
const output=process.argv[3];
const {ReviewService}=await import(pathToFileURL(join(copy,'src/review.js')));
const {ScriptStore}=await import(pathToFileURL(join(copy,'src/store.js')));
const {createHttpServer}=await import(pathToFileURL(join(copy,'src/server.js')));
const dir=mkdtempSync(join(tmpdir(),'conty03-reviewA-renewal-'));
const report={reviewed_sha:'db12564279a7ab18d3c7e99759f24c69a6a78227',passed:false,boundaries:[],errors:[],http:[]};
let server;
function fixture(label,start){
  let instant=start,serial=0,saves=0;
  const path=join(dir,label+'.json');
  const store=new ScriptStore({path});
  const save=store.save;
  store.save=function(value){saves++;return save.call(this,value)};
  const service=new ReviewService({store,clock:()=>new Date(instant),idFactory:()=>label+'-'+(++serial)});
  return {path,store,service,setClock:v=>{instant=v},saveCount:()=>saves};
}
function bytes(path){return readFileSync(path,'utf8')}
function snapshot(f,id){const stat=statSync(f.path);return {record:f.store.get(id),bytes:bytes(f.path),mtimeMs:stat.mtimeMs,saves:f.saveCount()}}
function unchanged(f,id,before){assert.deepEqual(snapshot(f,id),before)}
function rejected(f,id,fn,code,status,label){
  const before=snapshot(f,id);
  assert.throws(fn,e=>e.code===code&&e.status===status,label);
  unchanged(f,id,before);
  report.errors.push({label,code,status,stored_record_bytes_mtime_and_save_count_unchanged:true});
}
const brandInput=(deadline,reason='Motivo inicial',version=1)=>({brand_id:'b',expected_version:version,reason,deadline});
const creatorInput=(version=1)=>({creator_id:'c',expected_version:version,content:'Conteúdo revisado'});
try{
  for(const [day,start,last,first,next] of [
    ['2026-10-09','2026-10-10T01:30:00.000Z','2026-10-10T02:59:59.999Z','2026-10-10T03:00:00.000Z','2026-10-10'],
    ['2026-12-31','2027-01-01T01:00:00.000Z','2027-01-01T02:59:59.999Z','2027-01-01T03:00:00.000Z','2027-01-01'],
    ['2018-11-04','2018-11-04T12:00:00.000Z','2018-11-05T01:59:59.999Z','2018-11-05T02:00:00.000Z','2018-11-05'],
  ]){
    const f=fixture('boundary-'+day,start);
    const created=f.service.create({creator_id:'c',brand_id:'b',content:'Original '+day});
    assert.equal(created.change_request_status,null);
    const requested=f.service.requestChanges(created.id,brandInput(day));
    assert.equal(requested.versions[0].change_request.valid_until,last);
    assert.equal(requested.versions[0].change_request.expires_at,first);
    f.setClock(last);
    const before=snapshot(f,created.id);
    assert.equal(f.service.get(created.id).change_request_status,'active');
    unchanged(f,created.id,before);
    rejected(f,created.id,()=>f.service.requestChanges(created.id,brandInput(next)),'INVALID_STATE',409,'active cannot be overwritten '+day);
    f.setClock(first);
    assert.equal(f.service.get(created.id).change_request_status,'expired');
    unchanged(f,created.id,before);
    rejected(f,created.id,()=>f.service.submitVersion(created.id,creatorInput()),'DEADLINE_EXPIRED',409,'first expired creator '+day);
    const renewed=f.service.requestChanges(created.id,brandInput(next,'Motivo renovado'));
    assert.equal(renewed.change_request_status,'active');
    assert.equal(renewed.current_version,1);
    assert.equal(renewed.versions.length,1);
    assert.deepEqual(renewed.history.slice(0,2),requested.history);
    assert.equal(renewed.history.length,3);
    assert.equal(renewed.history[2].at,first);
    assert.equal(renewed.history[2].actor_id,'b');
    // Uma instância independente confirma que o último ms permite reenvio.
    const accept=fixture('last-submit-'+day,start);
    const ac=accept.service.create({creator_id:'c',brand_id:'b',content:'Original final'});
    accept.service.requestChanges(ac.id,brandInput(day));
    accept.setClock(last);
    const sent=accept.service.submitVersion(ac.id,creatorInput());
    assert.equal(sent.current_version,2);
    assert.equal(sent.change_request_status,null);
    report.boundaries.push({day,last,first,active_until_last_ms:true,expired_at_first_ms:true,renewal_at_first_ms:true,submission_at_last_ms:true,history_prefix_preserved:true});
  }

  const f=fixture('full-flow','2026-10-10T01:30:00.000Z');
  const created=f.service.create({creator_id:'c',brand_id:'b',content:'Versão original\nAinda preservada'});
  const firstRequest=f.service.requestChanges(created.id,brandInput('2026-10-09'));
  const id=created.id;
  f.setClock('2026-10-10T03:00:00.000Z');
  const original=snapshot(f,id);
  const expired=f.service.get(id);
  assert.equal(expired.change_request_status,'expired');
  assert.equal(expired.state,'changes_requested');
  assert.equal('change_request_status' in JSON.parse(original.bytes).scripts[0],false);
  unchanged(f,id,original);
  const renewal=brandInput('2026-10-10','Pedido 2');
  const invalidCases=[
    ['wrong brand',{...renewal,brand_id:'other'},'WRONG_ACTOR',403],
    ['stale version',{...renewal,expected_version:2},'STALE_VERSION',409],
    ['string version',{...renewal,expected_version:'1'},'INVALID_INPUT',422],
    ['missing version',{...renewal,expected_version:undefined},'INVALID_INPUT',422],
    ['past renewed deadline',{...renewal,deadline:'2026-10-09'},'DEADLINE_EXPIRED',422],
    ['impossible day',{...renewal,deadline:'2026-02-30'},'INVALID_INPUT',422],
    ['missing deadline',{...renewal,deadline:undefined},'INVALID_INPUT',422],
    ['missing reason',{...renewal,reason:undefined},'INVALID_INPUT',422],
    ['blank reason',{...renewal,reason:' \n '},'INVALID_INPUT',422],
    ['null reason',{...renewal,reason:null},'INVALID_INPUT',422],
    ['unknown key',{...renewal,'':true},'INVALID_INPUT',422],
  ];
  for(const [label,input,code,status] of invalidCases)rejected(f,id,()=>f.service.requestChanges(id,input),code,status,label);
  rejected(f,id,()=>f.service.submitVersion(id,{...creatorInput(),creator_id:'other'}),'WRONG_ACTOR',403,'wrong creator after expiry');
  rejected(f,id,()=>f.service.submitVersion(id,{...creatorInput(),expected_version:2}),'STALE_VERSION',409,'stale creator after expiry');
  rejected(f,id,()=>f.service.approve(id,{brand_id:'b',expected_version:1}),'INVALID_STATE',409,'approval while expired pending');
  const realSave=f.store.save;
  f.store.save=()=>{throw new Error('independent persistence failure')};
  assert.throws(()=>f.service.requestChanges(id,renewal),/independent persistence failure/);
  f.store.save=realSave;
  unchanged(f,id,original);
  report.persistence_failure={previous_record_and_bytes_preserved:true,temporary_files:readdirSync(dir).filter(x=>x.endsWith('.tmp'))};
  assert.equal(report.persistence_failure.temporary_files.length,0);

  const restarted=new ReviewService({store:new ScriptStore({path:f.path}),clock:()=>new Date('2026-10-10T03:00:00.000Z')});
  assert.deepEqual(restarted.get(id),expired);
  assert.equal(bytes(f.path),original.bytes);
  report.restart_legacy_snapshot={schema_version:1,expired_projected:true,no_migration_or_disk_write:true};
  const secondRequest=f.service.requestChanges(id,renewal);
  assert.equal(secondRequest.change_request_status,'active');
  assert.deepEqual(secondRequest.history.slice(0,2),firstRequest.history);
  rejected(f,id,()=>f.service.requestChanges(id,brandInput('2026-10-11','Overwrite')),'INVALID_STATE',409,'second active cannot overwrite');
  f.setClock('2026-10-11T03:00:00.000Z');
  const thirdRequest=f.service.requestChanges(id,brandInput('2026-10-11','Pedido 3'));
  assert.deepEqual(thirdRequest.history.slice(0,3),secondRequest.history);
  const submitted=f.service.submitVersion(id,creatorInput());
  assert.equal(submitted.current_version,2);
  assert.equal(submitted.change_request_status,null);
  assert.equal(submitted.versions[0].content,created.versions[0].content);
  assert.equal(submitted.versions[0].superseded_by,2);
  assert.equal(submitted.versions[0].change_request.reason,'Pedido 3');
  rejected(f,id,()=>f.service.approve(id,{brand_id:'b',expected_version:1}),'STALE_VERSION',409,'stale approval after renewed submission');
  f.setClock('2026-10-20T15:00:00.000Z');
  const approved=f.service.approve(id,{brand_id:'b',expected_version:2});
  assert.equal(approved.state,'approved');
  assert.equal(approved.change_request_status,null);
  assert.deepEqual(approved.history.map(x=>x.sequence),[1,2,3,4,5,6]);
  assert.deepEqual(approved.history.filter(x=>x.type==='changes_requested').map(x=>[x.reason,x.deadline,x.actor_id,x.version]),[
    ['Motivo inicial','2026-10-09','b',1],['Pedido 2','2026-10-10','b',1],['Pedido 3','2026-10-11','b',1]
  ]);
  for(const [label,fn] of [
    ['closed renewal',()=>f.service.requestChanges(id,brandInput('2026-10-21','Reopen',2))],
    ['closed submit',()=>f.service.submitVersion(id,creatorInput(2))],
    ['closed approval',()=>f.service.approve(id,{brand_id:'b',expected_version:2})],
  ])rejected(f,id,fn,'REVIEW_CLOSED',409,label);
  report.final_aggregate={state:approved.state,version:approved.current_version,version_count:approved.versions.length,history_count:approved.history.length,requests:approved.history.filter(x=>x.type==='changes_requested'),terminal:true};

  // HTTP real apenas do caminho alterado; deixa as outras rotas/casos imutáveis fora da sonda.
  const h=fixture('http-flow','2026-10-10T01:30:00.000Z');
  server=createHttpServer({service:h.service});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  let route;
  async function call(name,path,input,status,code){
    const before=route?snapshot(h,route.split('/').at(-1)):null;
    const response=await fetch(base+path,{method:input===undefined?'GET':'POST',...(input===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(input)})});
    const data=await response.json();
    assert.equal(response.status,status,name);
    if(code)assert.equal(data.error.code,code,name);
    if(status>=400)unchanged(h,route.split('/').at(-1),before);
    report.http.push({name,path,input,status:response.status,data});
    return data;
  }
  const hc=await call('create','/scripts',{creator_id:'c',brand_id:'b',content:'Original HTTP'},201);
  route='/scripts/'+hc.id;
  assert.equal(hc.change_request_status,null);
  const hr=await call('first request',route+'/change-requests',brandInput('2026-10-09'),200);
  h.setClock('2026-10-10T02:59:59.999Z');
  assert.equal((await call('GET last active',route,undefined,200)).change_request_status,'active');
  await call('no overwrite last ms',route+'/change-requests',brandInput('2026-10-10','HTTP renewal'),409,'INVALID_STATE');
  h.setClock('2026-10-10T03:00:00.000Z');
  const httpDisk=snapshot(h,hc.id);
  assert.equal((await call('GET first expired',route,undefined,200)).change_request_status,'expired');
  unchanged(h,hc.id,httpDisk);
  await call('late creator blocked',route+'/versions',creatorInput(),409,'DEADLINE_EXPIRED');
  await call('renewal past rejected',route+'/change-requests',brandInput('2026-10-09','Past'),422,'DEADLINE_EXPIRED');
  const hrenew=await call('renewal succeeds',route+'/change-requests',brandInput('2026-10-10','HTTP renewal'),200);
  assert.equal(hrenew.change_request_status,'active');
  assert.deepEqual(hrenew.history.slice(0,2),hr.history);
  await call('second active rejected',route+'/change-requests',brandInput('2026-10-10','Duplicate'),409,'INVALID_STATE');
  const hsent=await call('new version',route+'/versions',creatorInput(),201);
  assert.equal(hsent.change_request_status,null);
  await call('stale approval',route+'/approval',{brand_id:'b',expected_version:1},409,'STALE_VERSION');
  const happ=await call('approval',route+'/approval',{brand_id:'b',expected_version:2},200);
  assert.equal(happ.change_request_status,null);
  assert.equal(happ.state,'approved');
  await call('closed renewal',route+'/change-requests',brandInput('2026-10-10','Closed',2),409,'REVIEW_CLOSED');
  assert.deepEqual(await call('GET terminal',route,undefined,200),happ);
  report.http_summary={requests:report.http.length,statuses:report.http.map(x=>x.status),all_rejected_writes_preserved_storage:true};
  report.passed=true;
}finally{
  if(server){const closing=once(server,'close');server.close();server.closeAllConnections();await closing;}
  rmSync(dir,{recursive:true,force:true});
}
if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,http:report.http.map(x=>({name:x.name,status:x.status,state:x.data.state,change_request_status:x.data.change_request_status,error:x.data.error?.code}))},null,2));
