const DATABASE='splurt-atlas-assets-v1';
export class AssetCache {
  constructor(scope,onStatus=()=>{}) {
    this.scope=scope;this.onStatus=onStatus;this.pending=new Map();this.mode=null;this.currentMap=null;this.version='';this.warmRun=0;this.storageFull=false;this.buffer=new Map();this.writeTimer=0;this.flushing=null;
    try{const saved=localStorage.getItem('atlas-storage-mode');if(['all','current','none'].includes(saved))this.mode=saved;this.currentMap=localStorage.getItem('atlas-storage-map');}catch{}
    this.database=new Promise(resolve=>{
      if(!globalThis.indexedDB){resolve(null);return;}
      const request=indexedDB.open(DATABASE,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('assets',{keyPath:'key'});
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
      for(const [key,blob]of batch){this.keys?.add(key);if(this.buffer.get(key)===blob)this.buffer.delete(key);}
    })();
    await this.flushing;this.flushing=null;if(this.buffer.size)return this.flushWrites();
  }
  get enabled(){return this.mode==='all'||this.mode==='current';}
  canStore(path){return this.mode==='all'||(this.mode==='current'&&this.currentMap&&path.startsWith(this.currentMap+'/'));}
  canStoreKey(key){const prefix=`${this.scope}:${this.version}:`;return this.enabled&&(key===`${this.scope}:catalog`||(key.startsWith(prefix)&&this.canStore(key.slice(prefix.length))));}
  setMode(mode){if(!['all','current','none'].includes(mode))throw new Error('Invalid storage mode');this.mode=mode;this.warmRun++;try{localStorage.setItem('atlas-storage-mode',mode);}catch{}this.onStatus(mode==='none'?'Offline storage is off.':mode==='current'?'Preparing current map storage...':'Preparing offline maps...');}
  setCurrentMap(id){if(this.currentMap!==id){this.currentMap=id;this.warmRun++;if(this.mode==='current')this.onStatus('Preparing current map storage...');try{localStorage.setItem('atlas-storage-map',id||'');}catch{}}}
  async prune(){
    const db=await this.database;await this.keysReady;if(this.flushing)await this.flushing;if(!db||!this.mode)return;
    const prefix=this.scope+':',catalog=prefix+'catalog',revision=prefix+this.version+':';
    const keep=key=>this.enabled&&(key===catalog||(key.startsWith(revision)&&this.canStore(key.slice(revision.length))));
    for(const key of this.buffer.keys())if(key.startsWith(prefix)&&!keep(key))this.buffer.delete(key);
    const obsolete=[...(this.keys||[])].filter(key=>key.startsWith(prefix)&&!keep(key));if(!obsolete.length)return;
    await new Promise(resolve=>{const tx=db.transaction('assets','readwrite'),store=tx.objectStore('assets');for(const key of obsolete)store.delete(key);tx.oncomplete=()=>{for(const key of obsolete)this.keys.delete(key);resolve();};tx.onerror=tx.onabort=()=>resolve();});
  }
  async catalog(url){
    const key=`${this.scope}:catalog`;
    try{const r=await fetch(url,{cache:'no-cache'});if(!r.ok)throw new Error(`Archive: HTTP ${r.status}`);const blob=await r.blob();if(this.enabled)await this.write(key,blob);return JSON.parse(await blob.text());}
    catch(error){const cached=this.enabled&&await this.read(key);if(cached)return JSON.parse(await cached.text());throw error;}
  }
  async get(url,path,priority='auto'){
    const key=`${this.scope}:${this.version}:${path}`;
    if(this.pending.has(key))return this.pending.get(key);
    const task=(async()=>{
      const stored=this.canStore(path)&&await this.read(key);if(stored)return stored;
      const response=await fetch(url,{priority:priority==='low'&&!this.activeView?'auto':priority});if(!response.ok)throw new Error(`${path}: HTTP ${response.status}`);
      const blob=await response.blob();if(this.canStore(path)){if(priority==='low')this.queueWrite(key,blob);else await this.write(key,blob);}return blob;
    })();
    this.pending.set(key,task);try{return await task;}finally{this.pending.delete(key);}
  }
  async warm(manifest,base){
    if(!this.enabled){await this.prune();return;}
    if(!await this.database){this.onStatus('Local storage is unavailable; offline saving is paused.');return;}
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
      const worker=async()=>{while(this.enabled&&!this.storageFull&&run===this.warmRun&&cursor<assets.length){if(this.foregroundBusy){await new Promise(resolve=>setTimeout(resolve,100));continue;}const item=assets[cursor++],key=`${this.scope}:${this.version}:${item.path}`;if(!(await this.keysReady)?.has(key)&&!this.buffer.has(key))await this.get(new URL(item.path,base),item.path,'low');complete++;bytes+=item.bytes;const now=performance.now();if(this.enabled&&run===this.warmRun&&!this.storageFull&&(now-last>200||complete===total)){last=now;this.onStatus(`Saving ${this.mode==='all'?'all maps':'current map'}: ${Math.round(complete/total*100)}% · ${Math.round(bytes/1048576)} / ${Math.round(totalBytes/1048576)} MB`);}}};
      await Promise.all(Array.from({length:4},worker));
      await this.flushWrites();if(this.enabled&&!this.storageFull&&run===this.warmRun&&complete===total)this.onStatus(`${this.mode==='all'?`All ${maps.length} maps`:'Current map'} saved for reopening (${Math.round(bytes/1048576)} MB).`);
    }catch(error){if(run===this.warmRun)this.onStatus(`Offline saving paused: ${error.message}. Reopening will retry.`);}
  }
}
