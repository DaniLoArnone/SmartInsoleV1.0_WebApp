
// SmartInsole Webapp - Step 3 

// UUID firmware
const SERVICE_UUID  = "12345678-1234-1234-1234-1234567890ab";
const CHAR_UUID_FSR = "abcd1234-5678-90ab-cdef-1234567890ab"; // FSR notify
const CHAR_UUID_IMU = "11223344-5566-7788-99aa-bbccddeeff00"; // IMU notify

// device 
const DEVNAME_RIGHT = "ESP32-FSR-IMU";
const DEVNAME_LEFT  = "ESP32-FSR-IMU";

const state = {
  Right: {
    device: null,
    server: null,
    service: null,
    chFSR: null,
    chIMU: null,
    buf: "",
    lastFSR: null,
    lastIMU: null,
    lastRxMs: 0,
  },
  Left: {
    device: null,
    server: null,
    service: null,
    chFSR: null,
    chIMU: null,
    buf: "",
    lastFSR: null,
    lastIMU: null,
    lastRxMs: 0,
  },
};

let acquisitionRunning = false;

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
};

function log(msg) {
  const t = new Date().toLocaleTimeString();
  if (!el.log) return;
  el.log.textContent = `${t}  ${msg}\n` + el.log.textContent.slice(0, 6000);
}

function safeSetText(node, text) {
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

function updateOut() {
  const r = state.Right, l = state.Left;

  const rRx = r.lastRxMs ? `${Math.round((Date.now() - r.lastRxMs) / 1000)}s fa` : "—";
  const lRx = l.lastRxMs ? `${Math.round((Date.now() - l.lastRxMs) / 1000)}s fa` : "—";

  const txt = `RIGHT  (last RX: ${rRx})
FSR: ${r.lastFSR ? r.lastFSR.join(", ") : "—"}
IMU: ${r.lastIMU ? `${r.lastIMU.pitch.toFixed(1)}°, ${r.lastIMU.roll.toFixed(1)}°` : "—"}

LEFT   (last RX: ${lRx})
FSR: ${l.lastFSR ? l.lastFSR.join(", ") : "—"}
IMU: ${l.lastIMU ? `${l.lastIMU.pitch.toFixed(1)}°, ${l.lastIMU.roll.toFixed(1)}°` : "—"}

Acquisizione: ${acquisitionRunning ? "ON" : "OFF"}
`;
  safeSetText(el.out, txt);
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
    cleanupSide(side, /*keepLog*/true);
    setStatus(side, false);
    updateOut();
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);

  const chFSR = await service.getCharacteristic(CHAR_UUID_FSR);
  const chIMU = await service.getCharacteristic(CHAR_UUID_IMU);

  state[side].device = device;
  state[side].server = server;
  state[side].service = service;
  state[side].chFSR = chFSR;
  state[side].chIMU = chIMU;

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

  setStatus(side, true, `(${device.name})`);
  log(`${side}: connesso a ${device.name}`);

  updateButtons();
  updateOut();
}

function updateButtons() {
  if (!el.btnStart || !el.btnStop) return;
  el.btnStart.disabled = acquisitionRunning;
  el.btnStop.disabled = !acquisitionRunning;

  const anyConnected =
    (state.Right.device && state.Right.device.gatt?.connected) ||
    (state.Left.device && state.Left.device.gatt?.connected);

  el.btnStart.disabled = acquisitionRunning || !anyConnected;
  el.btnStop.disabled = !acquisitionRunning || !anyConnected;
}

function startAcquisition() {
  const anyConnected =
    (state.Right.device && state.Right.device.gatt?.connected) ||
    (state.Left.device && state.Left.device.gatt?.connected);

  if (!anyConnected) {
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

function cleanupSide(side, keepLog = false) {
  const s = state[side];
  s.buf = "";
  s.lastFSR = null;
  s.lastIMU = null;
  s.lastRxMs = 0;

  s.chFSR = null;
  s.chIMU = null;
  s.service = null;
  s.server = null;
  s.device = null;

  if (!keepLog) log(`${side}: cleanup`);
}

function disconnectAll() {
  log("Disconnect: richiesta disconnessione…");

  acquisitionRunning = false;

  ["Right", "Left"].forEach(side => {
    const d = state[side].device;
    try {
      if (d?.gatt?.connected) d.gatt.disconnect();
    } catch (e) {
    }
    cleanupSide(side, true);
    setStatus(side, false);
  });

  log("Disconnect: completato ✅");
  updateButtons();
  updateOut();
}

// ---- Init ----
(function init() {
  if (el.log) el.log.textContent = "";
  log("JS caricato ✅");
  safeSetText(el.jsOk, "JS caricato ✅");

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

  updateButtons();
  updateOut();

  log("Handler bottoni attivi ✅");
})();
