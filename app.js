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

// Упрощает полигон (Douglas-Peucker) и считает его bounding box один раз при
// загрузке — это резко ускоряет classifyPoint на слабых устройствах:
// исходные границы содержат тысячи точек (например, Крым — 1175, Херсонская
// область — 1136), хотя для классификации точки маршрута такая точность не
// нужна. tolerance ~0.005° (≈500 м) — граница смещается на десятки-сотни
// метров, что не влияет на расчёт км по зонам на масштабе целого маршрута.
const ZONE_SIMPLIFY_TOLERANCE = 0.005;

function prepareZonePolygons(features) {
  return features.map((f) => {
    let feature = f;
    try {
      feature = turf.simplify(f, { tolerance: ZONE_SIMPLIFY_TOLERANCE, highQuality: false });
    } catch (e) {
      /* если упростить не удалось — используем исходный полигон */
    }
    return { feature, bbox: turf.bbox(feature) };
  });
}

// Быстрая проверка «точка рядом с этой зоной вообще?» по bounding box —
// на порядки дешевле полного point-in-polygon, отсеивает подавляющее
// большинство точек маршрута, которые заведомо далеко от зоны.
function pointInZonePolys(lon, lat, polys) {
  for (const { feature, bbox } of polys) {
    if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
    if (turf.booleanPointInPolygon([lon, lat], feature)) return true;
  }
  return false;
}

// Если пользователь перерисовал зону в редакторе (zones.html), берём его версию,
// иначе — встроенную границу по умолчанию.
function loadZonePolygons(zoneKey, defaultGeometries) {
  const raw = localStorage.getItem(CUSTOM_ZONE_PREFIX + zoneKey);
  if (raw) {
    try {
      const fc = JSON.parse(raw);
      if (fc.features && fc.features.length) return prepareZonePolygons(fc.features);
    } catch (e) {
      /* игнорируем повреждённые данные, используем дефолт */
    }
  }
  return prepareZonePolygons(defaultGeometries.map(toPolygonFeature));
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
  if (pointInZonePolys(lon, lat, CRIMEA_POLYS)) return 'crimea';
  if (pointInZonePolys(lon, lat, NEW_TERR_POLYS)) return 'new_territories';
  if (pointInZonePolys(lon, lat, RUSSIA_POLYS)) return 'russia';
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

function sleep0() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/* ==== Разбивка построенного маршрута по зонам ====
   coords — точки геометрии маршрута от OSRM, формат GeoJSON: [lon, lat].
   Считаем частями (CHUNK точек за раз) с паузой между частями — на слабых
   устройствах это не даёт браузеру «зависнуть» на весь расчёт целиком. */
const ZONE_CALC_CHUNK = 300;

async function computeZoneDistances(coords) {
  const totals = { crimea: 0, new_territories: 0, russia: 0, other: 0 };
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    const segKm = haversineKm(lon1, lat1, lon2, lat2);
    if (segKm > 0) {
      const midLon = (lon1 + lon2) / 2;
      const midLat = (lat1 + lat2) / 2;
      totals[classifyPoint(midLon, midLat)] += segKm;
    }
    if (i % ZONE_CALC_CHUNK === 0) await sleep0();
  }
  return totals;
}

/* ==== UI: тарифы и результат ==== */
const els = {
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  tariffCrimea: document.getElementById('tariffCrimea'),
  tariffNew: document.getElementById('tariffNew'),
  tariffRussia: document.getElementById('tariffRussia'),
  fromInput: document.getElementById('fromInput'),
  toInput: document.getElementById('toInput'),
  viaList: document.getElementById('viaList'),
  addViaBtn: document.getElementById('addViaBtn'),
  priceBtn: document.getElementById('priceBtn'),
};

let lastTotals = null;
let lastRouteCoords = null; // [[lon,lat], ...] геометрия маршрута от OSRM

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

// На мобильных тап по кнопке после ввода адреса сначала вызывает blur у
// поля ввода (это пересобирает маршрут и на миг прячет кнопку) — из-за
// этого сам тап по кнопке проваливается. preventDefault на touchstart/
// mousedown не даёт полю потерять фокus раньше, чем сработает клик.
els.priceBtn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
els.priceBtn.addEventListener('mousedown', (e) => e.preventDefault());

els.priceBtn.addEventListener('click', async () => {
  if (!lastRouteCoords) return;
  setStatus('Считаем…', 'loading');
  const totals = await computeZoneDistances(lastRouteCoords);
  setStatus('', null);
  renderResults(totals);
});

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

/* ==== Карта (Leaflet + OpenStreetMap), геокодер (Nominatim), маршрут (OSRM) ====
   Всё три сервиса бесплатны и не требуют API-ключей. */
let map = null;
let routeLayer = null;
const markers = {}; // slot -> L.marker, slot: 'from' | 'to' | via-<index>
let fromPoint = null; // [lat, lon]
let toPoint = null; // [lat, lon]
const viaPoints = []; // массив [lat, lon] | null, по одному на каждое доп. поле

function setStatus(text, kind) {
  els.status.textContent = text || '';
  els.status.className = kind ? `status ${kind}` : 'status';
}

// Превращает текстовый адрес в координаты [lat, lon] через Nominatim (OSM).
async function geocodeAddress(address) {
  const url =
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ru` +
    `&q=${encodeURIComponent(address)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`nominatim http ${resp.status}`);
  const data = await resp.json();
  if (!data.length) return null;
  return [Number(data[0].lat), Number(data[0].lon)];
}

// Запрашивает у OSRM геометрию маршрута по дорогам между точками.
// points — массив [lat, lon]. Возвращает координаты в формате GeoJSON [lon, lat].
async function fetchRouteGeometry(points) {
  const coords = points.map((p) => `${p[1]},${p[0]}`).join(';');
  // overview=simplified — geometry заметно компактнее full (по некоторым
  // маршрутам в разы меньше точек), для расчёта км по зонам этого достаточно,
  // а нагрузка на слабых устройствах ощутимо ниже.
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=simplified&geometries=geojson`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('OSRM недоступен');
  const data = await resp.json();
  if (!data.routes || !data.routes.length) throw new Error('Маршрут не найден');
  return data.routes[0].geometry.coordinates;
}

function setMarker(slot, coords) {
  if (markers[slot]) map.removeLayer(markers[slot]);
  markers[slot] = L.marker(coords).addTo(map);
}

// Привязывает геокодирование к полю ввода: адрес ищется по нажатию Enter
// или при уходе с поля.
function bindAddressInput(inputEl, onSelect) {
  if (!inputEl) return;
  const runGeocode = () => {
    const value = inputEl.value.trim();
    if (!value) return;
    setStatus('Ищем адрес…', 'loading');
    geocodeAddress(value)
      .then((coords) => {
        if (!coords) {
          setStatus('Не удалось найти этот адрес.', 'error');
          return;
        }
        setStatus('', null);
        onSelect(coords);
      })
      .catch((err) => {
        console.error('Ошибка геокодирования:', err);
        setStatus('Ошибка геокодирования — попробуйте ещё раз.', 'error');
      });
  };
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runGeocode();
    }
  });
  inputEl.addEventListener('blur', runGeocode);
}

function addViaInput() {
  if (!els.viaList) return;
  const index = viaPoints.length;
  viaPoints.push(null);

  const row = document.createElement('div');
  row.className = 'via-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Промежуточная точка — адрес, затем Enter';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'via-remove';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => {
    viaPoints[index] = null;
    if (markers['via-' + index]) {
      map.removeLayer(markers['via-' + index]);
      delete markers['via-' + index];
    }
    row.remove();
    rebuildRoute();
  });

  row.appendChild(input);
  row.appendChild(removeBtn);
  els.viaList.appendChild(row);

  bindAddressInput(input, (coords) => {
    viaPoints[index] = coords;
    setMarker('via-' + index, coords);
    rebuildRoute();
  });
}

function rebuildRoute() {
  els.priceBtn.classList.add('hidden');
  lastRouteCoords = null;

  const points = [fromPoint, ...viaPoints, toPoint].filter(Boolean);
  if (routeLayer) {
    map.removeLayer(routeLayer);
    routeLayer = null;
  }
  if (points.length < 2) return;

  setStatus('Строим маршрут…', 'loading');
  fetchRouteGeometry(points)
    .then((coords) => {
      lastRouteCoords = coords; // [[lon,lat], ...]
      const latLngs = coords.map(([lon, lat]) => [lat, lon]);
      routeLayer = L.polyline(latLngs, { color: '#d97757', weight: 4, opacity: 0.85 }).addTo(map);
      map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
      setStatus('', null);
      els.priceBtn.classList.remove('hidden');
    })
    .catch((err) => {
      console.error('Ошибка построения маршрута:', err);
      setStatus('Не удалось построить маршрут: ' + err.message, 'error');
    });
}

function handleMapClick(latlng) {
  // Клик по карте задаёт первую незаполненную точку — «Откуда», затем «Куда».
  const coords = [latlng.lat, latlng.lng];
  if (!fromPoint) {
    fromPoint = coords;
    setMarker('from', coords);
    setStatus('Точка «Откуда» поставлена кликом по карте.', null);
  } else if (!toPoint) {
    toPoint = coords;
    setMarker('to', coords);
    setStatus('Точка «Куда» поставлена кликом по карте.', null);
  } else {
    return;
  }
  rebuildRoute();
}

function initMapApp() {
  map = L.map('map').setView([45.3, 37.5], 6); // примерно между южной Россией и Крымом
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  map.on('click', (e) => handleMapClick(e.latlng));

  bindAddressInput(els.fromInput, (coords) => {
    fromPoint = coords;
    setMarker('from', coords);
    rebuildRoute();
  });
  bindAddressInput(els.toInput, (coords) => {
    toPoint = coords;
    setMarker('to', coords);
    rebuildRoute();
  });

  if (els.addViaBtn) {
    els.addViaBtn.addEventListener('click', addViaInput);
  }
}

initMapApp();
