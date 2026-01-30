const STORAGE_KEY = "droneQuickCheck.v7";
const LOG_KEY = "droneQuickCheck.log.v4";
const PREF_KEY = "droneQuickCheck.prefs.v1";
const LAUNCH_KEY = "droneQuickCheck.launch.v1";

const el = (id) => document.getElementById(id);

const statusEl = el("status");
const locPill = el("locPill");
const timePill = el("timePill");
const autoPill = el("autoPill");

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
let launchPoint = loadLaunchPoint(); // {lat, lon, timeISO}
let autoEnabled = loadPrefs().autoRefreshEnabled ?? false;
let autoTimer = null;
let countdownTimer = null;
let nextRefreshAt = null;

// Thresholds used internally (not displayed on tiles)
const DEFAULTS = {
  windGood: 20, windWarn: 30,
  gustGood: 20, gustWarn: 30,
  visGood: 3.0, visWarn: 1.5,
  precipGood: 0.00, precipWarn: 0.05,
  cloudGood: 70, cloudWarn: 90,
  battNormalF: 50,
  battSevereF: 20
};

const AUTO_REFRESH_MS = 5 * 60 * 1000;

// Ring distances (meters)
const RINGS = [
  { label: "250 ft", meters: 250 * 0.3048 },
  { label: "500 ft", meters: 500 * 0.3048 },
  { label: "1000 ft", meters: 1000 * 0.3048 },
  { label: "0.5 mi", meters: 0.5 * 1609.344 },
  { label: "1 mi", meters: 1 * 1609.344 },
  { label: "3 mi", meters: 3 * 1609.344 },
  { label: "5 mi", meters: 5 * 1609.344 },
];

function setStatus(msg){ statusEl.textContent = msg; }

function loadCfg(){
  try{
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}) };
  }catch{
    return { ...DEFAULTS };
  }
}

function loadPrefs(){
  try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; }
  catch { return {}; }
}
function savePrefs(p){
  localStorage.setItem(PREF_KEY, JSON.stringify(p));
}

function loadLaunchPoint(){
  try { return JSON.parse(localStorage.getItem(LAUNCH_KEY)) || null; }
  catch { return null; }
}
function saveLaunchPoint(lp){
  localStorage.setItem(LAUNCH_KEY, JSON.stringify(lp));
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

// -------- Weather fetch (FREE, no API key)
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

// Arrows using currentColor (adapts to tile text color)
function windArrowSmallSvg(deg){
  const safeDeg = (deg === null || deg === undefined || Number.isNaN(deg)) ? 0 : deg;
  return `
    <svg class="arrowSmall" viewBox="0 0 100 100" role="img" aria-label="Wind direction">
      <g transform="rotate(${safeDeg} 50 50)">
        <circle cx="50" cy="50" r="28" fill="none" stroke="currentColor" stroke-opacity=".18" stroke-width="4"/>
        <line x1="50" y1="18" x2="50" y2="62" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
        <polygon points="50,10 40,26 60,26" fill="currentColor"/>
        <circle cx="50" cy="50" r="6" fill="currentColor"/>
      </g>
    </svg>
  `;
}
function windArrowBigSvg(deg){
  const safeDeg = (deg === null || deg === undefined || Number.isNaN(deg)) ? 0 : deg;
  return `
    <svg class="arrowBig" viewBox="0 0 100 100" role="img" aria-label="Wind direction">
      <g transform="rotate(${safeDeg} 50 50)">
        <circle cx="50" cy="50" r="30" fill="none" stroke="currentColor" stroke-opacity=".18" stroke-width="4"/>
        <line x1="50" y1="18" x2="50" y2="62" stroke="currentColor" stroke-width="6" stroke-linecap="round"/>
        <polygon points="50,10 40,26 60,26" fill="currentColor"/>
        <circle cx="50" cy="50" r="6" fill="currentColor"/>
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

// Battery perf informational state
function batteryPerfState(tempF, cfg){
  if (tempF === null || tempF === undefined || Number.isNaN(tempF)) return { cls:"warn", label:"UNKNOWN" };
  if (tempF >= cfg.battNormalF) return { cls:"good", label:"NORMAL" };
  if (tempF < cfg.battSevereF) return { cls:"bad", label:"SEVERE" };
  return { cls:"warn", label:"DEGRADED" };
}

// ---------- Tiles (3x3) ----------
const TILE_ORDER = [
  "wind", "gusts", "dir",
  "vis", "wx", "tempbatt",
  "night", "map", "checklist"
];

function tileSpec(snapshot){
  const cfg = loadCfg();

  const windCls = classifyLTE(snapshot.windMph, cfg.windGood, cfg.windWarn);
  const gustCls = classifyLTE(snapshot.gustMph, cfg.gustGood, cfg.gustWarn);
  const visCls  = classifyGTE(snapshot.visMi, cfg.visGood, cfg.visWarn);

  const preCls  = classifyLTE(snapshot.precipMm, cfg.precipGood, cfg.precipWarn);
  const cldCls  = classifyLTE(snapshot.cloudPct, cfg.cloudGood, cfg.cloudWarn);
  const wxCls   = worstClass([preCls, cldCls]);

  const tempInfoCls = (snapshot.tempF !== null && snapshot.tempF !== undefined)
    ? (snapshot.tempF < 32 ? "warn" : "good")
    : "warn";

  const batt = batteryPerfState(snapshot.tempF, cfg);
  const tempBattCls = worstClass([tempInfoCls, batt.cls]); // informational only but still color-coded

  return {
    wind:   { key:"wind", label:"WIND", cls:windCls, value:`${formatNumber(snapshot.windMph,0)} mph`, sub:`${snapshot.windDirTxt}`, smallArrow:true },
    gusts:  { key:"gusts",label:"GUSTS",cls:gustCls, value:`${formatNumber(snapshot.gustMph,0)} mph`, sub:`${snapshot.windDirTxt}`, smallArrow:true },
    dir:    { key:"dir",  label:"DIR",  cls:"good", value:`${snapshot.windDirTxt}${snapshot.windDirDeg==null ? "" : ` (${Math.round(snapshot.windDirDeg)}°)`}`, sub:`Wind FROM`, bigArrow:true },

    vis:    { key:"vis",  label:"VIS",  cls:visCls, value:`${formatNumber(snapshot.visMi,1)} mi`, sub:`` },

    wx:     { key:"wx",   label:"WX",   cls:wxCls,
              value:`${formatNumber(snapshot.precipMm,2)} mm / ${formatNumber(snapshot.cloudPct,0)}%`,
              sub:`precip / cloud` },

    tempbatt:{ key:"tempbatt", label:"TEMP+BATT", cls:tempBattCls,
               value:`${formatNumber(snapshot.tempF,0)}°F • ${batt.label}`,
               sub:`informational` },

    night:  { key:"night",label:"NIGHT OPS", cls:snapshot.isNight ? "warn" : "good",
              value:`${snapshot.isNight ? "NIGHT" : "DAY"} • Moon ${Math.round(snapshot.moonPct)}%`,
              sub:`Sunrise ${snapshot.sunriseTxt} • Sunset ${snapshot.sunsetTxt}` },

    map:    { key:"map", label:"MAP", cls:"neutral", value:`${launchPoint ? "Launch set" : "No launch set"}`, sub:`Tap for rings + wind` },
    checklist:{ key:"checklist", label:"CHECKLIST", cls:"neutral", value:`Mavic 3T • Aloft`, sub:`Tap full-screen` }
  };
}

function renderTiles(snapshot){
  const specs = tileSpec(snapshot);
  grid.innerHTML = "";

  TILE_ORDER.forEach((k) => {
    const t = specs[k];
    const div = document.createElement("div");

    const tileClass = (t.cls === "neutral") ? "tile neutral" : `tile ${t.cls}`;
    div.className = tileClass;
    div.dataset.tile = t.key;

    const labelRight = t.smallArrow ? windArrowSmallSvg(snapshot.windDirDeg) : "";
    const bigArrow = t.bigArrow ? windArrowBigSvg(snapshot.windDirDeg) : "";

    div.innerHTML = `
      <div class="tLabel">
        <span>${escapeHtml(t.label)}</span>
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

// ---------- GO/CAUTION/NO-GO (WEATHER ONLY)
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

// ---------- Modal helpers
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

// ---------- Hourly trends (next 4 hours)
function findHourIndex(hourlyTimeISO, currentISO){
  const current = new Date(currentISO).getTime();
  let best = 0, bestDelta = Infinity;
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

// ---------- Tile actions
function openTileModal(key){
  if (!lastSnapshot && key !== "checklist" && key !== "map") {
    return openModal("No data yet", `
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Status</div><div class="dVal">Update first</div></div>
        <div class="tiny">Tap Update to pull conditions and set launch point.</div>
      </div>
    `);
  }

  if (key === "checklist") return openChecklist();
  if (key === "map") return openMap();

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

  const topCard = (title, value) => `
    <div class="detailCard">
      <div class="dRow"><div class="dKey">${escapeHtml(title)}</div><div class="dVal">${escapeHtml(value)}</div></div>
    </div>
  `;

  if (key === "wind") return openModal("Wind",
    topCard("Current", `${formatNumber(s.windMph,0)} mph`) + makeTrendList("Wind speed", "mph", windMphArr, v => v==null ? "—" : v.toFixed(0))
  );

  if (key === "gusts") return openModal("Gusts",
    topCard("Current", `${formatNumber(s.gustMph,0)} mph`) + makeTrendList("Wind gusts", "mph", gustMphArr, v => v==null ? "—" : v.toFixed(0))
  );

  if (key === "dir"){
    const items = hourIdxs.map((j) => {
      const t = toClock(times[j]);
      const d = dirArr[j];
      const txt = (d==null) ? "—" : `${degToCompass(d)} (${Math.round(d)}°)`;
      return `<div class="trendItem"><div><b>${t}</b></div><div>${txt}</div></div>`;
    }).join("");

    return openModal("Wind Direction", `
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
  }

  if (key === "vis") return openModal("Visibility",
    topCard("Current", `${formatNumber(s.visMi,1)} mi`) + makeTrendList("Visibility", "mi", visMiArr, v => v==null ? "—" : v.toFixed(1))
  );

  if (key === "wx"){
    return openModal("Weather (Precip / Cloud)", `
      ${topCard("Current", `${formatNumber(s.precipMm,2)} mm precip / ${formatNumber(s.cloudPct,0)}% cloud`)}
      ${makeTrendList("Precipitation", "mm", precipArr, v => v==null ? "—" : v.toFixed(2))}
      ${makeTrendList("Cloud cover", "%", cloudArr, v => v==null ? "—" : `${Math.round(v)}`)}
      <div class="tiny">WX tile combines precip + cloud so the dashboard stays 3×3 (no scroll).</div>
    `);
  }

  if (key === "tempbatt"){
    const cfg = loadCfg();
    const batt = batteryPerfState(s.tempF, cfg);
    return openModal("Temp + Battery Perf (Info)", `
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Ambient</div><div class="dVal">${s.tempF==null ? "—" : `${Math.round(s.tempF)}°F`}</div></div>
        <div class="dRow" style="margin-top:8px;"><div class="dKey">Battery perf</div><div class="dVal">${batt.label}</div></div>
        <div class="tiny">Informational only. Not tied to GO/NO-GO.</div>
      </div>
      ${makeTrendList("Ambient temperature", "°F", tempArr, v => v==null ? "—" : `${Math.round(v)}`)}
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Operational reminders</div><div class="dVal">—</div></div>
        <div class="tiny">
          • Pre-warm packs when possible<br/>
          • Rotate batteries more frequently<br/>
          • Avoid deep discharge under high load
        </div>
      </div>
    `);
  }

  if (key === "night"){
    return openModal("Night Ops", `
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Now</div><div class="dVal">${s.isNight ? "NIGHT" : "DAY"}</div></div>
        <div class="dRow" style="margin-top:8px;"><div class="dKey">Moon</div><div class="dVal">${Math.round(s.moonPct)}%</div></div>
      </div>
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Sunrise</div><div class="dVal">${s.sunriseTxt}</div></div>
        <div class="dRow" style="margin-top:8px;"><div class="dKey">Sunset</div><div class="dVal">${s.sunsetTxt}</div></div>
      </div>
    `);
  }
}

// ---------- Checklist (visual only)
function openChecklist(){
  openModal("Checklist (Visual)", `
    <div class="detailCard">
      <div class="dRow"><div class="dKey">Platform</div><div class="dVal">DJI Mavic 3T</div></div>
      <div class="dRow" style="margin-top:8px;"><div class="dKey">Streaming</div><div class="dVal">Aloft required</div></div>
      <div class="tiny">This is a quick-reference checklist (no inputs).</div>
    </div>

    <div class="sectionTitle">Admin / Accounts</div>
    <div class="checklistItem">Sign into correct DJI controller profile/account
      <small>Confirm mission/operator profile is correct before flight.</small>
    </div>
    <div class="checklistItem">Sign into Aloft and start mission streaming
      <small>Confirm streaming is active before launch.</small>
    </div>

    <div class="sectionTitle">Scene Setup</div>
    <div class="checklistItem">Set out landing pad / designate launch area
      <small>Keep props clear, control rotor wash area.</small>
    </div>
    <div class="checklistItem">Perimeter / bystanders controlled
      <small>Assign someone to keep people back if needed.</small>
    </div>

    <div class="sectionTitle">Airspace / Authorization</div>
    <div class="checklistItem">Check airspace in Aloft (restrictions / authorizations)
      <small>Confirm any LAANC/TFR considerations.</small>
    </div>

    <div class="sectionTitle">Aircraft / Systems</div>
    <div class="checklistItem">Batteries seated &amp; sufficient charge
      <small>Plan for return reserve &amp; time-on-station needs.</small>
    </div>
    <div class="checklistItem">Props/arms/airframe quick check
      <small>Loose props, cracks, gimbal cover, lens clean.</small>
    </div>
    <div class="checklistItem">Recording / storage ready (if needed)
      <small>SD card space, record toggle, correct camera mode.</small>
    </div>

    <div class="sectionTitle">Plan / Comms</div>
    <div class="checklistItem">Objective, search pattern, and comms plan briefed
      <small>Who is PIC / VO (if used), emergency actions, lost link plan.</small>
    </div>

    <div class="sectionTitle">Night Ops (if night)</div>
    <div class="checklistItem">Strobes / visibility measures set
      <small>Confirm required lighting and situational awareness.</small>
    </div>
  `);
}

// ---------- Map (OpenStreetMap + rings + launch marker)
function openMap(){
  const lp = launchPoint;
  const cur = lastSnapshot ? { lat: lastSnapshot.lat, lon: lastSnapshot.lon } : null;

  openModal("Map (Launch + Rings)", `
    <div class="detailCard">
      <div class="dRow"><div class="dKey">Launch From</div><div class="dVal">${lp ? `${lp.lat.toFixed(5)}, ${lp.lon.toFixed(5)}` : "Not set"}</div></div>
      <div class="dRow" style="margin-top:8px;"><div class="dKey">Rings</div><div class="dVal">${RINGS.map(r=>r.label).join(", ")}</div></div>
      <div class="tiny">Launch point is set when you tap Update.</div>
    </div>

    <div id="map"></div>

    <div class="detailCard" style="margin-top:10px;">
      <div class="dRow"><div class="dKey">Wind</div><div class="dVal">${lastSnapshot ? `${lastSnapshot.windDirTxt} • ${Math.round(lastSnapshot.windMph||0)} mph` : "—"}</div></div>
      <div class="tiny">Wind overlay is directional (from). This is for quick orientation.</div>
    </div>
  `);

  // Defer map init until modal DOM is painted
  setTimeout(() => {
    try {
      initLeafletMap(lp, cur, lastSnapshot);
    } catch (e) {
      console.error(e);
      const mapDiv = document.getElementById("map");
      if (mapDiv) mapDiv.innerHTML = `<div class="tiny">Map failed to load. (No network or blocked CDN.)</div>`;
    }
  }, 60);
}

let _leafletMap = null;
function initLeafletMap(lp, cur, snap){
  const mapDiv = document.getElementById("map");
  if (!mapDiv) return;

  // Kill any prior map instance if re-opening
  if (_leafletMap) {
    _leafletMap.remove();
    _leafletMap = null;
  }

  const center = lp ? [lp.lat, lp.lon] : (cur ? [cur.lat, cur.lon] : [33.5604, -81.7196]); // fallback
  const map = L.map(mapDiv, { zoomControl: true }).setView(center, 13);
  _leafletMap = map;

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const launchIcon = L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:999px;background:#60a5fa;border:2px solid #0b1220;box-shadow:0 0 0 2px rgba(96,165,250,.25);"></div>`,
    iconSize: [14,14],
    iconAnchor: [7,7]
  });

  const currentIcon = L.divIcon({
    className: "",
    html: `<div style="width:12px;height:12px;border-radius:999px;background:#e5e7eb;border:2px solid #0b1220;opacity:.95;"></div>`,
    iconSize: [12,12],
    iconAnchor: [6,6]
  });

  let bounds = [];

  if (lp){
    L.marker([lp.lat, lp.lon], { icon: launchIcon }).addTo(map).bindPopup("Launch From");
    bounds.push([lp.lat, lp.lon]);

    // rings around launch
    for (const r of RINGS) {
      const c = L.circle([lp.lat, lp.lon], {
        radius: r.meters,
        color: "#94a3b8",
        weight: 1,
        opacity: 0.55,
        fillOpacity: 0.02
      }).addTo(map);
      c.bindTooltip(r.label, { permanent:false, direction:"center" });
    }
  }

  if (cur){
    L.marker([cur.lat, cur.lon], { icon: currentIcon }).addTo(map).bindPopup("Current");
    bounds.push([cur.lat, cur.lon]);
  }

  // wind overlay: small arrow line from center pointing "from" direction
  if (lp && snap && snap.windDirDeg != null){
    const fromDeg = snap.windDirDeg;
    const lineLen = 600; // meters visual line
    const dest = destinationPoint(lp.lat, lp.lon, (fromDeg + 180) % 360, lineLen); // draw "toward" to show incoming
    L.polyline([[lp.lat, lp.lon],[dest.lat, dest.lon]], {
      color:"#e5e7eb", weight:3, opacity:0.65
    }).addTo(map);
  }

  if (bounds.length >= 2) {
    map.fitBounds(bounds, { padding:[20,20] });
  } else {
    map.setView(center, 13);
  }
}

function destinationPoint(lat, lon, bearingDeg, distanceMeters){
  const R = 6371000;
  const brng = bearingDeg * Math.PI/180;
  const φ1 = lat * Math.PI/180;
  const λ1 = lon * Math.PI/180;
  const δ = distanceMeters / R;

  const φ2 = Math.asin(Math.sin(φ1)*Math.cos(δ) + Math.cos(φ1)*Math.sin(δ)*Math.cos(brng));
  const λ2 = λ1 + Math.atan2(Math.sin(brng)*Math.sin(δ)*Math.cos(φ1), Math.cos(δ)-Math.sin(φ1)*Math.sin(φ2));
  return { lat: φ2*180/Math.PI, lon: ((λ2*180/Math.PI + 540) % 360) - 180 };
}

// ---------- More menu (Auto refresh + Export + Log)
function openMoreModal(){
  const autoText = autoEnabled ? "ON" : "OFF";
  const nextTxt = (autoEnabled && nextRefreshAt) ? `Next in ${formatCountdown(nextRefreshAt - Date.now())}` : "—";

  openModal("More", `
    <div class="detailCard">
      <div class="dRow"><div class="dKey">Auto refresh</div><div class="dVal">${autoText}</div></div>
      <div class="dRow" style="margin-top:8px;"><div class="dKey">Every</div><div class="dVal">5 min</div></div>
      <div class="dRow" style="margin-top:8px;"><div class="dKey">Countdown</div><div class="dVal">${escapeHtml(nextTxt)}</div></div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;">
        <button class="secondary" id="toggleAuto">${autoEnabled ? "Turn OFF" : "Turn ON"}</button>
        <button class="secondary" id="exportReport">Export report</button>
        <button class="ghost" id="openLog">Launch log</button>
      </div>

      <div class="tiny" style="margin-top:10px;">
        Export opens a printable report. On iPhone: Share → Print → Save as PDF.
      </div>
    </div>
  `);

  setTimeout(() => {
    document.getElementById("toggleAuto")?.addEventListener("click", () => {
      setAutoRefresh(!autoEnabled);
      closeModal();
      setStatus(`Auto refresh ${autoEnabled ? "ON" : "OFF"}.`);
      refreshAutoPill();
    });
    document.getElementById("exportReport")?.addEventListener("click", () => {
      exportReport();
    });
    document.getElementById("openLog")?.addEventListener("click", () => openLogModal());
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
      </div>
    `;
  }).join("");

  openModal("Launch Log", `
    <div class="detailCard">
      <div class="dRow"><div class="dKey">Entries shown</div><div class="dVal">${Math.min(entries.length, 50)}</div></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;">
        <button class="secondary" id="clearLog">Clear</button>
      </div>
      <div class="tiny" style="margin-top:10px;">Log entries are created automatically when you export a report.</div>
    </div>

    ${list || `<div class="tiny">No entries yet.</div>`}
  `);

  setTimeout(() => {
    document.getElementById("clearLog")?.addEventListener("click", () => {
      if (!confirm("Clear all log entries from this device?")) return;
      saveLog([]);
      closeModal();
      setStatus("Log cleared.");
    });
  }, 0);
}

// ---------- Export report (PDF-style via Print)
function exportReport(){
  if (!lastSnapshot){
    return openModal("Export report", `
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Status</div><div class="dVal">Update first</div></div>
        <div class="tiny">Run Update to capture weather + location + launch point, then export.</div>
      </div>
    `);
  }

  const s = lastSnapshot;
  const lp = launchPoint;

  const decision = s.overall === "good" ? "GO" : (s.overall === "warn" ? "CAUTION" : "NO-GO");

  // Static OSM map image (free, no key). Marker at launch + current.
  // NOTE: This is a convenience image for the report.
  const staticMapUrl = buildStaticMapUrl(lp, { lat:s.lat, lon:s.lon });

  const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Drone Launch Report</title>
<style>
  body{ font-family: -apple-system, system-ui, Segoe UI, Roboto, Arial; margin: 22px; color:#111; }
  h1{ margin:0 0 6px; font-size:20px; }
  .sub{ color:#444; margin-bottom:14px; font-size:12px; }
  .pill{ display:inline-block; padding:4px 10px; border-radius:999px; font-weight:900; font-size:12px; }
  .go{ background:#d1fae5; color:#065f46; }
  .caution{ background:#fffbeb; color:#92400e; }
  .nogo{ background:#fee2e2; color:#991b1b; }
  .grid{ display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:12px; }
  .card{ border:1px solid #ddd; border-radius:12px; padding:12px; }
  .k{ color:#666; font-size:12px; }
  .v{ font-size:16px; font-weight:900; margin-top:2px; }
  img{ max-width:100%; border-radius:12px; border:1px solid #ddd; }
  .small{ font-size:11px; color:#555; margin-top:10px; line-height:1.35; }
  @media print {
    body{ margin: 0.5in; }
  }
</style>
</head>
<body>
  <h1>Drone Launch Report</h1>
  <div class="sub">
    Generated: ${new Date().toLocaleString()}<br/>
    Snapshot: ${new Date(s.timeISO).toLocaleString()}
  </div>

  <div>
    <span class="pill ${decision === "GO" ? "go" : (decision==="CAUTION" ? "caution" : "nogo")}">${decision}</span>
  </div>

  <div class="grid">
    <div class="card">
      <div class="k">Location</div>
      <div class="v">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</div>
      <div class="small">Launch From: ${lp ? `${lp.lat.toFixed(5)}, ${lp.lon.toFixed(5)}` : "Not set"}</div>
    </div>

    <div class="card">
      <div class="k">Wind</div>
      <div class="v">${Math.round(s.windMph || 0)} mph • Gust ${Math.round(s.gustMph || 0)} mph</div>
      <div class="small">Direction: ${s.windDirTxt}${s.windDirDeg==null ? "" : ` (${Math.round(s.windDirDeg)}°)`}</div>
    </div>

    <div class="card">
      <div class="k">Visibility</div>
      <div class="v">${(s.visMi==null ? "—" : s.visMi.toFixed(1))} mi</div>
      <div class="small">Cloud: ${s.cloudPct==null ? "—" : Math.round(s.cloudPct)}% • Precip: ${s.precipMm==null ? "—" : s.precipMm.toFixed(2)} mm</div>
    </div>

    <div class="card">
      <div class="k">Night Ops</div>
      <div class="v">${s.isNight ? "NIGHT" : "DAY"} • Moon ${Math.round(s.moonPct)}%</div>
      <div class="small">Sunrise ${s.sunriseTxt} • Sunset ${s.sunsetTxt}</div>
    </div>
  </div>

  <div class="card" style="margin-top:12px;">
    <div class="k">Map</div>
    <div class="small">Rings: ${RINGS.map(r => r.label).join(", ")} (centered on Launch From)</div>
    ${staticMapUrl ? `<img src="${staticMapUrl}" alt="Map"/>` : `<div class="small">Map image unavailable.</div>`}
    <div class="small">Tip: rings are shown in-app. The report includes this map as a visual reference.</div>
  </div>
</body>
</html>`;

  const w = window.open("", "_blank");
  if (!w) {
    return openModal("Export report", `
      <div class="detailCard">
        <div class="dRow"><div class="dKey">Popup blocked</div><div class="dVal">Allow popups</div></div>
        <div class="tiny">Safari may block the report window. Allow popups for this site and try again.</div>
      </div>
    `);
  }
  w.document.open();
  w.document.write(html);
  w.document.close();

  // Also log the export automatically (simple, defensible)
  addLog({
    createdAt: Date.now(),
    decision: decision.toLowerCase(),
    lat: s.lat,
    lon: s.lon,
    windTxt: `${Math.round(s.windMph ?? 0)} mph`,
    gustTxt: `${Math.round(s.gustMph ?? 0)} mph`,
    visTxt: `${(s.visMi==null ? "—" : s.visMi.toFixed(1))} mi`,
    snapshot: s,
    launchPoint: launchPoint
  });

  setStatus("Report opened. Use Share → Print → Save as PDF.");
}

function buildStaticMapUrl(lp, cur){
  // Uses staticmap.openstreetmap.de (free, no key)
  // Markers: red = launch, blue = current
  const center = lp ? `${lp.lat},${lp.lon}` : `${cur.lat},${cur.lon}`;
  const zoom = 13;
  const size = "800x450";

  const markers = [];
  if (lp) markers.push(`markers=${lp.lat},${lp.lon},red-pushpin`);
  if (cur) markers.push(`markers=${cur.lat},${cur.lon},blue-pushpin`);

  // Some networks may block this. If it fails, report still works.
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${encodeURIComponent(center)}&zoom=${zoom}&size=${size}&maptype=mapnik&${markers.join("&")}`;
}

function formatCountdown(ms){
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2,"0")}`;
}

// ---------- Auto refresh
function refreshAutoPill(){
  if (!autoEnabled){
    autoPill.textContent = "Auto: OFF";
    return;
  }
  const remaining = nextRefreshAt ? Math.max(0, nextRefreshAt - Date.now()) : 0;
  autoPill.textContent = `Auto: ON • ${formatCountdown(remaining)}`;
}

function setAutoRefresh(enable){
  autoEnabled = enable;
  savePrefs({ ...loadPrefs(), autoRefreshEnabled: autoEnabled });

  if (autoTimer) clearInterval(autoTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  autoTimer = null;
  countdownTimer = null;
  nextRefreshAt = null;

  if (autoEnabled){
    nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
    autoTimer = setInterval(() => {
      nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
      refreshAutoPill();
      updateFromGPS(true).catch(()=>{});
    }, AUTO_REFRESH_MS);

    countdownTimer = setInterval(() => {
      refreshAutoPill();
    }, 1000);
  }

  refreshAutoPill();
}

// ---------- Snapshot build
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

  return {
    timeISO: nowISO,
    lat, lon,
    windMph, gustMph, windDirDeg, windDirTxt,
    visMi, precipMm, cloudPct, tempF,
    isNight, sunriseTxt, sunsetTxt, moonPct,
    raw: data
  };
}

// ---------- Update pipeline
async function updateFromGPS(isAuto=false){
  setStatus(isAuto ? "Auto refreshing…" : "Getting GPS…");
  const coords = await getGPS();
  const lat = coords.latitude;
  const lon = coords.longitude;

  setStatus("Fetching weather…");
  const data = await fetchOpenMeteo(lat, lon);

  const snap = buildSnapshot(data, lat, lon);

  // Launch point set from Update location (your requirement)
  launchPoint = { lat, lon, timeISO: snap.timeISO };
  saveLaunchPoint(launchPoint);

  locPill.textContent = `Loc: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  timePill.textContent = `Updated: ${new Date(snap.timeISO).toLocaleString()}`;

  lastSnapshot = snap;
  setOverallState(lastSnapshot);
  renderTiles(lastSnapshot);

  if (autoEnabled) nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
  refreshAutoPill();

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

  // Manual update ALSO sets launch point (consistent with “Update location” rule)
  launchPoint = { lat, lon, timeISO: snap.timeISO };
  saveLaunchPoint(launchPoint);

  locPill.textContent = `Loc: ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  timePill.textContent = `Updated: ${new Date(snap.timeISO).toLocaleString()}`;

  lastSnapshot = snap;
  setOverallState(lastSnapshot);
  renderTiles(lastSnapshot);

  if (autoEnabled) nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
  refreshAutoPill();

  setStatus("Ready.");
}

// ---------- Events
updateBtn.addEventListener("click", () => {
  updateFromGPS(false).catch((e) => {
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

// ---------- SW
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(()=>{});
}

// ---------- Init
function renderEmpty(){
  goState.textContent = "—";
  goBar.classList.remove("good","warn","bad");
  goBar.classList.add("warn");

  // Placeholder 3x3
  grid.innerHTML = "";
  TILE_ORDER.forEach((k) => {
    const div = document.createElement("div");
    const neutral = (k === "map" || k === "checklist");
    div.className = neutral ? "tile neutral" : "tile warn";
    div.innerHTML = `
      <div class="tLabel"><span>${k.toUpperCase()}</span><span></span></div>
      <div class="tValueRow"><div class="tValue">—</div><div></div></div>
      <div class="tSub"></div>
    `;
    div.addEventListener("click", () => openTileModal(k));
    grid.appendChild(div);
  });
}
renderEmpty();

// Apply saved auto refresh preference
setAutoRefresh(autoEnabled);
