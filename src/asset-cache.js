const DATABASE='splurt-atlas-assets-v1';
export class AssetCache {
  constructor(scope,onStatus=()=>{},onActivity=()=>{}) {
    this.onActivity=onActivity;
    this.scope=scope;this.onStatus=onStatus;this.pending=new Map();this.mode=null;this.currentMap=null;this.version='';this.warmRun=0;this.storageFull=false;this.buffer=new Map();this.writeTimer=0;this.flushing=null;
    try{const saved=localStorage.getItem('atlas-storage-mode');if(['all','current','none'].includes(saved))this.mode=saved;this.currentMap=localStorage.getItem('atlas-storage-map');}catch{}
    this.database=new Promise(resolve=>{
      if(!globalThis.indexedDB){resolve(null);return;}
      const request=indexedDB.open(DATABASE,2);
      request.onupgradeneeded=()=>{for(const store of ['assets','archives'])if(!request.result.objectStoreNames.contains(store))request.result.createObjectStore(store,{keyPath:'key'});};
      request.onblocked=()=>this.onStatus('Close other atlas tabs to finish upgrading offline storage.');
      request.addEventListener('success',()=>{request.result.onversionchange=()=>request.result.close();});
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>{this.onStatus('Local storage is unavailable; using the network.');resolve(null);};
    });
    this.keysReady=this.database.then(db=>new Promise(resolve=>{if(!db){this.keys=null;resolve(null);return;}const request=db.transaction('assets').objectStore('assets').getAllKeys();request.onsuccess=()=>{this.keys=new Set(request.result);resolve(this.keys);};request.onerror=()=>{this.keys=null;resolve(null);};}));
  }
  async read(key){if(this.buffer.has(key))return this.buffer.get(key);const db=await this.database;if(!db)return null;const keys=await this.keysReady;if(keys&&!keys.has(key))return null;return new Promise(resolve=>{const r=db.transaction('assets').objectStore('assets').get(key);r.onsuccess=()=>resolve(r.result?.blob||null);r.onerror=()=>resolve(null);});}
  async write(key,blob){const db=await this.database;if(!db||this.storageFull||!this.canStoreKey(key))return;return new Promise(resolve=>{const tx=db.transaction('assets','readwrite',{durability:'relaxed'});tx.objectStore('assets').put({key,blob,bytes:blob.size});tx.oncomplete=()=>{this.keys?.add(key);resolve();};tx.onerror=tx.onabort=()=>{this.storageFull=true;this.onStatus('Storage is full or unavailable. Existing saved maps remain usable.');resolve();};});}
  queueWrite(key,blob){if(this.storageFull)return;this.buffer.set(key,blob);if(!this.writeTimer)this.writeTimer=setTimeout(()=>{this.writeTimer=0;this.flushWrites();},35);if(this.buffer.size>=64)this.flushWrites();}
  async flushWrites(){
    if(this.flushing){await this.flushing;if(this.buffer.size)return this.flushWrites();return;}
    if(this.writeTimer){clearTimeout(this.writeTimer);this.writeTimer=0;}
    this.flushing=(async()=>{
      const db=await this.database;if(!db||this.storageFull){this.buffer.clear();return;}
      for(const key of this.buffer.keys())if(!this.canStoreKey(key))this.buffer.delete(key);
      const batch=[...this.buffer];if(!batch.length)return;
      await new Promise(resolve=>{const tx=db.transaction('assets','readwrite',{durability:'relaxed'}),store=tx.objectStore('assets');for(const [key,blob]of batch)store.put({key,blob,bytes:blob.size});tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>{this.storageFull=true;this.onStatus('Storage is full or unavailable. Existing saved maps remain usable.');resolve();};});
      for(const [key,blob]of batch){if(!this.storageFull)this.keys?.add(key);if(this.buffer.get(key)===blob)this.buffer.delete(key);}
    })();
    await this.flushing;this.flushing=null;if(this.buffer.size)return this.flushWrites();
  }
  get enabled(){return this.mode==='all'||this.mode==='current';}
  setManifest(manifest){this.version=manifest.buildId||manifest.commit;this.mapVersions=new Map(manifest.maps.map(map=>[map.id,map.assetVersion||this.version]));}
  versionFor(path){return this.mapVersions?.get(path.split('/')[0])||this.version;}
  canStore(path){return this.mode==='all'||(this.mode==='current'&&this.currentMap&&path.startsWith(this.currentMap+'/'));}
  canStoreKey(key){const prefix=this.scope+':';if(!this.enabled||!key.startsWith(prefix))return false;if(key===`${prefix}catalog`)return true;const suffix=key.slice(prefix.length),split=suffix.indexOf(':'),file=suffix.slice(split+1);return split>0&&suffix.slice(0,split)===this.versionFor(file)&&this.canStore(file);}
  stopWarm(){this.warmRun++;this.warmAbort?.abort();}
  setMode(mode){if(!['all','current','none'].includes(mode))throw new Error('Invalid storage mode');this.mode=mode;this.stopWarm();try{localStorage.setItem('atlas-storage-mode',mode);}catch{}this.onStatus(mode==='none'?'Offline storage is off.':mode==='current'?'Preparing current map storage...':'Preparing offline maps...');}
  setCurrentMap(id){if(this.currentMap!==id){this.currentMap=id;if(this.mode!=='all')this.stopWarm();if(this.archiveWarming)this.onActivity(true,{currentReady:!!this.readyMaps?.has(id)});if(this.mode==='current')this.onStatus('Preparing current map storage...');try{localStorage.setItem('atlas-storage-map',id||'');}catch{}}}
  async prune(){
    const db=await this.database;await this.keysReady;if(this.flushing)await this.flushing;if(!db||!this.mode)return;
    const prefix=this.scope+':';
    const keep=key=>this.canStoreKey(key);
    for(const key of this.buffer.keys())if(key.startsWith(prefix)&&!keep(key))this.buffer.delete(key);
    await new Promise(resolve=>{const tx=db.transaction('archives','readwrite'),request=tx.objectStore('archives').openCursor();request.onsuccess=()=>{const cursor=request.result;if(cursor){if(cursor.key.startsWith(prefix)&&!keep(cursor.key))cursor.delete();cursor.continue();}};tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();});
    const obsolete=[...(this.keys||[])].filter(key=>key.startsWith(prefix)&&!keep(key));if(!obsolete.length)return;
    await new Promise(resolve=>{const tx=db.transaction('assets','readwrite'),store=tx.objectStore('assets');for(const key of obsolete)store.delete(key);tx.oncomplete=()=>{for(const key of obsolete)this.keys.delete(key);resolve();};tx.onerror=tx.onabort=()=>resolve();});
  }
  async catalog(url){
    const key=`${this.scope}:catalog`;
    try{const r=await fetch(url,{cache:'no-cache'});if(!r.ok)throw new Error(`Archive: HTTP ${r.status}`);const blob=await r.blob();if(this.enabled)await this.write(key,blob);return JSON.parse(await blob.text());}
    catch(error){const cached=this.enabled&&await this.read(key);if(cached)return JSON.parse(await cached.text());throw error;}
  }
  async get(url,path,priority='auto'){
    const key=`${this.scope}:${this.versionFor(path)}:${path}`;
    if(this.pending.has(key))return this.pending.get(key);
    const task=(async()=>{
      const stored=this.canStore(path)&&await this.read(key);if(stored)return stored;
      const response=await fetch(url,{priority:this.priorityPaths?.has(path)?'high':priority==='low'&&!this.activeView?'auto':priority});if(!response.ok)throw new Error(`${path}: HTTP ${response.status}`);
      const blob=await response.blob();if(this.canStore(path)){if(priority==='low')this.queueWrite(key,blob);else await this.write(key,blob);}return blob;
    })();
    this.pending.set(key,task);try{return await task;}finally{this.pending.delete(key);}
  }
  async archiveRecord(key,record){
    const db=await this.database;if(!db)return null;
    if(record&&!this.canStoreKey(key))return null;
    return new Promise((resolve,reject)=>{const tx=db.transaction('archives',record?'readwrite':'readonly'),store=tx.objectStore('archives');
      const request=record?store.put({key,...record}):store.get(key);let value;request.onsuccess=()=>{value=request.result;};
      tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Archive storage failed'));
    });
  }
  async deleteArchive(key){
    const db=await this.database;if(!db)return;
    return new Promise((resolve,reject)=>{const tx=db.transaction('archives','readwrite');tx.objectStore('archives').delete(key);tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error||new Error('Could not remove extracted ZIP'));});
  }
  async unpack(blob,onBatch,signal,priorities=[]){
    if(typeof Worker==='undefined'){const {extractArchive}=await import('./archive-extract.js');return extractArchive(blob,onBatch,()=>signal.aborted,priorities);}
    return new Promise((resolve,reject)=>{
      const worker=new Worker(new URL('./archive-worker.js',import.meta.url),{type:'module'});
      const finish=error=>{worker.terminate();signal.removeEventListener('abort',abort);error?reject(error):resolve();};
      const abort=()=>finish(new DOMException('Offline saving interrupted','AbortError'));
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
      worker.onerror=event=>finish(new Error(event.message||'Archive extraction failed'));
      worker.onmessage=async({data})=>{if(data.error){finish(new Error(data.error));return;}if(data.done){finish();return;}
        try{await onBatch(data.batch,data.complete,data.total);if(!signal.aborted)worker.postMessage({ack:true});}catch(error){finish(error);}
      };
      worker.postMessage({blob,priorities});
    });
  }
  async warmArchives(manifest,base){
    if(this.archiveWarming)return this.archiveWarming;
    this.archiveWarming=this.saveArchives(manifest,base);try{await this.archiveWarming;}finally{this.archiveWarming=null;}
  }
  async saveArchives(manifest,base){
    const run=++this.warmRun,controller=new AbortController();this.warmAbort=controller;const signal=controller.signal;
    this.readyMaps=new Set();this.onActivity(true,{currentReady:false});
    const stopped=()=>signal.aborted||run!==this.warmRun||!this.enabled;
    try{
      await this.prune();if(stopped())return;
      const maps=this.mode==='all'?[...manifest.maps]:manifest.maps.filter(map=>map.id===this.currentMap);
      if(!maps.length){this.onStatus('Choose a map to save it on this device.');return;}
      const work=map=>(map.archive.bytes||1)+(map.bytes||map.archive.bytes||1),totalWork=maps.reduce((sum,map)=>sum+work(map),0);
      let completedWork=0,completedMaps=0,cachedWork=0;const started=performance.now();
      const report=(message,map,activity,fraction=0)=>{
        fraction=Math.max(0,Math.min(1,fraction));
        const download=map.archive.bytes||1,extract=map.bytes||download,partial=activity==='download'?download*fraction:activity==='extract'?download+extract*fraction:0;
        const elapsed=(performance.now()-started)/1000,processed=completedWork-cachedWork+partial,remaining=Math.max(0,totalWork-completedWork-partial);
        this.onStatus(message,{activity,stepPercent:Math.round(fraction*100),overallPercent:Math.min(completedMaps===maps.length?100:99,Math.round((completedWork+partial)/totalWork*100)),completedMaps,totalMaps:maps.length,remainingMaps:maps.length-completedMaps,remainingSeconds:completedMaps===maps.length?0:elapsed>=2&&completedWork>cachedWork&&processed>0?elapsed*remaining/processed:null});
      };
      for(let index=0;index<maps.length;index++){
        const preferred=maps.findIndex((map,position)=>position>=index&&map.id===this.currentMap);
        if(preferred>index)maps.splice(index,0,maps.splice(preferred,1)[0]);
        const map=maps[index],key=`${this.scope}:${this.versionFor(map.id+'/')}:${map.id}/archive.zip`;
        this.onActivity(true,{currentReady:this.readyMaps.has(this.currentMap)});
        if(stopped()||this.storageFull)return;
        report(`Checking saved ${map.name} (${index+1}/${maps.length})...`,map,'check');
        let record=await this.archiveRecord(key);
        // Complete extracted maps need no ZIP. Clean up archives left by older versions too.
        const inventory=await this.read(`${this.scope}:${this.versionFor(map.assets)}:${map.assets}`);
        if(inventory){const assets=JSON.parse(await inventory.text());if(assets.length&&assets.every(asset=>this.keys?.has(`${this.scope}:${this.versionFor(map.id+'/')}:${map.id}/${asset.path}`))){if(record)await this.deleteArchive(key);this.readyMaps.add(map.id);completedWork+=work(map);cachedWork+=work(map);completedMaps++;report(`${map.name} is already saved.`,map,'check',1);continue;}}
        if(stopped())return;
        let blob=record?.blob;
        if(!blob){
          report(`Downloading ${map.name} ZIP (${index+1}/${maps.length})...`,map,'download');
          const response=await fetch(new URL(map.archive.path,base),{signal,priority:'low'});if(!response.ok)throw new Error(`${map.name}: HTTP ${response.status}`);
          const chunks=[];let received=0,last=0;const reader=response.body?.getReader();
          if(reader){while(true){const {value,done}=await reader.read();if(done)break;chunks.push(value);received+=value.byteLength;const now=performance.now();if(now-last>200&&!stopped()){last=now;report(`Downloading ${map.name} ZIP (${index+1}/${maps.length}): ${Math.round(received/1048576)} / ${Math.round(map.archive.bytes/1048576)} MB`,map,'download',received/map.archive.bytes);}}blob=new Blob(chunks,{type:'application/zip'});}else blob=await response.blob();
          if(stopped())return;if(blob.size!==map.archive.bytes)throw new Error(`${map.name}: incomplete ZIP download`);
          await this.archiveRecord(key,{blob,complete:false});
        }
        if(stopped())return;
        report(`Extracting ${map.name} (${index+1}/${maps.length}): 0%`,map,'extract');
        const priorities=['map.json','search.json',...(this.priorityPaths||[])].filter(path=>!path.includes('/')||path.startsWith(map.id+'/')).map(path=>path.startsWith(map.id+'/')?path.slice(map.id.length+1):path);
        try{await this.unpack(blob,async(batch,complete,total)=>{
          if(stopped())throw new DOMException('Offline saving interrupted','AbortError');
          for(const item of batch){const path=`${map.id}/${item.path}`,assetKey=`${this.scope}:${this.versionFor(path)}:${path}`;if(!this.keys?.has(assetKey))this.queueWrite(assetKey,item.blob);}
          await this.flushWrites();if(this.storageFull)throw new Error('Storage is full');
          if(!stopped())report(`Extracting ${map.name} (${index+1}/${maps.length}): ${Math.round(complete/total*100)}%`,map,'extract',complete/total);
        },signal,priorities);}catch(error){if(error.name!=='AbortError'&&!this.storageFull){const db=await this.database;await new Promise(resolve=>{const tx=db.transaction('archives','readwrite');tx.objectStore('archives').delete(key);tx.oncomplete=tx.onerror=tx.onabort=()=>resolve();});}throw error;}
        // Every batch transaction has committed before unpack() resolves.
        await this.deleteArchive(key);this.readyMaps.add(map.id);if(stopped())return;
        completedWork+=work(map);completedMaps++;
      }
      if(!stopped())report(`${this.mode==='all'?`All ${maps.length} maps`:'Current map'} saved for reopening. Temporary ZIPs removed.`,maps.at(-1),'complete',1);
    }catch(error){if(!stopped())this.onStatus(`Offline saving paused: ${error.message}. Reopening will retry.`);}
    finally{if(this.warmAbort===controller)this.warmAbort=null;this.onActivity(false);}
  }
  async warm(manifest,base){
    if(!this.enabled){await this.prune();return;}
    if(!await this.database){this.onStatus('Local storage is unavailable; offline saving is paused.');return;}
    if(manifest.maps.every(map=>map.archive)){
      if(this.archiveWarming){await this.archiveWarming;if(!this.enabled)return;}
      return this.warmArchives(manifest,base);
    }
    const run=++this.warmRun;let complete=0,total=0,bytes=0;
    await this.prune();if(run!==this.warmRun)return;
    const maps=this.mode==='all'?manifest.maps:manifest.maps.filter(map=>map.id===this.currentMap);
    if(!maps.length){this.onStatus('Choose a map to save it on this device.');return;}
    try{
      const lists=await Promise.all(maps.map(async map=>{
        if(!map.assets)return[];
        const blob=await this.get(new URL(map.assets,base),map.assets);return JSON.parse(await blob.text()).map(asset=>({...asset,path:`${map.id}/${asset.path}`}));
      }));
      const assets=lists.flat();total=assets.length;let cursor=0,last=0;
      const totalBytes=assets.reduce((n,item)=>n+item.bytes,0);
      const worker=async()=>{while(this.enabled&&!this.storageFull&&run===this.warmRun&&cursor<assets.length){if(this.foregroundBusy){await new Promise(resolve=>setTimeout(resolve,100));continue;}const item=assets[cursor++],key=`${this.scope}:${this.versionFor(item.path)}:${item.path}`;if(!(await this.keysReady)?.has(key)&&!this.buffer.has(key))await this.get(new URL(item.path,base),item.path,'low');complete++;bytes+=item.bytes;const now=performance.now();if(this.enabled&&run===this.warmRun&&!this.storageFull&&(now-last>200||complete===total)){last=now;this.onStatus(`Saving ${this.mode==='all'?'all maps':'current map'}: ${Math.round(complete/total*100)}% · ${Math.round(bytes/1048576)} / ${Math.round(totalBytes/1048576)} MB`);}}};
      await Promise.all(Array.from({length:4},worker));
      await this.flushWrites();if(this.enabled&&!this.storageFull&&run===this.warmRun&&complete===total)this.onStatus(`${this.mode==='all'?`All ${maps.length} maps`:'Current map'} saved for reopening (${Math.round(bytes/1048576)} MB).`);
    }catch(error){if(run===this.warmRun)this.onStatus(`Offline saving paused: ${error.message}. Reopening will retry.`);}
  }
}
