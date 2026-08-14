import { register, unregisterAll } from '@tauri-apps/plugin-global-shortcut';

const SERVER_BASE = 'https://ahmetyyilmaz.com.tr/radio/';
const IS_TAURI = !!window.__TAURI_INTERNALS__;
let registeredShortcut = null;

function codeToShortcut(code){
  if(/^Key[A-Z]$/.test(code)) return code.slice(3);
  if(/^Digit[0-9]$/.test(code)) return code.slice(5);
  if(/^F([1-9]|1[0-2])$/.test(code)) return code;
  const map={Space:'Space',Enter:'Enter',Tab:'Tab',Home:'Home',End:'End',Insert:'Insert',Delete:'Delete',PageUp:'PageUp',PageDown:'PageDown',ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight'};
  return map[code]||null;
}

async function registerGlobalPTT(code){
  if(!IS_TAURI) return;
  const shortcut=codeToShortcut(code);
  if(!shortcut) throw new Error('unsupported_ptt_key');
  await unregisterAll();
  await register(shortcut,(event)=>{
    if(!joined || waitingForKey) return;
    if(event.state==='Pressed') startPTT();
    else if(event.state==='Released') stopPTT();
  });
  registeredShortcut=shortcut;
}

const $ = s => document.querySelector(s);
const joinScreen=$('#joinScreen'), radioScreen=$('#radioScreen'), username=$('#username'), joinBtn=$('#joinBtn'), joinError=$('#joinError');
const usersEl=$('#users'), userCount=$('#userCount'), myName=$('#myName'), connBadge=$('#connBadge'), statusText=$('#statusText');
const pttBtn=$('#pttBtn'), setKeyBtn=$('#setKeyBtn'), keyLabel=$('#keyLabel'), micBtn=$('#micBtn'), micPanel=$('#micPanel'), micSelect=$('#micSelect'), applyMicBtn=$('#applyMicBtn'), testBtn=$('#testBtn'), testHint=$('#testHint');

let myId='p_'+crypto.getRandomValues(new Uint32Array(2)).join('_');
let myUsername=''; let pttKey=localStorage.getItem('radio_ptt_key')||'KeyV'; let waitingForKey=false;
let rawStream=null, sendStream=null, audioCtx=null, micGain=null, staticGain=null, dest=null, monitorDest=null;
const remoteNodes=new Map();
let polling=false, joined=false, pttActive=false, selectedMic=localStorage.getItem('radio_mic')||'', testMode=false, testAudio=null;
const peers=new Map(); // id -> {pc,name,audio}
let iceServers=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];

function keyName(code){ if(code.startsWith('Key')) return code.slice(3); if(code.startsWith('Digit')) return code.slice(5); return code.replace('Arrow',''); }
keyLabel.textContent=keyName(pttKey);

async function api(body){
  // V9: cPanel uyumlu GET; büyük WebRTC mesajları chunk edilerek gönderilir.
  // Tüm küçük signaling istekleri GET query-string ile gider.
  const q=new URLSearchParams();
  for(const [k,v] of Object.entries(body)){
    q.set(k, (v!==null && typeof v==='object') ? JSON.stringify(v) : String(v));
  }
  q.set('_', Date.now().toString());
  const r=await fetch(SERVER_BASE+'signal.php?'+q.toString(),{
    method:'GET',
    headers:{'Accept':'application/json'},
    cache:'no-store',
    credentials:'omit'
  });
  const text=await r.text();
  let data;
  try{ data=JSON.parse(text); }
  catch{ throw new Error('server_response_'+r.status+'_'+text.slice(0,120).replace(/\s+/g,' ')); }
  if(!r.ok) throw new Error(data.error||('http_'+r.status));
  return data;
}
function setStatus(t,kind=''){statusText.textContent=t;statusText.className='status-text '+kind}
function renderUsers(list){
  usersEl.innerHTML='';
  const unique=new Map(list.map(x=>[x.id,x]));
  unique.set(myId,{id:myId,name:myUsername});
  [...unique.values()].forEach(u=>{
    const d=document.createElement('div'); d.className='user-pill'+(u.talking?' talking':''); d.dataset.id=u.id;
    d.innerHTML='<span class="dot"></span><span></span>'; d.querySelector('span:last-child').textContent=u.name+(u.id===myId?' (sen)':''); usersEl.appendChild(d);
  }); userCount.textContent=unique.size;
}
function markTalking(id,on){ const el=usersEl.querySelector(`[data-id="${CSS.escape(id)}"]`); if(el) el.classList.toggle('talking',on); }

async function setupAudio(deviceId=''){
  if(rawStream) rawStream.getTracks().forEach(t=>t.stop());
  if(audioCtx) try{await audioCtx.close()}catch{}

  // En uyumlu mikrofon isteği: cihaza özel seçim başarısız olursa otomatik varsayılana düşer.
  const baseAudio={echoCancellation:true,noiseSuppression:false,autoGainControl:false};
  let constraints={audio:deviceId?{...baseAudio,deviceId:{exact:deviceId}}:baseAudio,video:false};
  try{
    rawStream=await navigator.mediaDevices.getUserMedia(constraints);
  }catch(err){
    if(deviceId){
      localStorage.removeItem('radio_mic');
      selectedMic='';
      rawStream=await navigator.mediaDevices.getUserMedia({audio:baseAudio,video:false});
    }else throw err;
  }

  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  // Join düğmesi kullanıcı hareketidir; ses çıkışını burada açmayı dene.
  try{ await audioCtx.resume(); }catch{}
  const src=audioCtx.createMediaStreamSource(rawStream);
  const hp=audioCtx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=300; hp.Q.value=.7;
  const lp=audioCtx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=3400; lp.Q.value=.8;
  const comp=audioCtx.createDynamicsCompressor(); comp.threshold.value=-26; comp.knee.value=18; comp.ratio.value=4; comp.attack.value=.006; comp.release.value=.15;
  micGain=audioCtx.createGain(); micGain.gain.value=0;
  const master=audioCtx.createGain(); master.gain.value=1.15;
  dest=audioCtx.createMediaStreamDestination();
  monitorDest=audioCtx.createMediaStreamDestination();
  src.connect(hp).connect(lp).connect(comp).connect(micGain).connect(master);
  master.connect(dest);
  master.connect(monitorDest);

  // Hafif radyo statiği; yalnızca PTT sırasında açılır.
  const noise=audioCtx.createBuffer(1,audioCtx.sampleRate*2,audioCtx.sampleRate); const data=noise.getChannelData(0);
  for(let i=0;i<data.length;i++) data[i]=(Math.random()*2-1)*0.12;
  const ns=audioCtx.createBufferSource(); ns.buffer=noise; ns.loop=true;
  const nhp=audioCtx.createBiquadFilter(); nhp.type='highpass'; nhp.frequency.value=1800;
  staticGain=audioCtx.createGain(); staticGain.gain.value=0;
  ns.connect(nhp).connect(staticGain).connect(master); ns.start();
  sendStream=dest.stream;
  for(const {pc} of peers.values()) replaceAudioTrack(pc);
  if(testMode && testAudio){ testAudio.srcObject=monitorDest?.stream||sendStream; testAudio.play().catch(()=>{}); }
}

function setTestMode(on){
  testMode=on;
  if(on){
    if(!testAudio){
      testAudio=document.createElement('audio');
      testAudio.autoplay=true;
      testAudio.playsInline=true;
      testAudio.style.display='none';
      document.body.appendChild(testAudio);
    }
    testAudio.srcObject=monitorDest?.stream||sendStream;
    testAudio.muted=false;
    testAudio.volume=1;
    testAudio.play().catch(()=>{});
    testBtn.textContent='TESTİ KAPAT';
    testBtn.classList.add('active-test');
    testHint.classList.remove('hidden');
    setStatus('Tek kişilik test açık. PTT tuşuna bas ve konuş.','good');
  }else{
    if(testAudio){ testAudio.pause(); testAudio.srcObject=null; }
    testBtn.textContent='TEK KİŞİLİK TEST';
    testBtn.classList.remove('active-test');
    testHint.classList.add('hidden');
    setStatus('Telsiz hazır.','good');
  }
}

function replaceAudioTrack(pc){
  const track=sendStream?.getAudioTracks()[0]; if(!track)return;
  const sender=pc.getSenders().find(s=>s.track&&s.track.kind==='audio');
  if(sender) sender.replaceTrack(track); else pc.addTrack(track,sendStream);
}

async function tone(freq=1200,dur=.055,vol=.18,when=0){
  if(!audioCtx)return; const o=audioCtx.createOscillator(),g=audioCtx.createGain(); o.type='square';o.frequency.value=freq;g.gain.value=vol;o.connect(g);g.connect(dest);g.connect(audioCtx.destination);const t=audioCtx.currentTime+when;o.start(t);o.stop(t+dur);
}
async function burst(dur=.09,vol=.18,when=0){
  if(!audioCtx)return; const b=audioCtx.createBuffer(1,Math.ceil(audioCtx.sampleRate*dur),audioCtx.sampleRate),d=b.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=(Math.random()*2-1);
  const s=audioCtx.createBufferSource(),f=audioCtx.createBiquadFilter(),g=audioCtx.createGain();s.buffer=b;f.type='bandpass';f.frequency.value=2400;f.Q.value=.7;g.gain.value=vol;s.connect(f).connect(g);g.connect(dest);g.connect(audioCtx.destination);s.start(audioCtx.currentTime+when);
}
function radioOpenSound(){burst(.08,.22,0);tone(1050,.055,.14,.045);tone(1450,.045,.12,.105)}
function radioCloseSound(){tone(1350,.045,.13,0);burst(.11,.2,.04)}

async function startPTT(){
  if(!joined||pttActive||waitingForKey)return; pttActive=true; await audioCtx.resume();
  pttBtn.classList.add('active'); markTalking(myId,true); radioOpenSound();
  // Beep duyulsun, hemen ardından mic gelsin.
  setTimeout(()=>{ if(pttActive){micGain.gain.setTargetAtTime(1,audioCtx.currentTime,.01);staticGain.gain.setTargetAtTime(.035,audioCtx.currentTime,.01)} },125);
  broadcastData({type:'talk',on:true});
  api({action:'talk',id:myId,on:1}).catch(()=>{});
}
function stopPTT(){
  if(!pttActive)return; pttActive=false; pttBtn.classList.remove('active'); markTalking(myId,false);
  micGain.gain.setTargetAtTime(0,audioCtx.currentTime,.008); staticGain.gain.setTargetAtTime(0,audioCtx.currentTime,.008); radioCloseSound(); broadcastData({type:'talk',on:false}); api({action:'talk',id:myId,on:0}).catch(()=>{});
}

async function loadIceServers(){
  const r=await fetch('turn.php?_='+Date.now(),{cache:'no-store',credentials:'omit'});
  let j={};
  try{ j=await r.json(); }catch{}
  if(!r.ok || !j.ok || !Array.isArray(j.iceServers) || !j.iceServers.length){
    throw new Error(j.error||'turn_load_failed');
  }
  iceServers=j.iceServers;
  console.log('Metered TURN hazır', iceServers.map(x=>x.urls));
}

function makePC(peerId, initiator=false){
  if(peers.has(peerId)) return peers.get(peerId).pc;
  const pc=new RTCPeerConnection({iceServers,iceTransportPolicy:'relay',iceCandidatePoolSize:4,bundlePolicy:'max-bundle'});
  if(sendStream) sendStream.getTracks().forEach(t=>pc.addTrack(t,sendStream));
  const rec={pc,name:peerId,audio:null,dc:null,pendingIce:[]}; peers.set(peerId,rec);
  pc.onicecandidate=e=>{if(e.candidate)sendSignal(peerId,{type:'ice',candidate:e.candidate})};
  pc.ontrack=e=>{
    const stream=e.streams[0] || new MediaStream([e.track]);
    // Uzak sesi doğrudan zaten kullanıcı tarafından açılmış WebAudio çıkışına bağla.
    // Bu, Chrome'un dinamik <audio> autoplay engeline takılmayı önler.
    try{
      if(audioCtx && !remoteNodes.has(peerId)){
        const node=audioCtx.createMediaStreamSource(stream);
        const gain=audioCtx.createGain(); gain.gain.value=1;
        node.connect(gain).connect(audioCtx.destination);
        remoteNodes.set(peerId,{node,gain});
      }
      audioCtx?.resume().catch(()=>{});
    }catch(err){ console.warn('WebAudio uzak ses bağlanamadı',err); }
    // HTMLAudio yedek çıkışı. WebAudio başarılıysa sessiz tutulur ki çift ses olmasın.
    let a=rec.audio;
    if(!a){a=document.createElement('audio');a.autoplay=true;a.playsInline=true;a.style.display='none';document.body.appendChild(a);rec.audio=a}
    a.srcObject=stream; a.muted=remoteNodes.has(peerId); a.play().catch(err=>console.warn('Uzak ses autoplay bekliyor',err));
  };
  pc.onconnectionstatechange=()=>{
    const st=pc.connectionState; console.log('Peer',peerId,st);
    if(st==='connected') setStatus('TURN SES BAĞLANTISI HAZIR.','good');
    else if(st==='connecting') setStatus('Ses bağlantısı kuruluyor…','');
    else if(st==='failed') setStatus('Ses bağlantısı yeniden deneniyor…','bad');
  };
  pc.oniceconnectionstatechange=()=>{
    console.log('ICE',peerId,pc.iceConnectionState);
    const st=pc.iceConnectionState;
    if(st==='connected'||st==='completed') setStatus('TURN SES BAĞLANTISI HAZIR (ICE '+st+').','good');
    else if(st==='failed') setStatus('TURN bağlantısı kurulamadı (ICE failed).','bad');
  };
  pc.onicecandidateerror=e=>console.warn('ICE sunucu hatası',e.url,e.errorCode,e.errorText);
  if(initiator){ const dc=pc.createDataChannel('radio'); wireDC(peerId,dc); rec.dc=dc; }
  pc.ondatachannel=e=>{rec.dc=e.channel;wireDC(peerId,e.channel)};
  return pc;
}
function wireDC(id,dc){dc.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='talk')markTalking(id,!!m.on)}catch{}}}
function broadcastData(obj){const s=JSON.stringify(obj);for(const r of peers.values())if(r.dc?.readyState==='open')r.dc.send(s)}
function b64urlEncode(str){
  const bytes=new TextEncoder().encode(str); let bin='';
  for(const b of bytes) bin+=String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function sendSignal(to,payload){
  // SDP/ICE verileri GET URL sınırına takılmasın diye küçük parçalara bölünüyor.
  const encoded=b64urlEncode(JSON.stringify(payload));
  const msg='m_'+crypto.getRandomValues(new Uint32Array(2)).join('_');
  const CHUNK=900;
  const total=Math.ceil(encoded.length/CHUNK)||1;
  for(let i=0;i<total;i++){
    await api({action:'send_chunk',id:myId,to,msg,index:i,total,data:encoded.slice(i*CHUNK,(i+1)*CHUNK)});
  }
}
async function flushIce(peerId){
  const rec=peers.get(peerId); if(!rec||!rec.pc.remoteDescription)return;
  const q=rec.pendingIce.splice(0);
  for(const c of q){try{await rec.pc.addIceCandidate(c)}catch(e){console.warn('ICE eklenemedi',e)}}
}
async function createOffer(peerId){
  const pc=makePC(peerId,true);
  const offer=await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal(peerId,{type:'offer',sdp:pc.localDescription});
}
async function handleSignal(from,p){
  const pc=makePC(from,false); const rec=peers.get(from);
  if(p.type==='offer'){
    await pc.setRemoteDescription(new RTCSessionDescription(p.sdp));
    await flushIce(from);
    const ans=await pc.createAnswer(); await pc.setLocalDescription(ans);
    await sendSignal(from,{type:'answer',sdp:pc.localDescription});
  }
  else if(p.type==='answer'){
    if(!pc.remoteDescription){await pc.setRemoteDescription(new RTCSessionDescription(p.sdp)); await flushIce(from)}
  }
  else if(p.type==='ice'){
    if(pc.remoteDescription) {try{await pc.addIceCandidate(p.candidate)}catch(e){console.warn('ICE eklenemedi',e)}}
    else rec.pendingIce.push(p.candidate);
  }
}

async function poll(){
  if(!joined||polling)return;polling=true;
  try{const r=await api({action:'poll',id:myId});if(!r.ok)throw 0;renderUsers(r.peers||[]);
    for(const m of (r.messages||[]))await handleSignal(m.from,m.payload);
    const live=new Set((r.peers||[]).map(x=>x.id)); for(const [id,rec] of peers){if(!live.has(id)){rec.pc.close();rec.audio?.remove();const rn=remoteNodes.get(id);try{rn?.node?.disconnect();rn?.gain?.disconnect()}catch{}remoteNodes.delete(id);peers.delete(id)}}
    connBadge.textContent='BAĞLI';connBadge.classList.add('online');
    if(peers.size===0) setStatus('Telsiz hazır. Tek başınasın.','good');
    else if([...peers.values()].some(r=>r.pc.connectionState==='connected')) setStatus('Ses bağlantısı kuruldu.','good');
    else setStatus('Diğer kullanıcıya ses bağlantısı kuruluyor…','');
  }catch{setStatus('Bağlantı kontrol ediliyor…','bad')} finally{polling=false;setTimeout(poll,350)}
}

joinBtn.onclick=async()=>{
  joinError.textContent='';myUsername=username.value.trim();if(!myUsername){joinError.textContent='Bir kullanıcı adı yaz.';return}
  joinBtn.disabled=true;joinBtn.textContent='BAĞLANIYOR…';
  try{
    await setupAudio(selectedMic);
    try{await audioCtx.resume()}catch{}
    await loadIceServers();
    const r=await api({action:'join',id:myId,name:myUsername});if(!r.ok){if(r.error==='full')throw new Error('full');throw new Error('join')}
    joined=true;myName.textContent=myUsername;joinScreen.classList.add('hidden');radioScreen.classList.remove('hidden');renderUsers(r.peers||[]);
    try{await registerGlobalPTT(pttKey);}catch(err){console.warn('Global PTT kaydı başarısız',err);setStatus('Bağlandı; global PTT kaydedilemedi. PTT tuşunu değiştir.','bad');}
    for(const p of (r.peers||[]))await createOffer(p.id);
    await refreshMics(); poll();
  }catch(e){
    console.error('Bağlantı hatası:',e);
    joinBtn.disabled=false;joinBtn.textContent='TELSİZE BAĞLAN';
    if(e.message==='full') joinError.textContent='Oda dolu (maksimum 4 kişi).';
    else if(['NotAllowedError','PermissionDeniedError'].includes(e.name)) joinError.textContent='Mikrofon izni engellenmiş. Adres çubuğundaki mikrofon simgesinden izin ver.';
    else if(['NotFoundError','DevicesNotFoundError'].includes(e.name)) joinError.textContent='Mikrofon bulunamadı. Windows mikrofonunu kontrol et.';
    else if(e.message==='storage_not_writable'||e.message==='storage_open_failed'||e.message==='storage_write_failed'||e.message==='storage_lock_failed') joinError.textContent='Sunucu kayıt klasörüne yazamıyor. V3 dosyalarını eksiksiz yüklediğinden emin ol.';
    else if(e.message==='turn_not_configured') joinError.textContent='TURN ayarı yapılmamış. turn-config.php içine Metered Username ve Password gir.';
    else if(e.message==='turn_config_missing') joinError.textContent='turn-config.php dosyası eksik.';
    else if(e.message==='turn_load_failed') joinError.textContent='TURN sunucu bilgileri alınamadı.';
    else if(e.message.startsWith('server_response_')||e.message.startsWith('http_')) joinError.textContent='signal.php sunucuda çalışmıyor (PHP/hosting hatası: '+e.message+').';
    else joinError.textContent='Bağlantı başlatılamadı: '+(e.message||e.name||'bilinmeyen hata');
  }
};

window.addEventListener('keydown',e=>{
  // Kullanıcı adı alanında V dahil tüm harfler normal yazılabilsin.
  if(waitingForKey){
    e.preventDefault();pttKey=e.code;localStorage.setItem('radio_ptt_key',pttKey);keyLabel.textContent=keyName(pttKey);waitingForKey=false;setKeyBtn.textContent='PTT TUŞUNU DEĞİŞTİR';if(IS_TAURI&&joined){registerGlobalPTT(pttKey).then(()=>setStatus('Global PTT: '+keyName(pttKey),'good')).catch(()=>setStatus('Bu tuş global PTT olarak kullanılamıyor. A-Z, 0-9 veya F1-F12 dene.','bad'));}return;
  }
  if(!joined) return;
  const tag=(e.target?.tagName||'').toLowerCase();
  if(tag==='input'||tag==='textarea'||tag==='select') return;
  if(!IS_TAURI && e.code===pttKey&&!e.repeat){e.preventDefault();startPTT()}
});
window.addEventListener('keyup',e=>{
  if(!joined) return;
  const tag=(e.target?.tagName||'').toLowerCase();
  if(tag==='input'||tag==='textarea'||tag==='select') return;
  if(!IS_TAURI && e.code===pttKey){e.preventDefault();stopPTT()}
});
if(!IS_TAURI) window.addEventListener('blur',()=>stopPTT());
pttBtn.addEventListener('pointerdown',e=>{e.preventDefault();pttBtn.setPointerCapture?.(e.pointerId);startPTT()});
pttBtn.addEventListener('pointerup',stopPTT);pttBtn.addEventListener('pointercancel',stopPTT);
setKeyBtn.onclick=()=>{waitingForKey=true;setKeyBtn.textContent='BİR TUŞA BAS…'};
micBtn.onclick=async()=>{micPanel.classList.toggle('hidden');if(!micPanel.classList.contains('hidden'))await refreshMics()};
testBtn.onclick=async()=>{ await audioCtx?.resume(); setTestMode(!testMode); };
async function refreshMics(){const devs=await navigator.mediaDevices.enumerateDevices();const m=devs.filter(d=>d.kind==='audioinput');micSelect.innerHTML='';m.forEach((d,i)=>{const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||`Mikrofon ${i+1}`;if(d.deviceId===selectedMic)o.selected=true;micSelect.appendChild(o)})}
applyMicBtn.onclick=async()=>{selectedMic=micSelect.value;localStorage.setItem('radio_mic',selectedMic);await setupAudio(selectedMic);micPanel.classList.add('hidden');setStatus('Mikrofon değiştirildi.','good')};
window.addEventListener('beforeunload',()=>{if(joined){try{fetch(SERVER_BASE+'signal.php?'+new URLSearchParams({action:'leave',id:myId,_:Date.now().toString()}),{method:'GET',keepalive:true,cache:'no-store',credentials:'omit'})}catch{}}});

// Tarayıcı ses çıkışını askıya alırsa ilk kullanıcı hareketinde tekrar uyandır.
for(const ev of ['pointerdown','keydown','touchstart']) window.addEventListener(ev,()=>{if(audioCtx?.state==='suspended')audioCtx.resume().catch(()=>{});},{passive:true});
