
// SmartInsole Webapp
// Step 6: BLE + GRF + CoP + CSV


// ---- BLE UUID
const SERVICE_UUID  = "12345678-1234-1234-1234-1234567890ab";
const CHAR_UUID_FSR = "abcd1234-5678-90ab-cdef-1234567890ab";
const CHAR_UUID_IMU = "11223344-5566-7788-99aa-bbccddeeff00";

// ---- Device names
const DEVNAME_RIGHT = "ESP32-FSR-IMU";
const DEVNAME_LEFT  = "ESP32-FSR-IMU";

// ---- Constants
const G0 = 9.80665;

// ---- State
const state = {
  Right: { device:null, buf:"", lastFSR:null, lastIMU:null, grfN:0 },
  Left:  { device:null, buf:"", lastFSR:null, lastIMU:null, grfN:0 },
};

let acquisitionRunning = false;
let showKg = false;

// ---- Recorder
let recording = false;
let records = [];
let recStartMs = null;

// ---- IMU zero
let imuZero = { pitch:0, roll:0 };

// ---- Fake calibration (placeholder)
const CAL = {
  Right: [1,1,1,1,1],
  Left:  [1,1,1,1,1],
};

// ---- DOM
const el = {
  btnRight: document.getElementById("btnRight"),
  btnLeft: document.getElementById("btnLeft"),
  stRight: document.getElementById("stRight"),
  stLeft: document.getElementById("stLeft"),

  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnDisconnect: document.getElementById("btnDisconnect"),

  chkKg: document.getElementById("chkKg"),
  btnZeroIMU: document.getElementById("btnZeroIMU"),
  btnReset: document.getElementById("btnReset"),

  patientId: document.getElementById("patientId"),
  btnRecStart: document.getElementById("btnRecStart"),
  btnRecStop: document.getElementById("btnRecStop"),
  btnRecDownload: document.getElementById("btnRecDownload"),
  recStatus: document.getElementById("recStatus"),

  cvRight: document.getElementById("cvRight"),
  cvLeft: document.getElementById("cvLeft"),

  out: document.getElementById("out"),
  log: document.getElementById("log"),
  jsOk: document.getElementById("jsOk"),
};

// ---- Sensor positions (normalized)
const SENSOR_POS = {
  Right: [
    {x:0.40,y:0.88},{x:0.60,y:0.72},{x:0.55,y:0.52},{x:0.45,y:0.34},{x:0.50,y:0.18}
  ],
  Left: [
    {x:0.60,y:0.88},{x:0.40,y:0.72},{x:0.45,y:0.52},{x:0.55,y:0.34},{x:0.50,y:0.18}
  ],
};

const copTrace = { Right:[], Left:[] };
const COP_TRACE_MAX = 80;

// ---- Utils
function log(msg){
  const t=new Date().toLocaleTimeString();
  el.log.textContent=`${t}  ${msg}\n`+el.log.textContent.slice(0,6000);
}
function setStatus(side,ok){
  (side==="Right"?el.stRight:el.stLeft).textContent=
    `${side}: ${ok?"connesso":"non connesso"}`;
}
function adcToN(side,i,v){ return v*(CAL[side]?.[i]||1); }
function fmt(v){
  if(!Number.isFinite(v)) return "—";
  return showKg?`${(v/G0).toFixed(3)} kg`:`${v.toFixed(2)} N`;
}

// ---- Parsers
function parseFSR(line){
  const m=[...line.matchAll(/S([2-6])\s*:\s*(\d+)/g)];
  if(m.length<5) return null;
  const o=[null,null,null,null,null];
  for(const x of m) o[x[1]-2]=+x[2];
  return o.some(v=>v===null)?null:o;
}
function parseIMU(line){
  const p=line.split(",");
  if(p[0]!=="IMU"||p.length<10) return null;
  return { pitch:+p[8], roll:+p[9] };
}

// ---- GRF & CoP
function computeFoot(side){
  const s=state[side];
  if(!s.lastFSR){ s.grfN=0; return; }
  const n=s.lastFSR.map((v,i)=>adcToN(side,i,v));
  s.grfN=n.reduce((a,b)=>a+b,0);
}
function computeCoP(side){
  const s=state[side];
  if(!s.lastFSR) return null;
  const n=s.lastFSR.map((v,i)=>adcToN(side,i,v));
  const sum=n.reduce((a,b)=>a+b,0);
  if(sum<=0) return null;
  let x=0,y=0;
  n.forEach((F,i)=>{ x+=SENSOR_POS[side][i].x*F; y+=SENSOR_POS[side][i].y*F; });
  return {x:x/sum,y:y/sum};
}

// ---- Draw
function drawCoP(side){
  const cv=side==="Right"?el.cvRight:el.cvLeft;
  const ctx=cv.getContext("2d"),W=cv.width,H=cv.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle="#111"; ctx.fillRect(0,0,W,H);
  ctx.fillStyle="#1b1b1b";
  ctx.beginPath(); ctx.roundRect(W*0.18,H*0.05,W*0.64,H*0.9,80); ctx.fill();

  const s=state[side];
  const f=s.lastFSR?s.lastFSR.map((v,i)=>adcToN(side,i,v)):[0,0,0,0,0];

  SENSOR_POS[side].forEach((p,i)=>{
    const r=Math.max(6,Math.min(26,6+f[i]*0.01));
    ctx.beginPath(); ctx.fillStyle="#2e7dff";
    ctx.arc(p.x*W,p.y*H,r,0,Math.PI*2); ctx.fill();
  });

  const cop=computeCoP(side);
  if(cop){
    copTrace[side].push(cop);
    if(copTrace[side].length>COP_TRACE_MAX) copTrace[side].shift();
    ctx.strokeStyle="rgba(255,255,255,.6)"; ctx.beginPath();
    copTrace[side].forEach((p,i)=>{
      const x=p.x*W,y=p.y*H;
      i?ctx.lineTo(x,y):ctx.moveTo(x,y);
    });
    ctx.stroke();
    ctx.fillStyle="#ffeb3b";
    ctx.beginPath(); ctx.arc(cop.x*W,cop.y*H,6,0,Math.PI*2); ctx.fill();
  }
}

// ---- Update
function updateOut(){
  computeFoot("Right"); computeFoot("Left");
  const r=state.Right,l=state.Left;
  const tot=r.grfN+l.grfN;
  el.out.textContent=
`RIGHT  GRF: ${fmt(r.grfN)}
LEFT   GRF: ${fmt(l.grfN)}
TOTAL  GRF: ${fmt(tot)}
Acq: ${acquisitionRunning?"ON":"OFF"} | REC: ${recording?"ON":"OFF"}`;
  drawCoP("Right"); drawCoP("Left");
}

// ---- BLE
async function connectSide(side){
  const device=await navigator.bluetooth.requestDevice({
    filters:[{name:side==="Right"?DEVNAME_RIGHT:DEVNAME_LEFT}],
    optionalServices:[SERVICE_UUID],
  });
  const server=await device.gatt.connect();
  const svc=await server.getPrimaryService(SERVICE_UUID);
  const fsr=await svc.getCharacteristic(CHAR_UUID_FSR);
  const imu=await svc.getCharacteristic(CHAR_UUID_IMU);
  await fsr.startNotifications(); await imu.startNotifications();
  fsr.oncharacteristicvaluechanged=e=>onChunk(side,new TextDecoder().decode(e.target.value));
  imu.oncharacteristicvaluechanged=e=>onChunk(side,new TextDecoder().decode(e.target.value));
  state[side].device=device;
  setStatus(side,true); log(`${side} connesso`);
  startAcquisition();
}

// ---- RX
function onChunk(side,chunk){
  if(!acquisitionRunning) return;
  const s=state[side];
  s.buf+=chunk.replace(/\r/g,"\n");
  let i;
  while((i=s.buf.indexOf("\n"))>=0){
    const line=s.buf.slice(0,i).trim(); s.buf=s.buf.slice(i+1);
    if(line.startsWith("IMU,")) s.lastIMU=parseIMU(line);
    else s.lastFSR=parseFSR(line);
  }
  updateOut();
}

// ---- Controls
function startAcquisition(){ acquisitionRunning=true; el.btnStart.disabled=true; el.btnStop.disabled=false; }
function stopAcquisition(){ acquisitionRunning=false; el.btnStart.disabled=false; el.btnStop.disabled=true; }
function disconnectAll(){
  ["Right","Left"].forEach(s=>{
    try{ state[s].device?.gatt.disconnect(); }catch{}
    state[s]={device:null,buf:"",lastFSR:null,lastIMU:null,grfN:0};
    setStatus(s,false);
  });
  stopAcquisition();
}

// ---- Recorder
function recStart(){ records=[]; recording=true; recStartMs=Date.now(); }
function recStop(){ recording=false; }
function downloadCsv(){
  if(!records.length) return;
}

// ---- Wiring
el.jsOk.textContent="JS caricato ✅";
el.btnRight.onclick=()=>connectSide("Right");
el.btnLeft.onclick=()=>connectSide("Left");
el.btnStart.onclick=startAcquisition;
el.btnStop.onclick=stopAcquisition;
el.btnDisconnect.onclick=disconnectAll;
el.chkKg.onchange=()=>{ showKg=el.chkKg.checked; updateOut(); };
