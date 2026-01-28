
// SmartInsole Webapp - Step 4 (ADC->N + N->Kg + GRF)


// UUID firmware
const SERVICE_UUID  = "12345678-1234-1234-1234-1234567890ab";
const CHAR_UUID_FSR = "abcd1234-5678-90ab-cdef-1234567890ab"; // FSR notify
const CHAR_UUID_IMU = "11223344-5566-7788-99aa-bbccddeeff00"; // IMU notify

// set name in firmware (left/right)
const DEVNAME_RIGHT = "ESP32-FSR-IMU";
const DEVNAME_LEFT  = "ESP32-FSR-IMU";

// --- Calibration (placeholder) --- now is not real - replace with real calibration function
function adcToNewton(adc, sensorIdx, side) {
  // adc: 0..4095 (o 0..1023)
  // sensorIdx: 0..4 per S2..S6
  // side: "Right"/"Left"
  // TODO: replace with calibration curve(s)
  const a = 0.0;
  const b = 0.02; // fake function
  const n = Math.max(0, a + b * Number(adc || 0));
  return n;
}

const G = 9.80665; // -->N/G=Kg

const state = {
  Right: { device:null, buf:"", lastFSR:null, lastIMU:null, lastRxMs:0 },
  Left:  { device:null, buf:"", lastFSR:null, lastIMU:null, lastRxMs:0 },
};

let acquisitionRunning = false;

// IMU offset
const imuZero = {
  Right: { pitch: 0, roll: 0 },
  Left:  { pitch: 0, roll: 0 },
};

const el = {
  btnRight: document.getElementById("btnRight"),
  btnLeft: document.getElementById("btnLeft"),
  stRight: document.getElementById("stRight"),
  stLeft: document.getElementById("stLeft"),
  out: document.getElementById("out"),
  log: document.getElementById("log"),
  jsOk: document.getElementById("jsOk"),
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnDisconnect: document.getElementById("btnDisconnect"),
  unitKg: document.getElementById("unitKg"),
  btnZeroIMU: document.getElementById("btnZeroIMU"),
  btnReset: document.getElementById("btnReset"),
};

function log(msg) {
  const t = new Date().toLocaleTimeString();
  if (!el.log) return;
  el.log.textContent = `${t}  ${msg}\n` + el.log.textContent.slice(0, 7000);
}

function setText(node, text) {
  if (node) node.textContent = text;
}

function setStatus(side, ok, extra = "") {
  const target = (side === "Right") ? el.stRight : el.stLeft;
  if (!target) return;
  target.textContent = `${side}: ${ok ? "connesso" : "non connesso"} ${extra}`.trim();
}

function parseFSR(line) {
  // "S2: 2000 S3: 2100 S4: 1900 S5: 1800 S6: 1700"
  const m = [...line.matchAll(/S[2-6]:\s*(\d+)/g)].map(x => parseInt(x[1], 10));
  return (m.length === 5) ? m : null;
}

function parseIMU(line) {
  // "IMU,ax,ay,az,gx,gy,gz,temp,pitch,roll,ms"
  const p = line.split(",");
  if (p[0] !== "IMU" || p.length < 10) return null;
  const pitch = Number(p[8]);
  const roll  = Number(p[9]);
  if (!Number.isFinite(pitch) || !Number.isFinite(roll)) return null;
  return { pitch, roll };
}

function anyConnected() {
  return (state.Right.device && state.Right.device.gatt?.connected) ||
         (state.Left.device && state.Left.device.gatt?.connected);
}

function updateButtons() {
  if (el.btnStart && el.btnStop) {
    el.btnStart.disabled = acquisitionRunning || !anyConnected();
    el.btnStop.disabled  = !acquisitionRunning || !anyConnected();
  }
}

function formatForce(n) {
  const asKg = !!el.unitKg?.checked;
  if (asKg) return `${(n / G).toFixed(2)} kg`;
  return `${n.toFixed(2)} N`;
}

function computeSideForces(side) {
  const s = state[side];
  if (!s.lastFSR) return null;

  const adc = s.lastFSR;
  const n = adc.map((v, i) => adcToNewton(v, i, side));
  const grf = n.reduce((a, b) => a + b, 0);

  return { adc, n, grf };
}

function computeIMUShown(side) {
  const s = state[side];
  if (!s.lastIMU) return null;
  return {
    pitch: s.lastIMU.pitch - imuZero[side].pitch,
    roll:  s.lastIMU.roll  - imuZero[side].roll,
  };
}

function updateOut() {
  const r = state.Right, l = state.Left;

  const rRx = r.lastRxMs ? `${Math.round((Date.now() - r.lastRxMs) / 1000)}s fa` : "—";
  const lRx = l.lastRxMs ? `${Math.round((Date.now() - l.lastRxMs) / 1000)}s fa` : "—";

  const R = computeSideForces("Right");
  const L = computeSideForces("Left");

  const imuR = computeIMUShown("Right");
  const imuL = computeIMUShown("Left");

  const grfR = R ? R.grf : 0;
  const grfL = L ? L.grf : 0;
  const grfT = grfR + grfL;

  const txt = `RIGHT  (last RX: ${rRx})
FSR ADC: ${R ? R.adc.join(", ") : "—"}
FSR F:   ${R ? R.n.map(formatForce).join(" | ") : "—"}
GRF:     ${R ? formatForce(R.grf) : "—"}
IMU:     ${imuR ? `${imuR.pitch.toFixed(1)}°, ${imuR.roll.toFixed(1)}°` : "—"}

LEFT   (last RX: ${lRx})
FSR ADC: ${L ? L.adc.join(", ") : "—"}
FSR F:   ${L ? L.n.map(formatForce).join(" | ") : "—"}
GRF:     ${L ? formatForce(L.grf) : "—"}
IMU:     ${imuL ? `${imuL.pitch.toFixed(1)}°, ${imuL.roll.toFixed(1)}°` : "—"}

GRF TOTALE: ${formatForce(grfT)}

Acquisizione: ${acquisitionRunning ? "ON" : "OFF"}
Unità: ${el.unitKg?.checked ? "kg" : "N"}
`;
  setText(el.out, txt);
}

function onChunk(side, chunk) {
  if (!acquisitionRunning) return;

  const s = state[side];
  s.lastRxMs = Date.now();

  s.buf += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  while (true) {
    const idx = s.buf.indexOf("\n");
    if (idx === -1) break;

    const line = s.buf.slice(0, idx).trim();
    s.buf = s.buf.slice(idx + 1);
    if (!line) continue;

    if (line.startsWith("IMU,")) {
      const imu = parseIMU(line);
      if (imu) s.lastIMU = imu;
    } else {
      const fsr = parseFSR(line);
      if (fsr) s.lastFSR = fsr;
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
    cleanupSide(side);
    setStatus(side, false);
    updateButtons();
    updateOut();
  });

  // Connect
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);

  const chFSR = await service.getCharacteristic(CHAR_UUID_FSR);
  const chIMU = await service.getCharacteristic(CHAR_UUID_IMU);

  // Notifications
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

  updateButtons();
  updateOut();
}

function startAcquisition() {
  if (!anyConnected()) {
    log("START: nessun device connesso.");
    return;
  }
  acquisitionRunning = true;
  log("Acquisizione START ▶️");
  updateButtons();
  updateOut();
}

function stopAcquisition() {
  acquisitionRunning = false;
  log("Acquisizione STOP ⏹️");
  updateButtons();
  updateOut();
}

function cleanupSide(side) {
  state[side].buf = "";
  state[side].lastFSR = null;
  state[side].lastIMU = null;
  state[side].lastRxMs = 0;
  state[side].device = null;

  imuZero[side].pitch = 0;
  imuZero[side].roll = 0;
}

function disconnectAll() {
  log("Disconnect: richiesta disconnessione…");
  acquisitionRunning = false;

  ["Right", "Left"].forEach(side => {
    const d = state[side].device;
    try {
      if (d?.gatt?.connected) d.gatt.disconnect();
    } catch (e) {}
    cleanupSide(side);
    setStatus(side, false);
  });

  log("Disconnect: completato ✅");
  updateButtons();
  updateOut();
}

function resetVisual() {
  
  ["Right", "Left"].forEach(side => {
    state[side].buf = "";
    state[side].lastFSR = null;
    state[side].lastIMU = null;
    state[side].lastRxMs = 0;
    imuZero[side].pitch = 0;
    imuZero[side].roll = 0;
  });
  log("Reset: clear valori ✅");
  updateOut();
}

function zeroIMU() {
  ["Right", "Left"].forEach(side => {
    if (state[side].lastIMU) {
      imuZero[side].pitch = state[side].lastIMU.pitch;
      imuZero[side].roll  = state[side].lastIMU.roll;
    }
  });
  log("Zero IMU: azzeramento visuale ✅");
  updateOut();
}

// ---- Init ----
(function init() {
  if (el.log) el.log.textContent = "";
  log("JS caricato ✅");
  setText(el.jsOk, "JS caricato ✅");

  if (el.btnRight) el.btnRight.addEventListener("click", () => {
    log("Click Right ✅");
    connectSide("Right").catch(e => log(`Right ERR: ${e?.name || e} | ${e?.message || ""}`));
  });

  if (el.btnLeft) el.btnLeft.addEventListener("click", () => {
    log("Click Left ✅");
    connectSide("Left").catch(e => log(`Left ERR: ${e?.name || e} | ${e?.message || ""}`));
  });

  if (el.btnStart) el.btnStart.addEventListener("click", startAcquisition);
  if (el.btnStop) el.btnStop.addEventListener("click", stopAcquisition);
  if (el.btnDisconnect) el.btnDisconnect.addEventListener("click", disconnectAll);

  if (el.unitKg) el.unitKg.addEventListener("change", updateOut);
  if (el.btnReset) el.btnReset.addEventListener("click", resetVisual);
  if (el.btnZeroIMU) el.btnZeroIMU.addEventListener("click", zeroIMU);

  updateButtons();
  updateOut();
  log("Handler bottoni attivi ✅");
})();
