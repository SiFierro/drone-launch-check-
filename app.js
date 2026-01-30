const STORAGE_KEY = "droneQuickCheck.v3";
const LOG_KEY = "droneQuickCheck.log.v1";

const el = (id) => document.getElementById(id);

const metricsEl = el("metrics");
const statusEl  = el("status");
const locPill   = el("locPill");
const timePill  = el("timePill");

const overallBox = el("overallBox");
const overallStateEl = el("overallState");
const overallHintEl  = el("overallHint");

const settingsCard = el("settingsCard");
const toggleSettingsBtn = el("toggleSettingsBtn");

const updateBtn = el("updateBtn");
const useManualBtn = el("useManualBtn");
const logBtn = el("logBtn");

const logNoteEl = el("logNote");
const logListEl = el("logList");
const exportLogBtn = el("exportLogBtn");
const clearLogBtn = el("clearLogBtn");

let autoTimer = null;
let lastSnapshot = null;

// Your wind defaults:
const DEFAULTS = {
  units: "imperial",
  autoRefresh: "off",

  // wind/gust/precip/cloud: Green <= good, Yellow <= warn, Red > warn
  // visibility: Green >= good, Yellow >= warn, Red < warn
  windGood: 20, windWarn: 30,
  gustGood: 20, gustWarn: 30,

  visGood: 3,   visWarn: 1.5,      // miles or km
  precipGood: 0, precipWarn: 0.05, // mm/hr
  cloudGood: 70, cloudWarn: 90     // %
};

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
  renderLog();
}

function degToCompass(deg){
  if (deg === null || deg === undefined || Number.isNaN(deg)) return "—";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  const idx = Math.round(((deg % 360) / 22.5)) % 16;
  return dirs[idx];
}

/**
 * Wind arrow:
 * - Shows wind COMING FROM (meteorological standard).
 * - If deg=0 (north wind), arrow points up.
 */
function windArrowSvg(deg, sizeClass){
  const safeDeg = (deg === null || deg === undefined || Number.isNaN(deg)) ? 0 : deg;
  const aria = (deg === null || deg === undefined || Number.isNaN(deg))
    ? "Wind direction unavailable"
    : `Wind from ${Math.round(deg)} degrees`;

  // Simple arrow with a center circle, rotated around center.
  return `
    <div class="arrowWrap" title="${aria}">
      <span class="arrowBadge">FROM</span>
      <svg class="arrowSvg ${sizeClass}" viewBox="0 0 100 100" role="img" aria-label="${aria}">
        <g transform="rotate(${safeDeg} 50 50)">
          <circle cx="50" cy="50" r="30" fill="none" stroke="rgba(229,231,235,.20)" stroke-width="4"/>
          <line x1="50" y1="18" x2="50" y2="62" stroke="rgba(229,231,235,.95)" stroke-width="6" stroke-linecap="round"/>
          <polygon points="50,10 40,26 60,26" fill="rgba(229,231,235,.95)"/>
          <circle cx="50" cy="50" r="6" fill="rgba(229,231,235,.95)"/>
        </g>
      </svg>
    </div>
  `;
}

function classifyLTE(val, goodMax, warnMax){
  if (val === null || val === undefined || Number.isNaN(val)) return { cls:"warn", note:"No data" };
  if (val <= goodMax) return { cls:"good", note:"Good" };
  if (val <= warnMax) return { cls:"warn", note:"Danger" };
  return { cls:"bad", note:"No-go" };
}
function classifyGTE(val, goodMin, warnMin){
  if (val === null || val === undefined || Number.isNaN(val)) return { cls:"warn", note:"No data" };
  if (val >= goodMin) return { cls:"good", note:"Good" };
  if (val >= warnMin) return { cls:"warn", note:"Danger" };
  return { cls:"bad", note:"No-go" };
}

function format(val, unit, decimals=0){
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  return `${val.toFixed(decimals)} ${unit}`;
}

function setStatus(msg){ statusEl.textContent = msg; }

function buildMetricCard({label, valueHtml, hint, stateClass}){
  const div = document.createElement("div");
  div.className = `card metric ${stateClass || ""}`;
  div.innerHTML = `
    <div class="label">${label}</div>
    <div class="valueRow">${valueHtml}</div>
    <div class="hint">${hint || ""}</div>
  `;
  return div;
}

function renderSettings(cfg){
  el("units").value = cfg.units;
  el("autoRefresh").value = cfg.autoRefresh;

  el("windGood").value = cfg.windGood;
  el("windWarn").value = cfg.windWarn;

  el("gustGood").value = cfg.gustGood;
  el("gustWarn").value = cfg.gustWarn;

  el("visGood").value = cfg.visGood;
  el("visWarn").value = cfg.visWarn;

  el("precipGood").value = cfg.precipGood;
  el("precipWarn").value = cfg.precipWarn;

  el("cloudGood").value = cfg.cloudGood;
  el("cloudWarn").value = cfg.cloudWarn;
}

function readSettings(){
  const cfg = loadCfg();
  cfg.units = el("units").value;
  cfg.autoRefresh = el("autoRefresh").value;

  const num = (id) => parseFloat(el(id).value);

  cfg.windGood = num("windGood");
  cfg.windWarn = num("windWarn");

  cfg.gustGood = num("gustGood");
  cfg.gustWarn = num("gustWarn");

  cfg.visGood = num("visGood");
  cfg.visWarn = num("visWarn");

  cfg.precipGood = num("precipGood");
  cfg.precipWarn = num("precipWarn");

  cfg.cloudGood = num("cloudGood");
  cfg.cloudWarn = num("cloudWarn");

  return cfg;
}

function applyAutoRefresh(cfg){
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (cfg.autoRefresh === "off") return;

  const sec = parseInt(cfg.autoRefresh, 10);
  if (!Number.isFinite(sec) || sec <= 0) return;

  autoTimer = setInterval(() => { updateFromGPS().catch(()=>{}); }, sec * 1000);
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

async function fetchOpenMeteo(lat, lon){
  // current + sunrise/sunset for Night Ops
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lon)}` +
    "&current=temperature_2m,relative_humidity_2m,precipitation,cloud_cover,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m" +
    "&daily=sunrise,sunset" +
    "&wind_speed_unit=ms" +
    "&temperature_unit=fahrenheit" +
    "&precipitation_unit=mm" +
    "&timezone=auto";

  const r = await fetch(url);
  if (!r.ok) throw new Error("Weather fetch failed");
  return r.json();
}

function msToMph(ms){ return ms * 2.23693629; }
function mToMiles(m){ return m / 1609.344; }
function mToKm(m){ return m / 1000; }

// Approx moon illumination % (0–100), good enough for quick reference.
function moonIlluminationPct(date = new Date()){
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  let r = year % 100;
  r %= 19;
  if (r > 9) r -= 19;
  r = ((r * 11) % 30) + month + day;
  if (month < 3) r += 2;
  const phase = (r < 0 ? r + 30 : r) % 30; // 0..29
  const x = Math.abs(phase - 15) / 15; // 0 full, 1 new
  const illum = (1 - x) * 100;
  return Math.max(0, Math.min(100, illum));
}

function worstClass(classes){
  if (classes.includes("bad")) return "bad";
  if (classes.includes("warn")) return "warn";
  return "good";
}

function setOverall(overallCls){
  overallBox.classList.remove("good","warn","bad");
  overallBox.classList.add(overallCls);

  if (overallCls === "good"){
    overallStateEl.textContent = "GO";
    overallHintEl.textContent = "All key conditions are within your green thresholds.";
  } else if (overallCls === "warn"){
    overallStateEl.textContent = "CAUTION";
    overallHintEl.textContent = "One or more conditions are in your yellow (danger) range.";
  } else {
    overallStateEl.textContent = "NO-GO";
    overallHintEl.textContent = "One or more conditions exceed your red (no-go) thresholds.";
  }
}

function renderSnapshot(data, cfg, lat, lon){
  const c = data.current || {};
  const nowISO = c.time || new Date().toISOString();

  const windDirDeg = c.wind_direction_10m;
  const windDirTxt = degToCompass(windDirDeg);

  const windMs   = c.wind_speed_10m;
  const gustMs   = c.wind_gusts_10m;
  const visM     = c.visibility;
  const precip   = c.precipitation; // mm
  const cloud    = c.cloud_cover;   // %
  const tempF    = c.temperature_2m;

  // sunrise/sunset (today)
  const sunriseISO = data?.daily?.sunrise?.[0] || null;
  const sunsetISO  = data?.daily?.sunset?.[0]  || null;
  const now = new Date(nowISO);
  const sunrise = sunriseISO ? new Date(sunriseISO) : null;
  const sunset  = sunsetISO ? new Date(sunsetISO) : null;
  const isNight = (sunrise && sunset) ? (now < sunrise || now > sunset) : null;

  // Units
  let windVal, gustVal, windUnit, visVal, visUnit;
  if (cfg.units === "imperial"){
    windVal = (windMs==null? null : msToMph(windMs));
    gustVal = (gustMs==null? null : msToMph(gustMs));
    windUnit = "mph";
    visVal = (visM==null? null : mToMiles(visM));
    visUnit = "mi";
  } else {
    windVal = windMs; // m/s
    gustVal = gustMs; // m/s
    windUnit = "m/s";
    visVal = (visM==null? null : mToKm(visM));
    visUnit = "km";
  }

  // Classifications
  const windState   = classifyLTE(windVal, cfg.windGood, cfg.windWarn);
  const gustState   = classifyLTE(gustVal, cfg.gustGood, cfg.gustWarn);
  const visState    = classifyGTE(visVal, cfg.visGood, cfg.visWarn);
  const precipState = classifyLTE(precip, cfg.precipGood, cfg.precipWarn);
  const cloudState  = classifyLTE(cloud, cfg.cloudGood, cfg.cloudWarn);

  const overallCls = worstClass([windState.cls, gustState.cls, visState.cls, precipState.cls, cloudState.cls]);
  setOverall(overallCls);

  metricsEl.innerHTML = "";

  // Wind (steady) with small arrow (Option C)
  metricsEl.appendChild(buildMetricCard({
    label: "Wind (steady)",
    valueHtml: `
      <div class="value">${format(windVal, windUnit, 0)}</div>
      ${windArrowSvg(windDirDeg, "arrowSmall")}
    `,
    hint: `${windState.note} • Green ≤${cfg.windGood}, Yellow ≤${cfg.windWarn}, Red >${cfg.windWarn}`,
    stateClass: windState.cls
  }));

  // Gusts with small arrow (Option C)
  metricsEl.appendChild(buildMetricCard({
    label: "Gusts",
    valueHtml: `
      <div class="value">${format(gustVal, windUnit, 0)}</div>
      ${windArrowSvg(windDirDeg, "arrowSmall")}
    `,
    hint: `${gustState.note} • Green ≤${cfg.gustGood}, Yellow ≤${cfg.gustWarn}, Red >${cfg.gustWarn}`,
    stateClass: gustState.cls
  }));

  // Wind direction with big arrow (Option A)
  metricsEl.appendChild(buildMetricCard({
    label: "Wind direction",
    valueHtml: `
      <div>
        <div class="value">${windDirTxt}${(windDirDeg==null ? "" : ` (${Math.round(windDirDeg)}°)`)}</div>
        <div class="arrowText">Arrow shows wind <b>FROM</b> direction.</div>
      </div>
      ${windArrowSvg(windDirDeg, "arrowBig")}
    `,
    hint: "Use for launch/approach planning relative to obstacles.",
    stateClass: "good"
  }));

  // Visibility
  metricsEl.appendChild(buildMetricCard({
    label: "Visibility",
    valueHtml: `<div class="value">${format(visVal, visUnit, 1)}</div><div></div>`,
    hint: `${visState.note} • Green ≥${cfg.visGood}, Yellow ≥${cfg.visWarn}, Red <${cfg.visWarn}`,
    stateClass: visState.cls
  }));

  // Precipitation
  metricsEl.appendChild(buildMetricCard({
    label: "Precipitation",
    valueHtml: `<div class="value">${format(precip, "mm", 2)}</div><div></div>`,
    hint: `${precipState.note} • Green ≤${cfg.precipGood}, Yellow ≤${cfg.precipWarn}, Red >${cfg.precipWarn}`,
    stateClass: precipState.cls
  }));

  // Cloud cover
  metricsEl.appendChild(buildMetricCard({
    label: "Cloud cover",
    valueHtml: `<div class="value">${format(cloud, "%", 0)}</div><div></div>`,
    hint: `${cloudState.note} • Green ≤${cfg.cloudGood}%, Yellow ≤${cfg.cloudWarn}%, Red >${cfg.cloudWarn}%`,
    stateClass: cloudState.cls
  }));

  // Night Ops
  const moon = moonIlluminationPct(now);
  const nightTxt = (isNight === null) ? "—" : (isNight ? "NIGHT" : "DAY");
  const sunTxt = (sunrise && sunset)
    ? `Sunrise ${sunrise.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})} • Sunset ${sunset.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}`
    : "Sunrise/Sunset —";

  metricsEl.appendChild(buildMetricCard({
    label: "Night ops",
    valueHtml: `<div class="value">${nightTxt} • Moon ~${Math.round(moon)}%</div><div></div>`,
    hint: sunTxt,
    stateClass: (isNight ? "warn" : "good")
  }));

  // Temperature
  metricsEl.appendChild(buildMetricCard({
    label: "Temperature",
    valueHtml: `<div class="value">${format(tempF, "°F", 0)}</div><div></div>`,
    hint: "Battery performance, icing/condensation considerations.",
    stateClass: "good"
  }));

  // Pills
  locPill.textContent = `Loc: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  timePill.textContent = `Updated: ${new Date(nowISO).toLocaleString()}`;

  // Save for logging
  lastSnapshot = {
    timeISO: nowISO,
    lat, lon,
    overall: overallCls,
    wind: windVal, gust: gustVal, windUnit,
    windDirDeg, windDirTxt,
    vis: visVal, visUnit,
    precip, cloud, tempF,
    isNight, moonPct: moon,
    sunriseISO, sunsetISO
  };
}

async function updateFromGPS(){
  setStatus("Getting GPS location…");
  const cfg = loadCfg();

  const coords = await getGPS();
  const lat = coords.latitude;
  const lon = coords.longitude;

  setStatus("Fetching conditions…");
  const data = await fetchOpenMeteo(lat, lon);

  renderSnapshot(data, cfg, lat, lon);
  setStatus("Ready. Green=good • Yellow=danger • Red=no-go.");
}

async function updateFromManual(){
  const raw = prompt("Enter lat,lon (example: 33.5604,-81.7196)");
  if (!raw) return;
  const [latS, lonS] = raw.split(",").map(s => s.trim());
  const lat = parseFloat(latS), lon = parseFloat(lonS);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    alert("Invalid lat,lon");
    return;
  }
  setStatus("Fetching conditions…");
  const data = await fetchOpenMeteo(lat, lon);
  renderSnapshot(data, loadCfg(), lat, lon);
  setStatus("Ready. Green=good • Yellow=danger • Red=no-go.");
}

function renderLog(){
  const entries = loadLog();
  logListEl.innerHTML = "";

  if (!entries.length){
    logListEl.innerHTML = `<div class="small">No log entries yet.</div>`;
    return;
  }

  entries.slice(0, 25).forEach((e) => {
    const div = document.createElement("div");
    div.className = "logitem";
    div.innerHTML = `
      <div class="logmeta">
        <span><b>${e.decision.toUpperCase()}</b></span>
        <span>${new Date(e.createdAt).toLocaleString()}</span>
        <span>(${e.lat.toFixed(4)}, ${e.lon.toFixed(4)})</span>
        <span>Wind ${e.windTxt} • Gust ${e.gustTxt} • Vis ${e.visTxt}</span>
      </div>
      ${e.note ? `<div class="lognote">${e.note}</div>` : ""}
    `;
    logListEl.appendChild(div);
  });

  if (entries.length > 25){
    const more = document.createElement("div");
    more.className = "small";
    more.style.marginTop = "10px";
    more.textContent = `Showing latest 25 of ${entries.length}. Export to view all.`;
    logListEl.appendChild(more);
  }
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

function init(){
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});

  const cfg = loadCfg();
  renderSettings(cfg);
  applyAutoRefresh(cfg);
  renderLog();

  toggleSettingsBtn.addEventListener("click", () => {
    settingsCard.style.display = (settingsCard.style.display === "none") ? "block" : "none";
  });

  updateBtn.addEventListener("click", () => {
    updateFromGPS().catch((e)=>{
      console.error(e);
      setStatus("Couldn’t update. Make sure location is allowed and you’re on HTTPS.");
    });
  });

  useManualBtn.addEventListener("click", () => {
    updateFromManual().catch((e)=>{
      console.error(e);
      setStatus("Couldn’t update from manual location.");
    });
  });

  el("saveSettingsBtn").addEventListener("click", () => {
    const next = readSettings();
    saveCfg(next);
    renderSettings(next);
    applyAutoRefresh(next);
    setStatus("Thresholds saved. Tap Update to re-check.");
  });

  el("resetSettingsBtn").addEventListener("click", () => {
    saveCfg({ ...DEFAULTS });
    const next = loadCfg();
    renderSettings(next);
    applyAutoRefresh(next);
    setStatus("Defaults restored.");
  });

  logBtn.addEventListener("click", () => {
    if (!lastSnapshot){
      alert("Update first so there’s a snapshot to log.");
      return;
    }
    const decision =
      lastSnapshot.overall === "good" ? "go" :
      lastSnapshot.overall === "warn" ? "caution" : "no-go";

    addLog({
      createdAt: Date.now(),
      decision,
      note: (logNoteEl.value || "").trim(),
      lat: lastSnapshot.lat,
      lon: lastSnapshot.lon,
      windTxt: `${Math.round(lastSnapshot.wind ?? 0)} ${lastSnapshot.windUnit}`,
      gustTxt: `${Math.round(lastSnapshot.gust ?? 0)} ${lastSnapshot.windUnit}`,
      visTxt: `${(lastSnapshot.vis==null ? "—" : lastSnapshot.vis.toFixed(1))} ${lastSnapshot.visUnit}`,
      snapshot: lastSnapshot
    });

    logNoteEl.value = "";
    setStatus(`Logged: ${decision.toUpperCase()}.`);
  });

  exportLogBtn.addEventListener("click", exportLog);

  clearLogBtn.addEventListener("click", () => {
    if (!confirm("Clear all log entries from this device?")) return;
    saveLog([]);
    renderLog();
  });

  // Initial banner
  overallBox.classList.add("warn");
  overallStateEl.textContent = "—";
  overallHintEl.textContent = "Tap Update to calculate GO / CAUTION / NO-GO.";
}

init();
