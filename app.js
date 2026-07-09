/* ==== Константы зон и тарифов ==== */
const ZONES = {
  crimea: { label: 'Крым', color: '#d97757', tariff: 50 },
  new_territories: { label: 'Новые территории', color: '#c9a227', tariff: 100 },
  russia: { label: 'Россия', color: '#5b8ba0', tariff: 35 },
  other: { label: 'Вне тарифных зон', color: '#6b7280', tariff: 0 },
};

const NEW_TERR_KEYS = ['luhansk', 'donetsk', 'zaporizhzhia', 'kherson'];
const CUSTOM_ZONE_PREFIX = 'customZone_';

/* ==== Утилиты геометрии ==== */
function toPolygonFeature(geometry) {
  return { type: 'Feature', properties: {}, geometry };
}

// Если пользователь перерисовал зону в редакторе (zones.html), берём его версию,
// иначе — встроенную границу по умолчанию.
function loadZonePolygons(zoneKey, defaultGeometries) {
  const raw = localStorage.getItem(CUSTOM_ZONE_PREFIX + zoneKey);
  if (raw) {
    try {
      const fc = JSON.parse(raw);
      if (fc.features && fc.features.length) return fc.features;
    } catch (e) {
      /* игнорируем повреждённые данные, используем дефолт */
    }
  }
  return defaultGeometries.map(toPolygonFeature);
}

const CRIMEA_POLYS = loadZonePolygons('crimea', [ZONE_BOUNDARIES.crimea]);
const NEW_TERR_POLYS = loadZonePolygons(
  'new_territories',
  NEW_TERR_KEYS.map((k) => ZONE_BOUNDARIES.newTerritories[k])
);
const RUSSIA_POLYS = loadZonePolygons('russia', [ZONE_BOUNDARIES.russia]);

const usingCustomZones = ['crimea', 'new_territories', 'russia'].filter((k) =>
  localStorage.getItem(CUSTOM_ZONE_PREFIX + k)
);

function classifyPoint(lon, lat) {
  const pt = turf.point([lon, lat]);
  for (const poly of CRIMEA_POLYS) {
    if (turf.booleanPointInPolygon(pt, poly)) return 'crimea';
  }
  for (const poly of NEW_TERR_POLYS) {
    if (turf.booleanPointInPolygon(pt, poly)) return 'new_territories';
  }
  for (const poly of RUSSIA_POLYS) {
    if (turf.booleanPointInPolygon(pt, poly)) return 'russia';
  }
  return 'other';
}

function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ==== Разбор ссылки Яндекс.Карт ==== */
function extractYandexUrl(rawText) {
  if (!rawText) return null;
  const match = rawText.match(/https?:\/\/[^\s"'<>]+/);
  return match ? match[0] : null;
}

// Поддерживает rtext=lat,lon~lat,lon~... (основной формат ссылки на маршрут)
function parseWaypoints(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return { error: 'Не удалось распознать ссылку.' };
  }
  const rtext = u.searchParams.get('rtext');
  if (!rtext) {
    return {
      error:
        'В ссылке нет параметра маршрута (rtext). Похоже, это короткая ссылка или ссылка на точку, а не на маршрут. Откройте её в браузере, постройте маршрут и скопируйте адрес из строки браузера — там появится rtext=...',
    };
  }
  const points = rtext.split('~').map((pair) => {
    const [lat, lon] = pair.split(',').map(Number);
    return { lat, lon };
  });
  if (points.some((p) => Number.isNaN(p.lat) || Number.isNaN(p.lon))) {
    return { error: 'Не удалось распознать координаты в ссылке.' };
  }
  if (points.length < 2) {
    return { error: 'В ссылке меньше двух точек — нечего строить.' };
  }
  return { points };
}

/* ==== Запрос маршрута к OSRM (реальные дороги, не по прямой) ==== */
async function fetchRouteGeometry(points) {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Сервис построения маршрута недоступен');
  const data = await resp.json();
  if (!data.routes || !data.routes.length) throw new Error('Маршрут не найден');
  return data.routes[0].geometry.coordinates; // [ [lon,lat], ... ]
}

/* ==== Основной расчёт: км по зонам ==== */
function computeZoneDistances(coords) {
  const totals = { crimea: 0, new_territories: 0, russia: 0, other: 0 };
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const segKm = haversineKm(lon1, lat1, lon2, lat2);
    const midLon = (lon1 + lon2) / 2;
    const midLat = (lat1 + lat2) / 2;
    const zone = classifyPoint(midLon, midLat);
    totals[zone] += segKm;
  }
  return totals;
}

/* ==== UI ==== */
const els = {
  input: document.getElementById('linkInput'),
  calcBtn: document.getElementById('calcBtn'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  tariffCrimea: document.getElementById('tariffCrimea'),
  tariffNew: document.getElementById('tariffNew'),
  tariffRussia: document.getElementById('tariffRussia'),
};

let lastTotals = null;

function currentTariffs() {
  return {
    crimea: Number(els.tariffCrimea.value) || 0,
    new_territories: Number(els.tariffNew.value) || 0,
    russia: Number(els.tariffRussia.value) || 0,
    other: 0,
  };
}

function renderResults(totals) {
  lastTotals = totals;
  const tariffs = currentTariffs();
  const order = ['crimea', 'new_territories', 'russia', 'other'];
  let grandTotal = 0;
  let grandKm = 0;
  const rows = order
    .filter((k) => totals[k] > 0.01)
    .map((k) => {
      const km = totals[k];
      const price = km * tariffs[k];
      grandTotal += price;
      grandKm += km;
      return `
        <div class="zone-row" style="--zone-color:${ZONES[k].color}">
          <span class="zone-dot"></span>
          <span class="zone-name">${ZONES[k].label}</span>
          <span class="zone-km">${km.toFixed(1)} км</span>
          <span class="zone-price">${price.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽</span>
        </div>`;
    })
    .join('');

  els.results.innerHTML = `
    ${rows}
    <div class="zone-row total">
      <span class="zone-name">Итого</span>
      <span class="zone-km">${grandKm.toFixed(1)} км</span>
      <span class="zone-price">${grandTotal.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽</span>
    </div>
  `;
  els.results.classList.remove('hidden');
}

[els.tariffCrimea, els.tariffNew, els.tariffRussia].forEach((el) => {
  el.addEventListener('input', () => {
    if (lastTotals) renderResults(lastTotals);
  });
});

async function handleCalculate() {
  const raw = els.input.value.trim();
  const url = extractYandexUrl(raw);
  if (!url) {
    els.status.textContent = 'Вставьте ссылку на маршрут из Яндекс.Карт.';
    els.status.className = 'status error';
    return;
  }
  const parsed = parseWaypoints(url);
  if (parsed.error) {
    els.status.textContent = parsed.error;
    els.status.className = 'status error';
    els.results.classList.add('hidden');
    return;
  }
  els.status.textContent = 'Строим маршрут и определяем зоны…';
  els.status.className = 'status loading';
  els.results.classList.add('hidden');
  try {
    const coords = await fetchRouteGeometry(parsed.points);
    const totals = computeZoneDistances(coords);
    els.status.textContent = '';
    els.status.className = 'status';
    renderResults(totals);
  } catch (e) {
    els.status.textContent = 'Ошибка при построении маршрута: ' + e.message;
    els.status.className = 'status error';
  }
}

els.calcBtn.addEventListener('click', handleCalculate);

/* ==== Приём ссылки из "Поделиться" (share target) ==== */
(function initFromShare() {
  const params = new URLSearchParams(window.location.search);
  const shared = params.get('url') || params.get('text') || params.get('title');
  if (shared) {
    els.input.value = shared;
    handleCalculate();
  }
})();

/* ==== Индикатор пользовательских границ ==== */
(function showCustomZonesNote() {
  const note = document.getElementById('customZonesNote');
  if (!note) return;
  if (usingCustomZones.length) {
    const labels = usingCustomZones.map((k) => ZONES[k].label).join(', ');
    note.textContent = `Используются ваши границы для: ${labels}. Остальные зоны — по стандартным.`;
  }
})();

/* ==== Регистрация service worker ==== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
