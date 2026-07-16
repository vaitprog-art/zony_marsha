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

/* ==== Разбивка готового маршрута по зонам ====
   coords — массив точек геометрии маршрута в формате Яндекс.Карт: [lat, lon].
   Между соседними точками геометрии расстояние маленькое (несколько метров —
   десятки метров), поэтому дополнительный сэмплинг не нужен: сама геометрия
   уже достаточно подробная, чтобы поймать момент пересечения границы зоны. */
function computeZoneDistancesFromRoute(coords) {
  const totals = { crimea: 0, new_territories: 0, russia: 0, other: 0 };
  for (let i = 0; i < coords.length - 1; i++) {
    const [lat1, lon1] = coords[i];
    const [lat2, lon2] = coords[i + 1];
    const segKm = haversineKm(lon1, lat1, lon2, lat2);
    if (segKm === 0) continue;
    const midLon = (lon1 + lon2) / 2;
    const midLat = (lat1 + lat2) / 2;
    const zone = classifyPoint(midLon, midLat);
    totals[zone] += segKm;
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
let lastRouteCoords = null;

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

els.priceBtn.addEventListener('click', () => {
  if (!lastRouteCoords) return;
  const totals = computeZoneDistancesFromRoute(lastRouteCoords);
  els.status.textContent = '';
  els.status.className = 'status';
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

/* ==== Яндекс.Карты: интерактивная карта + построение маршрута ==== */
let map = null;
let multiRoute = null;
let fromPoint = null; // [lat, lon]
let toPoint = null; // [lat, lon]
const viaPoints = []; // массив [lat, lon] | null, по одному на каждое доп. поле

function setStatus(text, kind) {
  els.status.textContent = text || '';
  els.status.className = kind ? `status ${kind}` : 'status';
}

// Ключ HTTP Геокодера (отдельный от ключа JavaScript API в index.html) —
// используется для прямого запроса к geocode-maps.yandex.ru/v1/.
const GEOCODER_API_KEY = '7c14fea8-931d-4547-970a-592350a94b02';

// Превращает текстовый адрес в координаты [lat, lon] через HTTP Геокодер.
async function geocodeAddress(address) {
  const url =
    `https://geocode-maps.yandex.ru/v1/?apikey=${GEOCODER_API_KEY}` +
    `&geocode=${encodeURIComponent(address)}&format=json&lang=ru_RU&results=1`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`geocoder http ${resp.status}: ${body}`);
  }
  const data = await resp.json();
  const members = data.response.GeoObjectCollection.featureMember;
  if (!members.length) return null;
  const pos = members[0].GeoObject.Point.pos; // строка "lon lat"
  const [lon, lat] = pos.split(' ').map(Number);
  return [lat, lon]; // в формате координат Яндекс.Карт JS API: [lat, lon]
}

// Привязывает геокодирование к полю ввода: адрес ищется по нажатию Enter
// или при уходе с поля. (Автодополнение через ymaps.SuggestView больше не
// доступно в бесплатном JS API — Suggest вынесен в отдельный платный продукт.)
// onSelect получает координаты найденного адреса в формате [lat, lon].
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
        console.error('Ошибка ymaps.geocode:', err);
        setStatus('Ошибка геокодирования — проверьте API-ключ JavaScript API.', 'error');
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
    row.remove();
    rebuildRoute();
  });

  row.appendChild(input);
  row.appendChild(removeBtn);
  els.viaList.appendChild(row);

  bindAddressInput(input, (coords) => {
    viaPoints[index] = coords;
    rebuildRoute();
  });
}

function rebuildRoute() {
  els.priceBtn.classList.add('hidden');
  lastRouteCoords = null;

  const points = [fromPoint, ...viaPoints, toPoint].filter(Boolean);
  if (multiRoute) {
    map.geoObjects.remove(multiRoute);
    multiRoute = null;
  }
  if (points.length < 2) return;

  setStatus('Строим маршрут…', 'loading');
  multiRoute = new ymaps.multiRouter.MultiRoute(
    {
      referencePoints: points,
      params: { routingMode: 'auto' },
    },
    { boundsAutoApply: true }
  );

  multiRoute.model.events.add('requestsuccess', () => {
    const active = multiRoute.getActiveRoute();
    if (!active) {
      setStatus('Маршрут не найден.', 'error');
      return;
    }
    lastRouteCoords = active.geometry.getCoordinates();
    setStatus('', null);
    els.priceBtn.classList.remove('hidden');
  });
  multiRoute.model.events.add('requestfail', (e) => {
    console.error('Ошибка MultiRoute (requestfail):', e.get('error'));
    setStatus('Не удалось построить маршрут.', 'error');
  });

  map.geoObjects.add(multiRoute);
}

function handleMapClick(coords) {
  // Клик по карте задаёт первую незаполненную точку — «Откуда», затем «Куда».
  // Для промежуточных точек используйте адресные поля с кнопкой «+».
  if (!fromPoint) {
    fromPoint = coords;
    setStatus('Точка «Откуда» поставлена кликом по карте.', null);
  } else if (!toPoint) {
    toPoint = coords;
    setStatus('Точка «Куда» поставлена кликом по карте.', null);
  } else {
    return;
  }
  rebuildRoute();
}

function initMapApp() {
  map = new ymaps.Map('map', {
    center: [45.3, 37.5], // примерно между южной Россией и Крымом
    zoom: 6,
    controls: ['zoomControl', 'geolocationControl'],
  });

  map.events.add('click', (e) => handleMapClick(e.get('coords')));

  bindAddressInput(els.fromInput, (coords) => {
    fromPoint = coords;
    rebuildRoute();
  });
  bindAddressInput(els.toInput, (coords) => {
    toPoint = coords;
    rebuildRoute();
  });

  if (els.addViaBtn) {
    els.addViaBtn.addEventListener('click', addViaInput);
  }
}

if (window.ymaps) {
  ymaps.ready(initMapApp);
} else {
  setStatus('Не удалось загрузить Яндекс.Карты — проверьте API-ключ и подключение.', 'error');
}
