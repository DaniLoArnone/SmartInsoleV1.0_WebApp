// =====================
// SmartInsole Webapp
// BLE + GRF + CoP + CSV + Calibration + Sensor Position
// =====================

// ---- BLE UUID
const SERVICE_UUID  = "12345678-1234-1234-1234-1234567890ab";
const CHAR_UUID_FSR = "abcd1234-5678-90ab-cdef-1234567890ab";
const CHAR_UUID_IMU = "11223344-5566-7788-99aa-bbccddeeff00";

// ---- Device names to be changed
const DEVNAME_RIGHT = "ESP32-FSR-IMU";
const DEVNAME_LEFT  = "ESP32-FSR-IMU";

// ---- Constants
const G0 = 9.80665;

// ---- State
const state = {
  Right: { device: null, buf: "", lastFSR: null, lastIMU: null, lastRx: null, grfN: 0 },
  Left:  { device: null, buf: "", lastFSR: null, lastIMU: null, lastRx: null, grfN: 0 },
};

let acquisitionRunning = false;
let showKg = false;

// ---- Recorder
let recording = false;
let records = [];
let recStartMs = null;

// ---- IMU zero (visual)
let imuZero = { pitch: 0, roll: 0 };

const SENSOR_POS = {
  Right: [
    { x: 0.3333333333, y: 0.2000000000 }, // S2 BigToe
    { x: 0.5666666667, y: 0.2833333333 }, // S3 Forefoot
    { x: 0.5000000000, y: 0.5666666667 }, // S4 Midfoot
    { x: 0.4000000000, y: 0.7500000000 }, // S5 Hindfoot
    { x: 0.4666666667, y: 0.8500000000 }, // S6 Heel
  ],
  Left: [
    { x: 0.6666666667, y: 0.2000000000 }, // S1 BigToe
    { x: 0.4333333333, y: 0.2833333333 }, // S7 Forefoot
    { x: 0.5000000000, y: 0.5666666667 }, // S8 Midfoot
    { x: 0.6000000000, y: 0.7500000000 }, // S9 Hindfoot
    { x: 0.5333333333, y: 0.8500000000 }, // S10 Heel
  ], 
};

const copTrace = { Right: [], Left: [] };
const COP_TRACE_MAX = 80;

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

// ---- Heatmap
const MAX_FORCE_N = 100; // Max Force: Regola questo valore in N. Indica la forza a cui il colore diventa ROSSO intenso.
const HEAT_RADIUS = 65;  // Quanto "largo" si espande il colore di ogni sensore.

// Colormap
const colorMapData = (function createColormap() {
  const cv = document.createElement("canvas");
  cv.width = 256; cv.height = 1;
  const ctx = cv.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0.0, "rgba(0,0,255,0)");    // 0: Transparent
  grad.addColorStop(0.2, "rgba(0,0,255,1)");    // Low: Blue
  grad.addColorStop(0.4, "rgba(0,255,255,1)");  // Mid-Low: Ciano
  grad.addColorStop(0.6, "rgba(0,255,0,1)");    // Mid: Green
  grad.addColorStop(0.8, "rgba(255,255,0,1)");  // Mid-high: Yellow
  grad.addColorStop(1.0, "rgba(255,0,0,1)");    // High: Red
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 1);
  return ctx.getImageData(0, 0, 256, 1).data;
})();

// =====================
// Logging / UI helpers
// =====================
function log(msg) {
  const t = new Date().toLocaleTimeString();
  if (!el.log) return;
  el.log.textContent = `${t}  ${msg}\n` + el.log.textContent.slice(0, 6000);
}

function setStatus(side, ok, extra = "") {
  const target = (side === "Right") ? el.stRight : el.stLeft;
  if (!target) return;
  target.textContent = `${side}: ${ok ? "connesso" : "non connesso"} ${extra}`.trim();
}

function fmtForce(vN) {
  if (!Number.isFinite(vN)) return "—";
  return showKg ? `${(vN / G0).toFixed(3)} kg` : `${vN.toFixed(2)} N`;
}

function setRecStatus() {
  if (!el.recStatus) return;
  const n = records.length;
  el.recStatus.textContent = recording ? `REC ● righe: ${n}` : (n > 0 ? `Pronto: ${n} righe` : "");
}

// =====================
// Calibration REAL (piecewise average)
// =====================
function piecewise(A, B, C, D, v) {
  if (v < 3100) return (A(v) + C(v)) / 2.0;
  return (B(v) + D(v)) / 2.0;
}

function adcToN(_side, idx, adc) {
  const x = Number(adc);
  if (!Number.isFinite(x) || x <= 0) return 0;

  // ---- S2
  function A_S2(v){ return 3.55318476207185 * Math.exp(0.00094894086682249 * v); }
  function B_S2(v){ return 2.99787168724e-9 * v**4 - 4.14424553209615e-5 * v**3 + 0.214719875860377 * v**2 - 493.971314393156 * v + 425682.087216555; }
  function C_S2(v){ return 3.03539294077832 * Math.exp(0.000967646991434369 * v); }
  function D_S2(v){ return 3.47557990769e-9 * v**4 - 4.8066723736259e-5 * v**3 + 0.249026016766064 * v**2 - 572.620749203989 * v + 493036.03631061; }

  // ---- S3
  function A_S3(v){ return 3.77034174997573 * Math.exp(0.000900775165803785 * v); }
  function B_S3(v){ return 2.83323455636e-9 * v**4 - 3.93851090745969e-5 * v**3 + 0.205304725517828 * v**2 - 475.428875166596 * v + 412600.89131422; }
  function C_S3(v){ return 3.05986487313608e-9 * v**3 - 7.7556010500875e-6 * v**2 + 0.0127534813164196 * v + 1.51244232487535; }
  function D_S3(v){ return 3.43248747375701e-9 * v**4 - 4.77517236321521e-5 * v**3 + 0.248842491658625 * v**2 - 575.522523384191 * v + 498389.854359623; }

  // ---- S4
  function A_S4(v){ return 3.3689096811454 * Math.exp(0.000912314619981851 * v); }
  function B_S4(v){ return 3.33961586537e-9 * v**4 - 4.68436084707115e-5 * v**3 + 0.246326400120179 * v**2 - 575.353377629025 * v + 503602.694104745; }
  function C_S4(v){ return 2.59222040212444 * Math.exp(0.000972989886100292 * v); }
  function D_S4(v){ return 2.38879584169e-9 * v**4 - 3.31011729993339e-5 * v**3 + 0.171883538567573 * v**2 - 396.259775746952 * v + 342171.961662897; }

  // ---- S5
  function A_S5(v){ return 3.63729479673177 * Math.exp(0.000929907537342378 * v); }
  function B_S5(v){ return 2.5182290236e-9 * v**4 - 3.50252200218379e-5 * v**3 + 0.182552081821025 * v**2 - 422.38819104635 * v + 366023.817652731; }
  function C_S5(v){ return 3.07039694017777 * Math.exp(0.000947227994952771 * v); }
  function D_S5(v){ return 2.18795617625e-9 * v**4 - 3.04903493639158e-5 * v**3 + 0.159260205310925 * v**2 - 369.366685478866 * v + 320893.317982162; }

  // ---- S6
  function A_S6(v){ return 3.37866679264142 * Math.exp(0.000931029312416865 * v); }
  function B_S6(v){ return 2.43285932752e-9 * v**4 - 3.38593630757939e-5 * v**3 + 0.176661757378559 * v**2 - 409.35025868921 * v + 355364.677167488; }
  function C_S6(v){ return 2.86597940534577 * Math.exp(0.000938441421541307 * v); }
  function D_S6(v){ return 3.14986035417e-9 * v**4 - 4.43528886292832e-5 * v**3 + 0.234159318367009 * v**2 - 549.145957276041 * v + 482610.337591749; }

  let outN = 0;
  switch (idx) {
    case 0: outN = piecewise(A_S2, B_S2, C_S2, D_S2, x); break;
    case 1: outN = piecewise(A_S3, B_S3, C_S3, D_S3, x); break;
    case 2: outN = piecewise(A_S4, B_S4, C_S4, D_S4, x); break;
    case 3: outN = piecewise(A_S5, B_S5, C_S5, D_S5, x); break;
    case 4: outN = piecewise(A_S6, B_S6, C_S6, D_S6, x); break;
    default: outN = 0;
  }

  if (!Number.isFinite(outN) || outN < 0) return 0;
  return outN;
}

// =====================
// Parsing
// =====================
function parseFSR(line) {
  // "FSR,S2: 123,S3: 456,S4: 0,S5: 0,S6: 12"
  const m = [...line.matchAll(/S([2-6])\s*:\s*(\d+)/g)];
  if (m.length < 5) return null;

  const out = [null, null, null, null, null]; // S2..S6
  for (const mm of m) {
    const s = parseInt(mm[1], 10);
    const v = parseInt(mm[2], 10);
    if (s >= 2 && s <= 6) out[s - 2] = v;
  }
  if (out.some(v => v === null)) return null;
  return out;
}

function parseIMU(line) {
  // IMU,ax,ay,az,gx,gy,gz,temp,pitch,roll,ms
  const p = line.split(",");
  if (p[0] !== "IMU" || p.length < 10) return null;
  const pitch = Number(p[8]);
  const roll  = Number(p[9]);
  if (!Number.isFinite(pitch) || !Number.isFinite(roll)) return null;
  return { pitch, roll };
}

// =====================
// GRF / CoP
// =====================
function computeFoot(side) {
  const s = state[side];
  if (!s.lastFSR) {
    s.grfN = 0;
    return;
  }
  const nArr = s.lastFSR.map((v, i) => adcToN(side, i, v));
  s.grfN = nArr.reduce((a, b) => a + b, 0);
}

function computeCoP(side) {
  const s = state[side];
  if (!s.lastFSR) return null;

  const forcesN = s.lastFSR.map((v, i) => adcToN(side, i, v));
  const sumF = forcesN.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sumF) || sumF <= 0) return null;

  const pos = SENSOR_POS[side];
  let cx = 0, cy = 0;
  for (let i = 0; i < 5; i++) {
    const F = forcesN[i] || 0;
    cx += pos[i].x * F;
    cy += pos[i].y * F;
  }
  cx /= sumF;
  cy /= sumF;
  return { x: cx, y: cy, sumF };
}

// =====================
// "Jet" Colormap Generator (Matplotlib Style)
// =====================
const colorMapData = new Uint8Array(256 * 4);
for (let i = 0; i < 256; i++) {
    let v = i / 255.0;
    // Math logic for Jet scale (Blue -> Cyan -> Green -> Yellow -> Red)
    let r = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * v - 3)));
    let g = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * v - 2)));
    let b = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * v - 1)));
    
    colorMapData[i * 4]     = Math.floor(r * 255); // Red
    colorMapData[i * 4 + 1] = Math.floor(g * 255); // Green
    colorMapData[i * 4 + 2] = Math.floor(b * 255); // Blue
    colorMapData[i * 4 + 3] = 255;                 // Solid alpha (always visible)
}

// =====================
// Vector footprint silhouette (Path2D)
// =====================
function getFootPath(W, H, side) {
  const p = new Path2D();
  // Mirror the X coordinate if it's the Left foot
  const flip = (side === "Left");
  const getX = (val) => flip ? W - (val * W) : val * W;
  const getY = (val) => val * H;

  p.moveTo(getX(0.45), getY(0.90));
  p.bezierCurveTo(getX(0.45), getY(0.98), getX(0.65), getY(0.98), getX(0.65), getY(0.90));
  p.bezierCurveTo(getX(0.70), getY(0.75), getX(0.85), getY(0.55), getX(0.85), getY(0.35));
  p.bezierCurveTo(getX(0.85), getY(0.10), getX(0.65), getY(0.05), getX(0.45), getY(0.05));
  p.bezierCurveTo(getX(0.25), getY(0.05), getX(0.15), getY(0.20), getX(0.25), getY(0.35));
  p.bezierCurveTo(getX(0.35), getY(0.45), getX(0.45), getY(0.55), getX(0.40), getY(0.70));
  p.bezierCurveTo(getX(0.38), getY(0.80), getX(0.45), getY(0.90), getX(0.45), getY(0.90));
  p.closePath();
  return p;
}

// =====================
// Hidden Canvas for Heatmap Interpolation
// Using a 40x80 CPU-calculated grid, smoothly scaled up by the GPU
// =====================
const GRID_W = 40;
const GRID_H = 80;
const heatCanvas = document.createElement("canvas");
heatCanvas.width = GRID_W;
heatCanvas.height = GRID_H;
const heatCtx = heatCanvas.getContext("2d", { willReadFrequently: true });
const heatImgData = heatCtx.createImageData(GRID_W, GRID_H);

// =====================
// CoP & Heatmap Rendering Engine (IDW Matplotlib Style)
// =====================
function drawCoP(side) {
  const cv = (side === "Right") ? el.cvRight : el.cvLeft;
  if (!cv) return;

  const ctx = cv.getContext("2d");
  const W = cv.width, H = cv.height;

  // 1. Main background completely black
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);

  const s = state[side];
  const forcesN = s.lastFSR ? s.lastFSR.map((v, i) => adcToN(side, i, v)) : [0,0,0,0,0];

  // 2. IDW (Inverse Distance Weighting) algorithm over the grid
  const pos = SENSOR_POS[side];
  const sensors = pos.map((p, i) => ({
    gx: p.x * GRID_W,
    gy: p.y * GRID_H,
    f: forcesN[i] || 0
  }));

  const data = heatImgData.data;
  let idx = 0;
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      let v_sum = 0;
      let w_sum = 0;
      
      // Calculate the influence of each sensor on this specific pixel
      for (let i = 0; i < 5; i++) {
        const dx = x - sensors[i].gx;
        const dy = y - sensors[i].gy;
        // "+ 5.0" spreads the color smoothly, avoiding sharp peaks
        const w = 1.0 / (dx * dx + dy * dy + 5.0); 
        v_sum += sensors[i].f * w;
        w_sum += w;
      }
      const v = v_sum / w_sum;

      // Color mapping
      const limitForce = (typeof MAX_FORCE_N !== 'undefined') ? MAX_FORCE_N : 100.0;
      let intensity = v / limitForce;
      if (intensity > 1) intensity = 1;
      if (intensity < 0) intensity = 0;

      // cIdx fetches the exact color from the generated Jet Colormap
      const cIdx = Math.floor(intensity * 255) * 4;
      data[idx++] = colorMapData[cIdx];     // Red
      data[idx++] = colorMapData[cIdx + 1]; // Green
      data[idx++] = colorMapData[cIdx + 2]; // Blue
      data[idx++] = 255;                    // Alpha (Solid)
    }
  }
  heatCtx.putImageData(heatImgData, 0, 0);

  // 3. Clipping mask (colors will ONLY show inside the footprint)
  ctx.save();
  const footPath = getFootPath(W, H, side);
  ctx.clip(footPath);

  // 4. Draw the heatmap by stretching it over the whole canvas
  // (the browser applies free bilinear interpolation)
  ctx.drawImage(heatCanvas, 0, 0, W, H);
  ctx.restore(); // End of clip mask

  // 5. Draw the gray outline around the foot
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#555555";
  ctx.stroke(footPath);

  // 6. Sensor labels and dots
  const labelsRight = ["S2", "S3", "S4", "S5", "S6"];
  const labelsLeft  = ["S1", "S7", "S8", "S9", "S10"];
  
  for (let i = 0; i < 5; i++) {
    const p = SENSOR_POS[side][i];
    const px = p.x * W, py = p.y * H;
    const label = (side === "Right") ? labelsRight[i] : labelsLeft[i];

    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#1a1a1a";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 13px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(label, px, py - 10);
  }

  // 7. Center of Pressure (CoP) trace and current point
  const cop = computeCoP(side);
  if (cop) {
    copTrace[side].push({ x: cop.x, y: cop.y });
    if (copTrace[side].length > COP_TRACE_MAX) copTrace[side].shift();

    // Trace line
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; k < copTrace[side].length; k++) {
      const pt = copTrace[side][k];
      const pX = pt.x * W, pY = pt.y * H;
      if (k === 0) ctx.moveTo(pX, pY);
      else ctx.lineTo(pX, pY);
    }
    ctx.stroke();

    // Current yellow dot
    const cx = cop.x * W, cy = cop.y * H;
    ctx.fillStyle = "#ffeb3b"; 
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}
// =====================
// Output + CSV recorder
// =====================
function pushRecord(side, kind) {
  if (!recording) return;

  const s = state[side];
  const tMs = Date.now();
  const relMs = recStartMs ? (tMs - recStartMs) : 0;

  const fsr_adc = s.lastFSR ? s.lastFSR.slice() : [null, null, null, null, null];
  const fsr_n = s.lastFSR ? s.lastFSR.map((v,i)=>adcToN(side, i, v)) : [null, null, null, null, null];

  const imu = s.lastIMU
    ? { pitch: s.lastIMU.pitch - imuZero.pitch, roll: s.lastIMU.roll - imuZero.roll }
    : { pitch: null, roll: null };

  const grfN = s.lastFSR ? fsr_n.reduce((a,b)=>a+b,0) : null;

  records.push({
    iso: new Date(tMs).toISOString(),
    t_ms: tMs,
    rel_ms: relMs,
    foot: side,
    kind, // "FSR" o "IMU"
    s2_adc: fsr_adc[0], s3_adc: fsr_adc[1], s4_adc: fsr_adc[2], s5_adc: fsr_adc[3], s6_adc: fsr_adc[4],
    s2_n: fsr_n[0], s3_n: fsr_n[1], s4_n: fsr_n[2], s5_n: fsr_n[3], s6_n: fsr_n[4],
    grf_n: grfN,
    pitch_deg: imu.pitch,
    roll_deg: imu.roll,
  });

  setRecStatus();
  if (el.btnRecDownload) el.btnRecDownload.disabled = (records.length === 0);
}

function updateOut() {
  computeFoot("Right");
  computeFoot("Left");

  const r = state.Right, l = state.Left;
  const grfTot = (Number.isFinite(r.grfN) ? r.grfN : 0) + (Number.isFinite(l.grfN) ? l.grfN : 0);

  const rIMU = r.lastIMU ? { pitch: r.lastIMU.pitch - imuZero.pitch, roll: r.lastIMU.roll - imuZero.roll } : null;
  const lIMU = l.lastIMU ? { pitch: l.lastIMU.pitch - imuZero.pitch, roll: l.lastIMU.roll - imuZero.roll } : null;

  const rN = r.lastFSR ? r.lastFSR.map((v,i)=>adcToN("Right", i, v)) : null;
  const lN = l.lastFSR ? l.lastFSR.map((v,i)=>adcToN("Left", i, v)) : null;

  const unitLabel = showKg ? "kg" : "N";

  const txt =
`RIGHT (last RX: ${r.lastRx || "—"})
FSR ADC: ${r.lastFSR ? r.lastFSR.join(", ") : "—"}
FSR F:   ${rN ? rN.map(x => showKg ? (x/G0).toFixed(3) : x.toFixed(2)).join(", ") + " " + unitLabel : "—"}
GRF:     ${fmtForce(r.grfN)}
IMU:     ${rIMU ? `${rIMU.pitch.toFixed(1)}°, ${rIMU.roll.toFixed(1)}°` : "—"}

LEFT  (last RX: ${l.lastRx || "—"})
FSR ADC: ${l.lastFSR ? l.lastFSR.join(", ") : "—"}
FSR F:   ${lN ? lN.map(x => showKg ? (x/G0).toFixed(3) : x.toFixed(2)).join(", ") + " " + unitLabel : "—"}
GRF:     ${fmtForce(l.grfN)}
IMU:     ${lIMU ? `${lIMU.pitch.toFixed(1)}°, ${lIMU.roll.toFixed(1)}°` : "—"}

GRF TOTALE: ${fmtForce(grfTot)}

Acquisizione: ${acquisitionRunning ? "ON" : "OFF"}
Unità: ${showKg ? "kg" : "N"} (visual)
REC: ${recording ? "ON" : "OFF"} (righe: ${records.length})
`;
  if (el.out) el.out.textContent = txt;

  drawCoP("Right");
  drawCoP("Left");
}

// =====================
// RX Chunk
// =====================
function onChunk(side, chunk) {
  if (!acquisitionRunning) return;

  const s = state[side];
  s.buf += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (s.buf.length > 2000) s.buf = ""; // Flush the buffer if data is corrupt or missing\n

  while (true) {
    const idx = s.buf.indexOf("\n");
    if (idx === -1) break;

    const line = s.buf.slice(0, idx).trim();
    s.buf = s.buf.slice(idx + 1);
    if (!line) continue;

    s.lastRx = new Date().toLocaleTimeString();

    if (line.startsWith("IMU,")) {
      const imu = parseIMU(line);
      if (imu) {
        s.lastIMU = imu;
        pushRecord(side, "IMU");
      }
    } else {
      const fsr = parseFSR(line);
      if (fsr) {
        s.lastFSR = fsr;
        pushRecord(side, "FSR");
      }
    }
  }

  updateOut();
}

// =====================
// BLE connect
// =====================
async function connectSide(side) {
  if (!navigator.bluetooth) {
    alert("Web Bluetooth non disponibile. Usa Chrome/Edge.");
    return;
  }

  const wantName = (side === "Right") ? DEVNAME_RIGHT : DEVNAME_LEFT;
  log(`Scan BLE (${side}): ${wantName}`);

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ name: wantName }],
    optionalServices: [SERVICE_UUID],
  });

  device.addEventListener("gattserverdisconnected", () => {
    log(`${side}: disconnesso`);
    setStatus(side, false);
    state[side].device = null;
    updateOut();
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);

  const chFSR = await service.getCharacteristic(CHAR_UUID_FSR);
  const chIMU = await service.getCharacteristic(CHAR_UUID_IMU);

  await chFSR.startNotifications();
  chFSR.addEventListener("characteristicvaluechanged", (ev) => {
    const chunk = new TextDecoder().decode(ev.target.value);
    onChunk(side, chunk);
  });

  await chIMU.startNotifications();
  chIMU.addEventListener("characteristicvaluechanged", (ev) => {
    const chunk = new TextDecoder().decode(ev.target.value);
    onChunk(side, chunk);
  });

  state[side].device = device;
  setStatus(side, true, `(${device.name})`);
  log(`${side}: connesso a ${device.name}`);

  if (!acquisitionRunning) startAcquisition();
  updateOut();
}

// =====================
// Controls
// =====================
function startAcquisition() {
  acquisitionRunning = true;
  if (el.btnStart) el.btnStart.disabled = true;
  if (el.btnStop) el.btnStop.disabled = false;
  log("Acquisizione START ▶️");
  updateOut();
}

function stopAcquisition() {
  acquisitionRunning = false;
  if (el.btnStart) el.btnStart.disabled = false;
  if (el.btnStop) el.btnStop.disabled = true;
  log("Acquisizione STOP ⏹️");
  updateOut();
}

function disconnectAll() {
  log("Disconnect: richiesta disconnessione…");

  ["Right", "Left"].forEach(side => {
    const d = state[side].device;
    try {
      if (d?.gatt?.connected) d.gatt.disconnect();
    } catch (_) {}

    state[side].device = null;
    state[side].buf = "";
    state[side].lastFSR = null;
    state[side].lastIMU = null;
    state[side].lastRx = null;
    state[side].grfN = 0;

    copTrace[side] = [];
    setStatus(side, false);
    log(`${side}: disconnesso manualmente`);
  });

  stopAcquisition();
  log("Disconnect: completato ✅");
}

function zeroIMU() {
  const r = state.Right.lastIMU;
  const l = state.Left.lastIMU;
  const ref = r || l;
  if (!ref) {
    log("Zero IMU: nessun dato IMU disponibile");
    return;
  }
  imuZero = { pitch: ref.pitch, roll: ref.roll };
  log("Zero IMU: azzeramento visuale ✅");
  updateOut();
}

function resetAll() {
  state.Right.buf = "";
  state.Left.buf = "";
  state.Right.lastFSR = null;
  state.Left.lastFSR = null;
  state.Right.lastIMU = null;
  state.Left.lastIMU = null;
  state.Right.lastRx = null;
  state.Left.lastRx = null;
  state.Right.grfN = 0;
  state.Left.grfN = 0;

  copTrace.Right = [];
  copTrace.Left = [];

  imuZero = { pitch: 0, roll: 0 };

  log("Reset: clear valori ✅");
  updateOut();
}

// =====================
// Recorder: CSV download
// =====================
function recStart() {
  records = [];
  recording = true;
  recStartMs = Date.now();

  if (el.btnRecStart) el.btnRecStart.disabled = true;
  if (el.btnRecStop) el.btnRecStop.disabled = false;
  if (el.btnRecDownload) el.btnRecDownload.disabled = true;

  log("REC START ●");
  setRecStatus();
  updateOut();
}

function recStop() {
  recording = false;

  if (el.btnRecStart) el.btnRecStart.disabled = false;
  if (el.btnRecStop) el.btnRecStop.disabled = true;
  if (el.btnRecDownload) el.btnRecDownload.disabled = (records.length === 0);

  log(`REC STOP ■ (righe: ${records.length})`);
  setRecStatus();
  updateOut();
}

function toCsvValue(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function downloadCsv() {
  if (!records.length) {
    log("Download CSV: nessun dato");
    return;
  }

  const pid = (el.patientId?.value || "").trim();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fname = `SmartInsole_${pid ? pid + "_" : ""}session_${stamp}.csv`;

  const header = [
    "iso","t_ms","rel_ms","foot","kind",
    "s2_adc","s3_adc","s4_adc","s5_adc","s6_adc",
    "s2_n","s3_n","s4_n","s5_n","s6_n",
    "grf_n",
    "pitch_deg","roll_deg"
  ].join(",");

  const lines = [header];

  for (const r of records) {
    const row = [
      r.iso, r.t_ms, r.rel_ms, r.foot, r.kind,
      r.s2_adc, r.s3_adc, r.s4_adc, r.s5_adc, r.s6_adc,
      r.s2_n, r.s3_n, r.s4_n, r.s5_n, r.s6_n,
      r.grf_n,
      r.pitch_deg, r.roll_deg
    ].map(toCsvValue).join(",");
    lines.push(row);
  }

  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();

  URL.revokeObjectURL(url);
  log(`Download CSV ✅ (${fname})`);
}

// =====================
// Wiring + init
// =====================
if (el.log) el.log.textContent = "";
if (el.jsOk) el.jsOk.textContent = "JS caricato ✅";
log("JS caricato ✅");

if (el.chkKg) {
  el.chkKg.addEventListener("change", () => {
    showKg = !!el.chkKg.checked;
    log(`Unità: ${showKg ? "kg" : "N"} (visual)`);
    updateOut();
  });
}

if (el.btnRight) {
  el.btnRight.addEventListener("click", () => {
    log("Click Right ✅");
    connectSide("Right").catch(e => log(`Right ERR: ${e?.name || e} | ${e?.message || ""}`));
  });
}

if (el.btnLeft) {
  el.btnLeft.addEventListener("click", () => {
    log("Click Left ✅");
    connectSide("Left").catch(e => log(`Left ERR: ${e?.name || e} | ${e?.message || ""}`));
  });
}

if (el.btnStart) el.btnStart.addEventListener("click", startAcquisition);
if (el.btnStop) el.btnStop.addEventListener("click", stopAcquisition);
if (el.btnDisconnect) el.btnDisconnect.addEventListener("click", disconnectAll);

if (el.btnZeroIMU) el.btnZeroIMU.addEventListener("click", zeroIMU);
if (el.btnReset) el.btnReset.addEventListener("click", resetAll);

if (el.btnRecStart) el.btnRecStart.addEventListener("click", recStart);
if (el.btnRecStop) el.btnRecStop.addEventListener("click", recStop);
if (el.btnRecDownload) el.btnRecDownload.addEventListener("click", downloadCsv);

setRecStatus();
updateOut();
log("Handler bottoni attivi ✅");
