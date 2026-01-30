const STORAGE_KEY = "droneQuickCheck.v5";
const LOG_KEY = "droneQuickCheck.log.v3";

const el = (id) => document.getElementById(id);

const statusEl = el("status");
const locPill = el("locPill");
const timePill = el("timePill");

const goBar = el("goBar");
const goState = el("goState");

const grid = el("grid");

const modal = el("modal");
const modalTitle = el("modalTitle");
const modalBody = el("modalBody");
const closeModalBtn = el("closeModal");

const updateBtn = el("updateBtn");
const manualBtn = el("manualBtn");
const moreBtn = el("moreBtn");

let lastSnapshot = null;

// Thresholds used internally (not shown on dashboard)
const DEFAULTS = {
  windGood: 20, windWarn: 30,
  gustGood: 20, gustWarn: 30,

  visGood: 3.0, visWarn: 1.5,

  precipGood: 0.00, precipWarn: 0.05,
  cloudGood: 70, cloudWarn: 90,

  // Battery perf (informational only)
  battNormalF: 50,
  battSevereF: 20
};

function setStatus(msg){ statusEl.textContent = msg; }

function loadCfg(){
  try{
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}) };
  }catch{
    return { ...DEFAULTS };
  }
}
function saveCfg(cfg){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

function loadLog(){
  try{ return JSON.parse(localStorage.getItem(LOG_KEY)) || []; }
  catch{ return []; }
}
function saveLog(entries){
  localStorage.setItem(LOG_KEY, JSON.stringify(entries));
}
function addLog(entry){
  const entries = loadLog();
  entries.unshift(entry);
  saveLog(entries);
}

// ---------- Weather fetch (FREE, no API key) ----------
async function fetchOpenMeteo(lat, lon){
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    "&current=temperature_2m,precipitation,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m" +
    "&hourly=temperature_2m,precipitation,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m" +
    "&daily=sunrise,sunset" +
    "&wind_speed_unit=ms" +
    "&temperature_unit=fahrenheit" +
    "&precipitation_unit=mm" +
    "&timezone=auto";

  const r = await fetch(url);
  if (!r.ok) throw new Error("Weather fetch failed");
  return r.json();
}

async function getGPS(){
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos.coords),
      (err) => reject(err),
      { enableHighAccuracy:true, timeout:12000, maximumAge:15000 }
    );
  });
}

function msToMph(ms){ return ms * 2.23693629; }
function mToMiles(m){ return m / 1609.344; }

function degToCompass(deg){
  if (deg === null || deg === undefined || Number.isNaN(deg)) return "—";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  const idx = Math.round(((deg % 360) / 22.5)) % 16;
  return dirs[idx];
}

function classifyLTE(val, goodMax, warnMax){
  if (val === null || val === undefined || Number.isNaN(val)) return "warn";
  if (val <= goodMax) return "good";
  if (val <= warnMax) return "warn";
  return "bad";
}
function classifyGTE(val, goodMin, warnMin){
  if (val === null || val === undefined || Number.isNaN(val)) return "warn";
  if (val >= goodMin) return "good";
  if (val >= warnMin) return "warn";
  return "bad";
}
function worstClass(classes){
  if (classes.includes("bad")) return "bad";
  if (classes.includes("warn")) return "warn";
  return "good";
}
function formatNumber(val, decimals=0){
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return val.toFixed(decimals);
}

// Small arrow (no badge) to save horizontal space
function windArrowSmallSvg(deg){
  const safeDeg = (deg === null || deg === undefined || Number.isNaN(deg)) ? 0 : deg;
  return `
    <svg class="arrowSmall" viewBox="0 0 100 100" role="img" aria-label="Wind direction">
      <g transform="rotate(${safeDeg} 50 50)">
        <circle cx="50" cy="50" r="28" fill="none" stroke="rgba(229,231,235,.20)" stroke-width="4"/>
        <line x1="50" y1="18" x2="50" y2="62" stroke="rgba(229,231,235,.95)" stroke-width="6" stroke-linecap="round"/>
        <polygon points="50,10 40,26 60,26" fill="rgba(229,231,235,.95)"/>
        <circle cx="50" cy="50" r="6" fill="rgba(229,231,235,.95)"/>
      </g>
    </svg>
  `;
}
function windArrowBigSvg(deg){
  const safeDeg = (deg === null || deg === undefined || Number.isNaN(deg)) ? 0 : deg;
  return `
    <svg class="arrowBig" viewBox="0 0 100 100" role="img" aria-label="Wind direction">
      <g transform="rotate(${safeDeg} 50 50)">
        <circle cx="50" cy="50" r="30" fill="none" stroke="rgba(229,231,235,.20)" stroke-width="4"/>
        <line x1="50" y1="18" x2="50" y2="62" stroke="rgba(229,231,235,.95)" stroke-width="6" stroke-linecap="round"/>
        <polygon points="50,10 40,26 60,26" fill="rgba(229,231,235,.95)"/>
        <circle cx="50" cy="50" r="6" fill="rgba(229,231,235,.95)"/>
      </g>
    </svg>
  `;
}

// Approx moon illumination %
function moonIlluminationPct(date = new Date()){
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  let r = year % 100;
  r %= 19;
  if (r > 9) r -= 19;
  r = ((r * 11) % 30) + month + day;
  if (month < 3) r += 2;
  const phase = (r < 0 ? r + 30 : r) % 30;
  const x = Math.abs(phase - 15) / 15;
  const illum = (1 - x) * 100;
  return Math.max(0, Math.min(100, illum));
}

// Battery perf (informational only)
function batteryPerfState(tempF, cfg){
  if (tempF === null || tempF === undefined || Number.isNaN(tempF)) return { cls:"warn", label:"UNKNOWN" };
  if (tempF >= cfg.battNormalF) return { cls:"good", label:"NORMAL" };
  if (tempF < cfg.battSevereF) return { cls:"bad", label:"SEVERE" };
  return { cls:"warn", label:"DEGRADED" };
}

// ---------- Tiles ----------
const TILE_ORDER = [
  "wind", "gusts", "dir",
  "vis", "precip", "cloud",
  "temp", "night", "battery"
];

function tileSpec(snapshot){
  const cfg = loadCfg();

  const windCls = classifyLTE(snapshot.windMph, cfg.windGood, cfg.windWarn);
  const gustCls = classifyLTE(snapshot.gustMph, cfg.gustGood, cfg.gustWarn);
  const visCls  = classifyGTE(snapshot.visMi, cfg.visGood, cfg.visWarn);
  const preCls  = classifyLTE(snapshot.precipMm, cfg.precipGood, cfg.precipWarn);
  const cldCls  = classifyLTE(snapshot.cloudPct, cfg.cloudGood, cfg.cloudWarn);

  // TEMP informational only
  const tempInfoCls = (snapshot.tempF !== null && snapshot.tempF !== undefined)
    ? (snapshot.tempF < 32 ? "warn" : "good")
    : "warn";

  const batt = batteryPerfState(snapshot.tempF, cfg);

  return {
    wind:   { key:"wind",   label:"WIND",        cls:windCls, value:`${formatNumber(snapshot.windMph,0)} mph`, sub:`${snapshot.windDirTxt}`, smallArrow:true },
    gusts:  { key:"gusts",  label:"GUSTS",       cls:gustCls, value:`${formatNumber(snapshot.gustMph,0)} mph`, sub:`${snapshot.windDirTxt}`, smallArrow:true },
    dir:    { key:"dir",    label:"DIR",         cls:"good",  value:`${snapshot.windDirTxt}${snapshot.windDirDeg==null ? "" : ` (${Math.round(snapshot.windDirDeg)}°)`}`, sub:`Wind FROM`, bigArrow:true },
    vis:    { key:"vis",    label:"VIS",         cls:visCls,  value:`${formatNumber(snapshot.visMi,1)} mi`, sub:`` },
    precip: { key:"precip", label:"PRECIP",      cls:preCls,  value:`${formatNumber(snapshot.precipMm,2)} mm`, sub:`` },
    cloud:  { key:"cloud",  label:"CLOUD",       cls:cldCls,  value:`${formatNumber(snapshot.cloudPct,0)}%`, sub:`` },
    temp:   { key:"temp",   label:"TEMP",        cls:tempInfoCls, value:`${formatNumber(snapshot.tempF,0)}°F`, sub:`` },
    night:  { key:"night",  label:"NIGHT OPS",   cls:snapshot.isNight ? "warn" : "good",
              value:`${snapshot.isNight ? "NIGHT" : "DAY"} • Moon ${Math.round(snapshot.moonPct)}%`,
              sub:`Sunrise ${snapshot.sunriseTxt} • Sunset ${snapshot.sunsetTxt}` },
    battery:{ key:"battery",label:"BATTERY PERF",cls:batt.cls, value:`${batt.label}`, sub:`${formatNumber(snapshot.tempF,0)}°F` }
  };
}

function renderTiles(snapshot){
  const specs = tileSpec(snapshot);
  grid.innerHTML = "";

  TILE_ORDER.forEach((k) => {
    const t = specs[k];
    const div = document.createElement("div");
    div.className = `tile ${t.cls}`;
    div.dataset.tile = t.key;

    const labelRight = t.smallArrow ? windArrowSmallSvg(snapshot.windDirDeg) : "";
    const bigArrow = setIf(t.bigArrow, windArrowBigSvg(snapshot.windDirDeg));

    div.innerHTML = `
      <div class="tLabel">
        <span>${t.label}</span>
        <span>${labelRight}</span>
      </div>

      <div class="tValueRow">
        <div class="tValue">${escapeHtml(t.value)}</div>
        ${bigArrow}
      </div>

      <div class="tSub">${escapeHtml(t.sub || "")}</div>
    `;

    div.addEventListener("click", () => openTileModal(t.key));
    grid.appendChild(div);
  });
}

function setIf(cond, html){ return cond ? html : ""; }

// ---------- GO / CAUTION / NO-GO ----------
function setOverallState(snapshot){
  const cfg = loadCfg();
  const windCls = classifyLTE(snapshot.windMph, cfg.windGood, cfg.windWarn);
  const gustCls = classifyLTE(snapshot.gustMph, cfg.gustGood, cfg.gustWarn);
  const visCls  = classifyGTE(snapshot.visMi, cfg.visGood, cfg.visWarn);
  const preCls  = classifyLTE(snapshot.precipMm, cfg.precipGood, cfg.precipWarn);
  const cldCls  = classifyLTE(snapshot.cloudPct, cfg.cloudGood, cfg.cloudWarn);

  const overall = worstClass([windCls, gustCls, visCls, preCls, cldCls]);

  goBar.classList.remove("good","warn","bad");
  goBar.classList.add(overall);

  goState.textContent = (overall === "good") ? "GO" : (overall === "warn" ? "CAUTION" : "NO-GO");
  snapshot.overall = overall;
}

// ---------- Modal ----------
function openModal(title, html){
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modal.classList.add("open");
}
function closeModal(){
  modal.classList.remove("open");
  modalTitle.textContent = "Details";
  modalBody.innerHTML = "";
}
closeModalBtn.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

// ---------- Hourly trend helpers ----------
function findHourIndex(hourlyTimeISO, currentISO){
  const current = new Date(currentISO).getTime();
  let best = 0;
  let bestDelta = Infinity;
  for (let i=0;i<hourlyTimeISO.length;i++){
    const t = new Date(hourlyTimeISO[i]).getTime();
    const d = Math.abs(t - current);
    if (d < bestDelta){ bestDelta = d; best = i; }
  }
  return best;
}
function pickNextHours(data, currentISO, n=4){
  const t = data.hourly?.time || [];
  const idx = t.length ? findHourIndex(t, currentISO) : 0;
  const out = [];
  for (let i=1;i<=n;i++){
    const j = idx + i;
    if (j < t.length) out.push(j);
  }
  return out;
}
function trendLabel(values){
  const v = values.filter(x => x !== null && x !== undefined && !Number.isNaN(x));
  if (v.length < 2) return "—";
  const delta = v[v.length-1] - v[0];
  const abs = Math.abs(delta);
  if (abs < 0.01) return "STABLE";
  return delta > 0 ? "INCREASING" : "DECREASING";
}

function openTileModal(key){
  if (!lastSnapshot) return;

  const s = lastSnapshot;
  const data = s.raw;

  const hourIdxs = pickNextHours(data, s.timeISO, 4);
  const times = data.hourly?.time || [];
  const toClock = (iso) => new Date(iso).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });

  const makeTrendList = (label, unit, values, formatter) => {
    const items = hourIdxs.map((j) => {
      const t = toClock(times[j]);
      const v = values[j];
      const txt = formatter(v);
      return `<div class="trendItem"><div><b>${t}</b></div><div>${txt} <span>${unit}</span></div></div>`;
    }).join("");

    const valsNext = hourIdxs.map(j => values[j]).filter(x => x != null && !Number.isNaN(x));
    return `
      <div class="detailCard">
        <div class="dRow">
          <div class="dKey">${label} (next 4 hours)</div>
          <div class="dVal">${trendLabel(valsNext)}</div>
        </div>
        <div class="trend">${items || `<div class="tiny">No hourly data.</div>`}</div>
      </div>
    `;
  };

  const h = data.hourly || {};
  const windMphArr = (h.wind_speed_10m || []).map(x => x==null ? null : msToMph(x));
  const gustMphArr = (h.wind_gusts_10m || []).map(x => x==null ? null : msToMph(x));
  const visMiArr   = (h.visibility || []).map(x => x==null ? null : mToMiles(x));
  const precipArr  = (h.precipitation || []);
  const cloudArr   = (h.cloud_cover || []);
  const tempArr    = (h.temperature_2m || []);
  const dirArr     = (h.wind_direction_10m || []);

  const topCard = `
    <div class="detailCard">
      <div class="dRow"><div class="dKey">Current</div><div class="dVal">${escapeHtml(s.tileReadout[key] || "—")}</div></div>
    </div>
  `;

  if (key === "wind"){
    openModal("Wind", topCard + makeTrendList("Wind speed", "mph", windMphArr, v => v==null ? "—" : v.toFixed(0)));
    return;
  }
  if (key === "gusts"){
    openModal("Gusts", topCard + makeTrendList("Wind gusts", "mph", gustMphArr, v => v==null ? "—" : v.toFixed(0)));
    return;
  }
  if (key === "dir"){
    const items = hourIdxs.map((j) => {
      const t = toClock(times[j]);
      const d = dirArr[j];
      const txt = (d==null) ? "—" : `${degToCompass(d)} (${Math.round(d)}°)`;
      return `<div class="trendItem"><div><b>${t}</b></div><div>${txt}</div></div>`;
    }).join("");

    openModal("Wind Direction", `
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Current</div><div class="dVal">${escapeHtml(s.windDirTxt)}${s.windDirDeg==null ? "" : ` (${Math.round(s.windDirDeg)}°)`}</div></div>
        <div style="display:flex;justify-content:center;margin-top:12px;">${windArrowBigSvg(s.windDirDeg)}</div>
        <div class="tiny">Arrow shows wind <b>FROM</b> direction.</div>
      </div>
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Next 4 hours</div><div class="dVal">—</div></div>
        <div class="trend">${items || `<div class="tiny">No hourly data.</div>`}</div>
      </div>
    `);
    return;
  }
  if (key === "vis"){
    openModal("Visibility", topCard + makeTrendList("Visibility", "mi", visMiArr, v => v==null ? "—" : v.toFixed(1)));
    return;
  }
  if (key === "precip"){
    openModal("Precipitation", topCard + makeTrendList("Precipitation", "mm", precipArr, v => v==null ? "—" : v.toFixed(2)));
    return;
  }
  if (key === "cloud"){
    openModal("Cloud Cover", topCard + makeTrendList("Cloud cover", "%", cloudArr, v => v==null ? "—" : `${Math.round(v)}`));
    return;
  }
  if (key === "temp"){
    openModal("Temperature", topCard + makeTrendList("Temperature", "°F", tempArr, v => v==null ? "—" : `${Math.round(v)}`));
    return;
  }
  if (key === "battery"){
    const cfg = loadCfg();
    const battNow = batteryPerfState(s.tempF, cfg);

    openModal("Battery Perf", `
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Current</div><div class="dVal">${battNow.label}</div></div>
        <div class="dRow" style="margin-top:8px;"><div class="dKey">Ambient</div><div class="dVal">${s.tempF==null ? "—" : `${Math.round(s.tempF)}°F`}</div></div>
        <div class="tiny">Informational only. Does not affect GO / NO-GO.</div>
      </div>
      ${makeTrendList("Ambient temperature", "°F", tempArr, v => v==null ? "—" : `${Math.round(v)}`)}
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Operational considerations</div><div class="dVal">—</div></div>
        <div class="tiny">
          • Pre-warm packs when possible<br/>
          • Rotate batteries more frequently<br/>
          • Avoid deep discharge under high load
        </div>
      </div>
    `);
    return;
  }
  if (key === "night"){
    openModal("Night Ops", `
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Now</div><div class="dVal">${s.isNight ? "NIGHT" : "DAY"}</div></div>
        <div class="dRow" style="margin-top:8px;"><div class="dKey">Moon</div><div class="dVal">${Math.round(s.moonPct)}%</div></div>
      </div>
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Sunrise</div><div class="dVal">${s.sunriseTxt}</div></div>
        <div class="dRow" style="margin-top:8px;"><div class="dKey">Sunset</div><div class="dVal">${s.sunsetTxt}</div></div>
      </div>
    `);
    return;
  }
}

// ---------- More menu (Log + Settings) ----------
function openMoreModal(){
  openModal("More", `
    <div class="detailCard">
      <div class="dRow"><div class="dKey">Actions</div><div class="dVal">—</div></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;">
        <button class="secondary" id="openLog">Launch Log</button>
        <button class="ghost" id="openSettings">Settings</button>
      </div>
      <div class="tiny" style="margin-top:10px;">
        Kept off the main bar to ensure the 3×3 grid always fits on iPhone.
      </div>
    </div>
  `);

  setTimeout(() => {
    document.getElementById("openLog")?.addEventListener("click", () => openLogModal());
    document.getElementById("openSettings")?.addEventListener("click", () => openSettingsModal());
  }, 0);
}

function openSettingsModal(){
  const cfg = loadCfg();
  openModal("Settings", `
    <div class="detailCard">
      <div class="dRow"><div class="dKey">Wind caution</div><div class="dVal">${cfg.windGood} mph</div></div>
      <div class="dRow" style="margin-top:10px;"><div class="dKey">Wind no-go</div><div class="dVal">${cfg.windWarn} mph</div></div>

      <div style="margin-top:12px; display:grid; gap:10px;">
        <label class="dKey">Wind caution (mph)</label>
        <input id="sWindGood" type="number" value="${cfg.windGood}" style="width:100%;padding:10px;border-radius:12px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;">

        <label class="dKey">Wind no-go (mph)</label>
        <input id="sWindWarn" type="number" value="${cfg.windWarn}" style="width:100%;padding:10px;border-radius:12px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;">

        <label class="dKey">Gust caution (mph)</label>
        <input id="sGustGood" type="number" value="${cfg.gustGood}" style="width:100%;padding:10px;border-radius:12px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;">

        <label class="dKey">Gust no-go (mph)</label>
        <input id="sGustWarn" type="number" value="${cfg.gustWarn}" style="width:100%;padding:10px;border-radius:12px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;">

        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;">
          <button class="secondary" id="saveSettings">Save</button>
          <button class="ghost" id="resetSettings">Reset</button>
        </div>
      </div>
    </div>
  `);

  setTimeout(() => {
    document.getElementById("saveSettings")?.addEventListener("click", () => {
      const next = loadCfg();
      next.windGood = parseFloat(document.getElementById("sWindGood")?.value) || DEFAULTS.windGood;
      next.windWarn = parseFloat(document.getElementById("sWindWarn")?.value) || DEFAULTS.windWarn;
      next.gustGood = parseFloat(document.getElementById("sGustGood")?.value) || DEFAULTS.gustGood;
      next.gustWarn = parseFloat(document.getElementById("sGustWarn")?.value) || DEFAULTS.gustWarn;

      saveCfg(next);
      if (lastSnapshot) { setOverallState(lastSnapshot); renderTiles(lastSnapshot); }
      closeModal();
      setStatus("Settings saved.");
    });

    document.getElementById("resetSettings")?.addEventListener("click", () => {
      saveCfg({ ...DEFAULTS });
      if (lastSnapshot) { setOverallState(lastSnapshot); renderTiles(lastSnapshot); }
      closeModal();
      setStatus("Settings reset.");
    });
  }, 0);
}

function openLogModal(){
  const entries = loadLog();

  const list = entries.slice(0, 50).map((e) => {
    return `
      <div class="detailCard">
        <div class="dRow"><div class="dKey">${new Date(e.createdAt).toLocaleString()}</div><div class="dVal">${e.decision.toUpperCase()}</div></div>
        <div class="tiny" style="margin-top:8px;">
          (${e.lat.toFixed(4)}, ${e.lon.toFixed(4)})<br/>
          Wind ${e.windTxt} • Gust ${e.gustTxt} • Vis ${e.visTxt}
        </div>
        ${e.note ? `<div class="tiny" style="margin-top:10px;color:#e5e7eb;white-space:pre-wrap;">${escapeHtml(e.note)}</div>` : ""}
      </div>
    `;
  }).join("");

  openModal("Launch Log", `
    <div class="detailCard">
      <label class="dKey">Note (optional)</label>
      <textarea id="logNote" style="width:100%;min-height:90px;padding:10px;border-radius:12px;border:1px solid #374151;background:#0b1220;color:#e5e7eb;"></textarea>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;">
        <button class="secondary" id="logDecision">Log</button>
        <button class="ghost" id="exportLog">Export</button>
        <button class="ghost" id="clearLog">Clear</button>
      </div>

      <div class="tiny" style="margin-top:10px;">Update first so the log captures the latest snapshot.</div>
    </div>

    ${list || `<div class="tiny">No entries yet.</div>`}
  `);

  setTimeout(() => {
    document.getElementById("logDecision")?.addEventListener("click", () => {
      if (!lastSnapshot) return alert("Update first so there’s a snapshot to log.");
      const note = (document.getElementById("logNote")?.value || "").trim();
      const decision = lastSnapshot.overall === "good" ? "go" : (lastSnapshot.overall === "warn" ? "caution" : "no-go");

      addLog({
        createdAt: Date.now(),
        decision,
        note,
        lat: lastSnapshot.lat,
        lon: lastSnapshot.lon,
        windTxt: `${Math.round(lastSnapshot.windMph ?? 0)} mph`,
        gustTxt: `${Math.round(lastSnapshot.gustMph ?? 0)} mph`,
        visTxt: `${(lastSnapshot.visMi==null ? "—" : lastSnapshot.visMi.toFixed(1))} mi`,
        snapshot: lastSnapshot
      });

      closeModal();
      setStatus(`Logged: ${decision.toUpperCase()}.`);
    });

    document.getElementById("exportLog")?.addEventListener("click", exportLog);
    document.getElementById("clearLog")?.addEventListener("click", () => {
      if (!confirm("Clear all log entries from this device?")) return;
      saveLog([]);
      closeModal();
      setStatus("Log cleared.");
    });
  }, 0);
}

function exportLog(){
  const entries = loadLog();
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `drone-launch-log-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Snapshot build ----------
function buildSnapshot(data, lat, lon){
  const c = data.current || {};
  const nowISO = c.time || new Date().toISOString();

  const windDirDeg = c.wind_direction_10m;
  const windDirTxt = degToCompass(windDirDeg);

  const windMph = c.wind_speed_10m == null ? null : msToMph(c.wind_speed_10m);
  const gustMph = c.wind_gusts_10m == null ? null : msToMph(c.wind_gusts_10m);

  const visMi = c.visibility == null ? null : mToMiles(c.visibility);
  const precipMm = c.precipitation ?? null;
  const cloudPct = c.cloud_cover ?? null;
  const tempF = c.temperature_2m ?? null;

  const sunriseISO = data?.daily?.sunrise?.[0] || null;
  const sunsetISO  = data?.daily?.sunset?.[0]  || null;
  const now = new Date(nowISO);
  const sunrise = sunriseISO ? new Date(sunriseISO) : null;
  const sunset  = sunsetISO ? new Date(sunsetISO) : null;
  const isNight = (sunrise && sunset) ? (now < sunrise || now > sunset) : false;

  const sunriseTxt = sunrise ? sunrise.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "—";
  const sunsetTxt  = sunset ? sunset.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "—";

  const moonPct = moonIlluminationPct(now);

  const cfg = loadCfg();

  const snapshot = {
    timeISO: nowISO,
    lat, lon,
    windMph, gustMph, windDirDeg, windDirTxt,
    visMi, precipMm, cloudPct, tempF,
    isNight, sunriseTxt, sunsetTxt, moonPct,
    raw: data
  };

  snapshot.tileReadout = {
    wind: `${formatNumber(windMph,0)} mph`,
    gusts: `${formatNumber(gustMph,0)} mph`,
    dir: `${windDirTxt}${windDirDeg==null ? "" : ` (${Math.round(windDirDeg)}°)`}`,
    vis: `${formatNumber(visMi,1)} mi`,
    precip: `${formatNumber(precipMm,2)} mm`,
    cloud: `${formatNumber(cloudPct,0)}%`,
    temp: `${formatNumber(tempF,0)}°F`,
    night: `${isNight ? "NIGHT" : "DAY"} • Moon ${Math.round(moonPct)}%`,
    battery: `${batteryPerfState(tempF, cfg).label}`
  };

  return snapshot;
}

// ---------- Update pipeline ----------
async function updateFromGPS(){
  setStatus("Getting GPS…");
  const coords = await getGPS();
  const lat = coords.latitude;
  const lon = coords.longitude;

  setStatus("Fetching weather…");
  const data = await fetchOpenMeteo(lat, lon);

  const snap = buildSnapshot(data, lat, lon);

  locPill.textContent = `Loc: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  timePill.textContent = `Updated: ${new Date(snap.timeISO).toLocaleString()}`;

  lastSnapshot = snap;
  setOverallState(lastSnapshot);
  renderTiles(lastSnapshot);

  setStatus("Ready.");
}

async function updateFromManual(){
  const raw = prompt("Enter lat,lon (example: 33.5604,-81.7196)");
  if (!raw) return;
  const [latS, lonS] = raw.split(",").map(s => s.trim());
  const lat = parseFloat(latS), lon = parseFloat(lonS);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return alert("Invalid lat,lon");

  setStatus("Fetching weather…");
  const data = await fetchOpenMeteo(lat, lon);

  const snap = buildSnapshot(data, lat, lon);

  locPill.textContent = `Loc: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  timePill.textContent = `Updated: ${new Date(snap.timeISO).toLocaleString()}`;

  lastSnapshot = snap;
  setOverallState(lastSnapshot);
  renderTiles(lastSnapshot);

  setStatus("Ready.");
}

// ---------- Events ----------
updateBtn.addEventListener("click", () => {
  updateFromGPS().catch((e) => {
    console.error(e);
    setStatus("Couldn’t update. Check location permission + network.");
  });
});
manualBtn.addEventListener("click", () => {
  updateFromManual().catch((e) => {
    console.error(e);
    setStatus("Manual update failed.");
  });
});
moreBtn.addEventListener("click", openMoreModal);

// ---------- Service Worker ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(()=>{});
}

// Initial placeholders
function renderEmpty(){
  goState.textContent = "—";
  goBar.classList.remove("good","warn","bad");
  goBar.classList.add("warn");

  grid.innerHTML = "";
  TILE_ORDER.forEach((k) => {
    const div = document.createElement("div");
    div.className = "tile warn";
    div.innerHTML = `
      <div class="tLabel"><span>${k.toUpperCase()}</span><span></span></div>
      <div class="tValueRow"><div class="tValue">—</div><div></div></div>
      <div class="tSub"></div>
    `;
    grid.appendChild(div);
  });
}
renderEmpty();
