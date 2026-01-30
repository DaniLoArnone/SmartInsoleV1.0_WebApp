// =====================
// SmartInsole Webapp - Step 5 Csv export
// =====================

// UUID firmware
const SERVICE_UUID  = "12345678-1234-1234-1234-1234567890ab";
const CHAR_UUID_FSR = "abcd1234-5678-90ab-cdef-1234567890ab"; // FSR notify
const CHAR_UUID_IMU = "11223344-5566-7788-99aa-bbccddeeff00"; // IMU notify

// Device names 
const DEVNAME_RIGHT = "ESP32-FSR-IMU";
const DEVNAME_LEFT  = "ESP32-FSR-IMU";

// Gravità standard per kgf
const G0 = 9.80665;

const state = {
  Right: { device: null, buf: "", lastFSR: null, lastIMU: null, lastRx: null, grfN: 0 },
  Left:  { device: null, buf: "", lastFSR: null, lastIMU: null, lastRx: null, grfN: 0 },
};

let acquisitionRunning = false;

// ---- Recorder
let recording = false;
let records = []; // array of objects
let recStartMs = null;

// IMU zero 
let imuZero = { pitch: 0, roll: 0 };

// Unit toggle
let showKg = false;

// ---- Calibration fake equations
const CAL = {
  Right: [1, 1, 1, 1, 1], // S2..S6
  Left:  [1, 1, 1, 1, 1],
};

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

  out: document.getElementById("out"),
  log: document.getElementById("log"),
  jsOk: document.getElementById("jsOk"),
};

function nowIso() {
  return new Date().toISOString();
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  if (!el.log) return;
  el.log.textContent = `${t}  ${msg}\n` + el.log.textContent.slice(0, 6000);
}

function setStatus(side, ok, extra="") {
  const target = (side === "Right") ? el.stRight : el.stLeft;
  if (!target) return;
  target.textContent = `${side}: ${ok ? "connesso" : "non connesso"} ${extra}`.trim();
}

function setRecStatus() {
  if (!el.recStatus) return;
  const n = records.length;
  el.recStatus.textContent = recording ? `REC ●  righe: ${n}` : (n > 0 ? `Pronto: ${n} righe` : "");
}

function adcToN(side, idx, adc) {
  const k = (CAL[side] && Number.isFinite(CAL[side][idx])) ? CAL[side][idx] : 1.0;
  return adc * k;
}

function fmtForce(vN) {
  if (!Number.isFinite(vN)) return "—";
  if (showKg) return `${(vN / G0).toFixed(3)} kg`;
  return `${vN.toFixed(2)} N`;
}

function parseFSR(line) {
  // "FSR,S2: 123,S3: 456,S4: 0,S5: 0,S6: 12"
  const m = [...line.matchAll(/S([2-6])\s*:\s*(\d+)/g)];
  if (m.length < 5) return null;

  // order by sensor
  const out = [null, null, null, null, null]; // S2..S6
  for (const mm of m) {
    const s = parseInt(mm[1], 10); // 2..6
    const v = parseInt(mm[2], 10);
    if (s >= 2 && s <= 6) out[s - 2] = v;
  }
  if (out.some(v => v === null)) return null;
  return out; // [S2,S3,S4,S5,S6] ADC
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

function computeFoot(side) {
  const s = state[side];
  if (!s.lastFSR) {
    s.grfN = 0;
    return;
  }
  const adc = s.lastFSR;
  const nArr = adc.map((v, i) => adcToN(side, i, v));
  const grf = nArr.reduce((a, b) => a + b, 0);
  s.grfN = grf;
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
Unità: ${showKg ? "kg" : "N"}
REC: ${recording ? "ON" : "OFF"}  (righe: ${records.length})
`;
  if (el.out) el.out.textContent = txt;
}

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

  // GRF in N 
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

  // UI
  setRecStatus();
  if (el.btnRecDownload) el.btnRecDownload.disabled = (records.length === 0);
}

function onChunk(side, chunk) {
  if (!acquisitionRunning) return;

  const s = state[side];
  s.buf += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

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

  imuZero = { pitch: 0, roll: 0 };

  log("Reset: clear valori ✅");
  updateOut();
}

// -------- Recorder controls
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
  // CSV safe minimal
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

// --------------------
// Event wiring + init
// --------------------
if (el.log) el.log.textContent = "";
log("JS caricato ✅");
if (el.jsOk) el.jsOk.textContent = "JS caricato ✅";

if (el.chkKg) {
  el.chkKg.addEventListener("change", () => {
    showKg = !!el.chkKg.checked;
    log(`Unità: ${showKg ? "kg" : "N"}`);
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

log("Handler bottoni attivi ✅");
setRecStatus();
updateOut();
