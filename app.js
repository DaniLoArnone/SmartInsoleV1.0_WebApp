// UUID firmware
const SERVICE_UUID      = "12345678-1234-1234-1234-1234567890ab";
const CHAR_UUID_FSR     = "abcd1234-5678-90ab-cdef-1234567890ab"; // FSR notify
const CHAR_UUID_IMU     = "11223344-5566-7788-99aa-bbccddeeff00"; // IMU notify

const DEVNAME_RIGHT = "ESP32-FSR-IMU-Right";
const DEVNAME_LEFT  = "ESP32-FSR-IMU-Left";

const state = {
  Right: { device: null, buf: "", lastFSR: null, lastIMU: null },
  Left:  { device: null, buf: "", lastFSR: null, lastIMU: null },
};

const el = {
  btnRight: document.getElementById("btnRight"),
  btnLeft: document.getElementById("btnLeft"),
  stRight: document.getElementById("stRight"),
  stLeft: document.getElementById("stLeft"),
  out: document.getElementById("out"),
  log: document.getElementById("log"),
};
  el.log.textContent = "";
  log("JS caricato ✅");
  document.getElementById("jsOk").textContent = "JS caricato ✅";

function log(msg) {
  const t = new Date().toLocaleTimeString();
  el.log.textContent = `${t}  ${msg}\n` + el.log.textContent.slice(0, 4000);
}

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
  const txt =
'RIGHT
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

el.btnRight.addEventListener("click", () => connectSide("Right").catch(e => log(`Right ERR: ${e}`)));
el.btnLeft.addEventListener("click", () => connectSide("Left").catch(e => log(`Left ERR: ${e}`)));
