const STORAGE_PREFIX = 'customZone_';
const NEW_TERR_KEYS = ['luhansk', 'donetsk', 'zaporizhzhia', 'kherson'];

function defaultGeometriesFor(zoneKey) {
  if (zoneKey === 'crimea') return [ZONE_BOUNDARIES.crimea];
  if (zoneKey === 'russia') return [ZONE_BOUNDARIES.russia];
  if (zoneKey === 'new_territories') return NEW_TERR_KEYS.map((k) => ZONE_BOUNDARIES.newTerritories[k]);
  return [];
}

function loadCustomFeatureCollection(zoneKey) {
  const raw = localStorage.getItem(STORAGE_PREFIX + zoneKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/* ==== Карта ==== */
const map = L.map('map', { zoomControl: true }).setView([46.9, 35.3], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 18,
}).addTo(map);

// Слой-подсказка: стандартная граница зоны, серым пунктиром, не редактируется
const referenceLayer = L.geoJSON(null, {
  style: { color: '#6b7280', weight: 1.5, dashArray: '4 4', fillOpacity: 0.03 },
  interactive: false,
}).addTo(map);

// Редактируемый слой — то, что пользователь рисует/правит
const editableLayer = new L.FeatureGroup().addTo(map);

const drawControl = new L.Control.Draw({
  draw: {
    polygon: { allowIntersection: true, showArea: false, shapeOptions: { color: '#d97757' } },
    polyline: false,
    rectangle: false,
    circle: false,
    circlemarker: false,
    marker: false,
  },
  edit: { featureGroup: editableLayer },
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
  editableLayer.addLayer(e.layer);
});

/* ==== Переключение зон ==== */
const zoneSelect = document.getElementById('zoneSelect');

function showZone(zoneKey) {
  editableLayer.clearLayers();
  referenceLayer.clearLayers();

  const defaults = defaultGeometriesFor(zoneKey);
  defaults.forEach((geom) => referenceLayer.addData({ type: 'Feature', properties: {}, geometry: geom }));

  const custom = loadCustomFeatureCollection(zoneKey);
  if (custom) {
    L.geoJSON(custom, {
      style: { color: '#d97757' },
      onEachFeature: (feature, layer) => editableLayer.addLayer(layer),
    });
  }

  // Вписать карту в границы зоны
  try {
    const bounds = referenceLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20] });
  } catch (e) {}
}

zoneSelect.addEventListener('change', () => showZone(zoneSelect.value));
showZone(zoneSelect.value);

/* ==== Кнопки ==== */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => (t.style.display = 'none'), 2200);
}

document.getElementById('startFromDefaultBtn').addEventListener('click', () => {
  const zoneKey = zoneSelect.value;
  const custom = loadCustomFeatureCollection(zoneKey);
  const source = custom || {
    type: 'FeatureCollection',
    features: defaultGeometriesFor(zoneKey).map((g) => ({ type: 'Feature', properties: {}, geometry: g })),
  };
  editableLayer.clearLayers();
  L.geoJSON(source, {
    onEachFeature: (feature, layer) => editableLayer.addLayer(layer),
  });
  showToast('Граница подставлена — можно двигать узлы');
});

document.getElementById('resetBtn').addEventListener('click', () => {
  const zoneKey = zoneSelect.value;
  localStorage.removeItem(STORAGE_PREFIX + zoneKey);
  showZone(zoneKey);
  showToast('Сброшено к стандартной границе');
});

document.getElementById('saveBtn').addEventListener('click', () => {
  const zoneKey = zoneSelect.value;
  const fc = editableLayer.toGeoJSON();
  if (!fc.features.length) {
    showToast('Нечего сохранять — нарисуйте хотя бы один полигон');
    return;
  }
  localStorage.setItem(STORAGE_PREFIX + zoneKey, JSON.stringify(fc));
  showToast('Сохранено на этом устройстве');
});
