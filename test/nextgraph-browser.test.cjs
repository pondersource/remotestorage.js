// Real pinned web + ORM SDKs talking to a simulated wallet MessageChannel.
// This checks protocol wiring, not wallet authentication or broker persistence.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {chromium}=require('@playwright/test');
// Allow only our served scripts and a fixed nonce for fixture setup. Neither
// the standalone app nor the wallet/iframe can use unsafe-eval or unnonced scripts.
const csp={ 'Content-Security-Policy': "script-src 'self' 'nonce-rs-nextgraph-fixture'; object-src 'none'; base-uri 'none'" };
test('single all-backend bundle runs under strict CSP and the real SDK commits through the wallet channel',async t=>{
 const bundle=readFileSync(require.resolve('../release/remotestorage-all.js'));
 const appHtml=`<!doctype html><script src="/rs.js"></script><button id="connect">Connect Nextgraph</button><script nonce="rs-nextgraph-fixture">
   window.errors=[];window.rs=new RemoteStorage({cache:false,modules:[{name:'notes',builder(client){client.declareType('note',{type:'object'});return{exports:{write:(path,value)=>client.storeObject('note',path,value),read:path=>client.getObject(path)}}}}]});rs.access.claim('notes','rw');
   rs.on('error',e=>errors.push(e.message));rs.on('ready',()=>window.ready=true);
   document.querySelector('button').onclick=()=>rs.nextgraph.connect().then(()=>window.opened=true).catch(e=>errors.push(e.message));
  </script>`;
 const origin='https://app.example.test';
 const browser=await chromium.launch();t.after(()=>browser.close());
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{window.cspViolations=[];document.addEventListener('securitypolicyviolation',event=>cspViolations.push({directive:event.violatedDirective,blocked:event.blockedURI}));});
 await page.route(origin+'/**',route=>route.fulfill({headers:csp,contentType:route.request().url().endsWith('/rs.js')?'text/javascript':'text/html',body:route.request().url().endsWith('/rs.js')?bundle:appHtml}));
 await page.route('https://nextgraph.net/**',route=>route.fulfill({headers:csp,contentType:'text/html',body:`<!doctype html><iframe src="${origin}/"></iframe><script nonce="rs-nextgraph-fixture">
  window.calls=[];window.ledger={};window.ports=[];
  window.addEventListener('message',event=>{
   if(event.origin!==${JSON.stringify(origin)}||event.source!==document.querySelector('iframe').contentWindow)return;
   const {method,args}=event.data,port=event.ports[0];calls.push({method,args});
   if(method==='init'){port.postMessage({ok:true,ret:{session_id:'session',private_store_id:'private'}});return;}
   if(method==='sparql_query'){port.postMessage({ok:true,ret:{results:{bindings:[{id:{value:'did:ng:collection'}}]}}});return;}
   if(method==='orm_start_discrete'){ports.push(port);port.postMessage({stream:true,ret:{V0:{DiscreteOrmInitial:[ledger,'subscription']}}});return;}
   if(method==='discrete_orm_update'){
    if(window.failSave){port.postMessage({ok:false,ret:'Disk full'});return;}
    for(const patch of args[1]){if(patch.op!=='add'&&patch.op!=='replace')throw Error('Unexpected mutation');ledger[patch.path.slice(1)]=patch.value;}
    port.postMessage({ok:true,ret:null});return;
   }
   port.postMessage({ok:false,ret:'Unexpected native call: '+method});
  });
 </script>`}));
 await page.goto(origin);await page.waitForFunction(()=>window.ready);
 assert.equal(page.url(),origin+'/');
 assert.deepEqual(await page.evaluate(()=>cspViolations),[]);
 await page.locator('#connect').click();
 await page.waitForURL('https://nextgraph.net/**');
 assert.equal(new URLSearchParams(page.url().split('#/?')[1]).get('o'),origin+'/');
 const frame=await page.frameLocator('iframe');await frame.locator('#connect').click();
 const appFrame=page.frames().find(frame=>frame.url()===origin+'/');
 await appFrame.waitForFunction(()=>rs.nextgraph.connected);
 const first=await appFrame.evaluate(()=>rs.nextgraph.put('/notes/a','hello','text/plain'));
 assert.equal(first.statusCode,201);
 const native=await page.evaluate(()=>({calls,ledger}));
 assert.equal(native.calls.filter(c=>c.method==='discrete_orm_update').length,1);
 assert.equal(Object.keys(native.ledger).length,1);
 assert.equal(JSON.parse(Object.values(native.ledger)[0]).file.data,'aGVsbG8');
 assert.equal(native.calls.find(c=>c.method==='orm_start_discrete').args[0],'did:ng:collection');
 const json=await appFrame.evaluate(async()=>{await rs.notes.write('record.json',{title:'Native JSON'});return rs.notes.read('record.json');});
 assert.equal(json.title,'Native JSON');
 const second=await appFrame.evaluate(()=>rs.nextgraph.put('/notes/a','left','text/plain'));
 await page.evaluate(({base})=>{
  const id=crypto.randomUUID(),record={version:1,id,path:'/notes/a',parents:[base],created:Date.now(),deleted:true};
  const key='rs_revision_'+id,value=JSON.stringify(record);ledger[key]=value;
  for(const port of ports)port.postMessage({stream:true,ret:{V0:{DiscreteOrmUpdate:[{op:'add',path:'/'+key,value}]}}});
 },{base:first.revision});
 await appFrame.waitForFunction(()=>rs.nextgraph.listConflicts().length===1);
 assert.equal((await appFrame.evaluate(()=>rs.nextgraph.get('/notes/a'))).statusCode,409);
 await appFrame.evaluate(id=>rs.nextgraph.resolveConflict('/notes/a',id),second.revision);
 assert.equal((await appFrame.evaluate(()=>rs.nextgraph.get('/notes/a'))).body,'left');
 await page.evaluate(()=>window.failSave=true);
 const failed=await appFrame.evaluate(async()=>{try{await rs.nextgraph.put('/notes/b','data','text/plain');}catch(e){return {message:e.message,connected:rs.nextgraph.connected,state:rs.nextgraph.deliveryState,reload:rs.nextgraph.requiresReload};}});
 assert.match(failed.message,/Disk full/);assert.equal(failed.connected,false);assert.equal(failed.state,'needs-attention');assert.equal(failed.reload,true);
 const retry=await appFrame.evaluate(async()=>{try{await rs.nextgraph.connect();}catch(e){return e.message;}});assert.match(retry,/Reload/);
 assert.deepEqual(errors,[]);
 assert.deepEqual(await appFrame.evaluate(()=>cspViolations),[]);
 assert.deepEqual(await page.evaluate(()=>cspViolations),[]);
 // A wallet that does not return consent must not leave the app waiting forever.
 const stalled=await browser.newPage();await stalled.clock.install();
 await stalled.route(origin+'/**',route=>route.fulfill({headers:csp,contentType:route.request().url().endsWith('/rs.js')?'text/javascript':'text/html',body:route.request().url().endsWith('/rs.js')?bundle:appHtml}));
 await stalled.route('https://nextgraph.net/**',route=>route.fulfill({headers:csp,contentType:'text/html',body:'<iframe src="'+origin+'/"></iframe>'}));
 await stalled.goto('https://nextgraph.net/redir/');
 await stalled.frameLocator('iframe').locator('#connect').waitFor();
 const blocked=stalled.frames().find(frame=>frame.url()===origin+'/');
 await blocked.waitForFunction(()=>window.ready);await blocked.locator('#connect').click();
 await stalled.clock.fastForward(121000);
 await blocked.waitForFunction(()=>errors.some(message=>message.includes('timed out')));
 assert.equal(await blocked.evaluate(()=>rs.nextgraph.connected),false);
 await stalled.close();
});
