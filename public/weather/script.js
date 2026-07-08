// ── Weather (full tab) ────────────────────────────────────────────────────
let wxLoaded = false;
const SHORT_DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function heroGradient(code, hour) {
  const c = +code;
  if (c === 200 || (c >= 386 && c <= 395)) return 'linear-gradient(160deg,#131c2b 0%,#060810 100%)';
  if (c >= 299 && c <= 359) return 'linear-gradient(160deg,#162435 0%,#060810 100%)';
  if ([119,122,143,248,260].includes(c)) return 'linear-gradient(160deg,#1e2730 0%,#060810 100%)';
  if ([227,230,323,326,329,332,335,338].includes(c)) return 'linear-gradient(160deg,#1b2b38 0%,#060810 100%)';
  if (hour >= 21 || hour < 5)  return 'linear-gradient(160deg,#0d1b2a 0%,#060810 100%)';
  if (hour < 8)                return 'linear-gradient(160deg,#2c1a4e 0%,#b05530 100%)';
  if (hour < 12)               return 'linear-gradient(160deg,#0e3a60 0%,#1a6ea8 100%)';
  if (hour < 17)               return 'linear-gradient(160deg,#0e3a72 0%,#1a5fa3 100%)';
  if (hour < 20)               return 'linear-gradient(160deg,#7d3066 0%,#b05530 100%)';
  return 'linear-gradient(160deg,#1a2540 0%,#060810 100%)';
}
function hourLabel(t) {
  const h = +t / 100;
  if (h === 0) return '12am'; if (h < 12) return h + 'am';
  if (h === 12) return '12pm'; return (h - 12) + 'pm';
}
function fmtTime(str) { return str ? str.replace(/^0/, '') : ''; }
function showWxError(msg) {
  document.getElementById('hero-wrap').innerHTML = '<div class="card mt-12" style="text-align:center;padding:40px 20px;color:var(--text-muted);">' + msg + '</div>';
}

function loadWx(city) {
  fetch('/api/weather?city=' + encodeURIComponent(city))
    .then(r => r.json()).then(renderWx).catch(() => showWxError('Weather unavailable.'));
}
function changeWxCity() {
  const inp = document.getElementById('wx-city-input');
  const city = inp.value.trim();
  if (!city) return;
  wxCity = city;
  localStorage.setItem('wxCity', city);
  loadWx(city);
}

function renderWx(data) {
  if (data.error) { showWxError(data.error); return; }
  const c    = data.current_condition[0];
  const area = data.nearest_area?.[0];
  const loc  = [area?.areaName?.[0]?.value, area?.region?.[0]?.value].filter(Boolean).join(', ');
  const today = data.weather?.[0];
  const hour  = new Date().getHours();
  const code  = c.weatherCode;

  document.getElementById('hero-wrap').innerHTML =
    '<div class="wx-hero" style="background:' + heroGradient(code, hour) + ';">' +
    '<div class="wx-hero-loc"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="opacity:.6"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>' + loc + '</div>' +
    '<div class="wx-hero-body"><div>' +
    '<div class="wx-temp">' + c.temp_C + '<sup>°</sup></div>' +
    '<div class="wx-desc">' + c.weatherDesc[0].value + '</div>' +
    '<div class="wx-sub">Feels like ' + c.FeelsLikeC + '°' + (today ? ' &nbsp;·&nbsp; H:' + today.maxtempC + '° &nbsp;L:' + today.mintempC + '°' : '') + '</div>' +
    '</div><div class="wx-icon-big">' + wxEmoji(code) + '</div></div></div>';

  const wind  = c.windspeedKmph + ' km/h ' + (c.winddir16Point || '');
  const uv    = +c.uvIndex;
  const uvLbl = uv <= 2 ? 'Low' : uv <= 5 ? 'Moderate' : uv <= 7 ? 'High' : uv <= 10 ? 'Very High' : 'Extreme';
  const stats = [
    { icon:'💧', val: c.humidity + '%',          lbl:'Humidity' },
    { icon:'💨', val: wind.trim(),                lbl:'Wind' },
    { icon:'🌡️', val: c.FeelsLikeC + '°C',      lbl:'Feels Like' },
    { icon:'☀️', val: uv + ' — ' + uvLbl,        lbl:'UV Index' },
    { icon:'👁️', val: c.visibility + ' km',      lbl:'Visibility' },
    { icon:'📊', val: c.pressure + ' mb',         lbl:'Pressure' },
  ];
  document.getElementById('stats-grid').innerHTML = stats.map(s =>
    '<div class="wx-stat"><div class="wx-stat-icon">' + s.icon + '</div><div class="wx-stat-val">' + s.val + '</div><div class="wx-stat-lbl">' + s.lbl + '</div></div>'
  ).join('');
  document.getElementById('stats-wrap').style.display = 'block';

  const astro = today?.astronomy?.[0];
  if (astro?.sunrise) {
    document.getElementById('sun-row').innerHTML =
      '<div class="wx-sun-card"><div class="wx-sun-emoji">🌅</div><div><div class="wx-sun-val">' + fmtTime(astro.sunrise) + '</div><div class="wx-sun-lbl">Sunrise</div></div></div>' +
      '<div class="wx-sun-card"><div class="wx-sun-emoji">🌇</div><div><div class="wx-sun-val">' + fmtTime(astro.sunset) + '</div><div class="wx-sun-lbl">Sunset</div></div></div>';
    document.getElementById('sun-wrap').style.display = 'block';
  }

  if (today?.hourly?.length) {
    const nowSlot = Math.round(hour / 3) * 3 * 100;
    let slots = today.hourly.map(h => ({ ...h, _day: 0 }));
    if (data.weather?.[1]) slots = slots.concat(data.weather[1].hourly.map(h => ({ ...h, _day: 1 })));
    const display = [...slots.filter(h => h._day === 0 && +h.time >= nowSlot - 300), ...slots.filter(h => h._day > 0)].slice(0, 10);
    document.getElementById('hourly-row').innerHTML = display.map(h => {
      const isNow = h._day === 0 && +h.time === nowSlot;
      const rain  = +h.chanceofrain;
      return '<div class="wx-hour' + (isNow ? ' now' : '') + '">' +
        '<div class="wx-hour-time">' + (isNow ? 'Now' : hourLabel(h.time)) + '</div>' +
        '<div class="wx-hour-icon">' + wxEmoji(h.weatherCode) + '</div>' +
        '<div class="wx-hour-temp">' + h.tempC + '°</div>' +
        '<div class="wx-hour-rain">' + (rain > 10 ? rain + '%' : '') + '</div></div>';
    }).join('');
    document.getElementById('hourly-wrap').style.display = 'block';
  }

  if (data.weather?.length) {
    renderDailyList(data.weather.map((day, i) => ({
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : SHORT_DAY[new Date(day.date).getDay()],
      emoji: wxEmoji(day.hourly?.[4]?.weatherCode ?? 113),
      lo: +day.mintempC, hi: +day.maxtempC,
      rain: Math.max(...(day.hourly || []).map(h => +h.chanceofrain || 0)),
    })), data.weather.length + '-Day Forecast');
    // wttr.in only gives 3 days — upgrade to 7 via Open-Meteo when we have coords
    upgradeTo7Day();
  }
}

// ── Daily forecast list (shared renderer) ──────────────────────────────────
function renderDailyList(days, hdr) {
  const weekMin = Math.min(...days.map(d => d.lo));
  const weekMax = Math.max(...days.map(d => d.hi));
  const range   = weekMax - weekMin || 1;
  document.getElementById('daily-hdr').textContent = hdr;
  document.getElementById('daily-list').innerHTML = days.map(d => {
    const left  = Math.round((d.lo - weekMin) / range * 100);
    const width = Math.max(6, Math.round((d.hi - d.lo) / range * 100));
    return '<div class="wx-day"><div class="wx-day-name">' + d.label + '</div><div class="wx-day-icon">' + d.emoji + '</div>' +
      '<div class="wx-day-lo">' + Math.round(d.lo) + '°</div>' +
      '<div class="wx-day-bar-wrap"><div class="wx-day-bar" style="left:' + left + '%;width:' + width + '%;"></div></div>' +
      '<div class="wx-day-hi">' + Math.round(d.hi) + '°</div>' +
      '<div class="wx-day-rain">' + (d.rain > 15 ? '💧' + Math.round(d.rain) + '%' : '') + '</div></div>';
  }).join('');
  document.getElementById('daily-wrap').style.display = 'block';
}

// WMO weather codes (Open-Meteo) → emoji
function wmoEmoji(c) {
  if (c === 0) return '☀️';
  if (c === 1) return '🌤️';
  if (c === 2) return '⛅';
  if (c === 3) return '☁️';
  if (c === 45 || c === 48) return '🌫️';
  if (c >= 51 && c <= 57) return '🌦️';
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return '🌧️';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return '❄️';
  if (c >= 95) return '⛈️';
  return '🌤️';
}

async function upgradeTo7Day() {
  const coords = (localStorage.getItem('wxCoords') || '').split(',');
  if (coords.length !== 2) return;
  try {
    const r = await fetch('/api/forecast?lat=' + coords[0] + '&lng=' + coords[1] + '&device=' + deviceId);
    const daily = await r.json();
    if (!daily?.time?.length) return;
    renderDailyList(daily.time.map((date, i) => ({
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : SHORT_DAY[new Date(date).getDay()],
      emoji: wmoEmoji(daily.weather_code?.[i]),
      lo: daily.temperature_2m_min[i], hi: daily.temperature_2m_max[i],
      rain: daily.precipitation_probability_max?.[i] || 0,
    })), daily.time.length + '-Day Forecast');
  } catch (_) { /* keep the 3-day wttr fallback */ }
}
