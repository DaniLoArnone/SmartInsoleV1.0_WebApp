// UUID firmware
const SERVICE_UUID  = "12345678-1234-1234-1234-1234567890ab";
const CHAR_UUID_FSR = "abcd1234-5678-90ab-cdef-1234567890ab"; // FSR notify
const CHAR_UUID_IMU = "11223344-5566-7788-99aa-bbccddeeff00"; // IMU notify

// rename left e right
const DEVNAME_RIGHT = "ESP32-FSR-IMU";
const DEVNAME_LEFT  = "ESP32-FSR-IMU";

const state = {
  Right: { device: null, buf: "", lastFSR: null, lastIMU: null },
  Left:  { device: null, buf: "", lastFSR: null, lastIMU: null },
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
  el.log.textContent = `${t}  ${msg}\n` + el.log.textContent.slice(0, 4000);
}

// debug
if (el.log) el.log.textContent = "";
log("JS caricato ✅");
if (el.jsOk) el.jsOk.textContent = "JS caricato ✅";

function setStatus(side, ok, extra="") {
  const target = (side === "Right") ? el.stRight : el.stLeft;
  target.textContent = `${side}: ${ok ? "connesso" : "non connesso"} ${extra}`;
}

function parseFSR(line) {
  // FSR,S2:...,S3:...,S4:...,S5:...,S6:...
  const m = [...line.matchAll(/S[2-6]:\s*(\d+)/g)].map(x => parseInt(x[1], 10));
  return (m.length === 5) ? m : null;
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

function updateOut() {
  const r = state.Right, l = state.Left;
  const txt = `RIGHT
FSR: ${r.lastFSR ? r.lastFSR.join(", ") : "—"}
IMU: ${r.lastIMU ? `${r.lastIMU.pitch.toFixed(1)}°, ${r.lastIMU.roll.toFixed(1)}°` : "—"}

LEFT
FSR: ${l.lastFSR ? l.lastFSR.join(", ") : "—"}
IMU: ${l.lastIMU ? `${l.lastIMU.pitch.toFixed(1)}°, ${l.lastIMU.roll.toFixed(1)}°` : "—"}
`;
  el.out.textContent = txt;
}


function onChunk(side, chunk) {
  const s = state[side];
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
  log(`Scan BLE: ${wantName}`);

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ name: wantName }],
    optionalServices: [SERVICE_UUID],
  });

  device.addEventListener("gattserverdisconnected", () => {
    log(`${side}: disconnesso`);
    setStatus(side, false);
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
}

function startAcquisition() {
  acquisitionRunning = true;
  el.btnStart.disabled = true;
  el.btnStop.disabled = false;
  log("Acquisizione START ▶️");
}

function stopAcquisition() {
  acquisitionRunning = false;
  el.btnStart.disabled = false;
  el.btnStop.disabled = true;
  log("Acquisizione STOP ⏹️");
}

function disconnectAll() {
  ["Right", "Left"].forEach(side => {
    const d = state[side].device;
    if (d && d.gatt.connected) {
      d.gatt.disconnect();
      log(`${side}: disconnesso manualmente`);
    }
    state[side].device = null;
    setStatus(side, false);
  });

  acquisitionRunning = false;
  el.btnStart.disabled = false;
  el.btnStop.disabled = true;
}

log("Handler bottoni attivi ✅");

el.btnRight.addEventListener("click", () => {
  log("Click Right ✅");
  connectSide("Right").catch(e => log(`Right ERR: ${e?.name || e} | ${e?.message || ""}`));
});

el.btnLeft.addEventListener("click", () => {
  log("Click Left ✅");
  connectSide("Left").catch(e => log(`Left ERR: ${e?.name || e} | ${e?.message || ""}`));
});

el.btnStart.addEventListener("click", startAcquisition);
el.btnStop.addEventListener("click", stopAcquisition);
el.btnDisconnect.addEventListener("click", disconnectAll);



