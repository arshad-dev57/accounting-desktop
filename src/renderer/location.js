'use strict';

(function (global) {
  const LOCATION_KEY = 'selected_location_id';
  const SYNCED_KEY = 'last_synced_location_id';
  const CACHE_KEY = 'cached_locations';
  const ALL = 'all';

  function getStoredLocationId() {
    try {
      return localStorage.getItem(LOCATION_KEY) || '';
    } catch {
      return '';
    }
  }

  function getLastSyncedLocationId() {
    try {
      return localStorage.getItem(SYNCED_KEY) || '';
    } catch {
      return '';
    }
  }

  function setLastSyncedLocationId(id) {
    try {
      localStorage.setItem(SYNCED_KEY, String(id || ''));
    } catch {
      /* ignore */
    }
  }

  function setStoredLocationId(id) {
    try {
      if (id) localStorage.setItem(LOCATION_KEY, id);
      else localStorage.removeItem(LOCATION_KEY);
    } catch {
      /* ignore */
    }
  }

  function getCachedLocations() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter((l) => l && l.id) : [];
    } catch {
      return [];
    }
  }

  function setCachedLocations(list) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(list || []));
    } catch {
      /* ignore */
    }
  }

  function normalizeLocation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || raw._id || '').trim();
    if (!id) return null;
    return {
      id,
      name: String(raw.name || 'Location'),
      code: String(raw.code || ''),
      type: raw.type || '',
      isDefault: raw.isDefault === true,
      isActive: raw.isActive !== false,
    };
  }

  function unwrapLocations(payload) {
    const raw = payload?.data ?? payload;
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(raw?.locations)
          ? raw.locations
          : [];
    return list.map(normalizeLocation).filter(Boolean);
  }

  function effectiveId(id) {
    const s = String(id || '').trim();
    if (!s || s === ALL || s === '__all__') return '';
    return s;
  }

  function pickDefaultLocationId(locations, preferredId, allowAll) {
    const stored = preferredId || getStoredLocationId();
    if (allowAll && (stored === ALL || stored === '')) return ALL;
    if (stored && stored !== ALL && locations.some((l) => l.id === stored)) return stored;
    const def = locations.find((l) => l.isDefault) || locations[0];
    return def?.id || (allowAll ? ALL : '');
  }

  function fillLocationSelect(selectEl, locations, selectedId, opts) {
    if (!selectEl) return selectedId || '';
    const allowAll = !!(opts && opts.allowAll);
    const html = [];
    if (allowAll) html.push('<option value="all">All locations</option>');
    locations.forEach((l) => {
      const label = l.code ? `${l.name} (${l.code})` : l.name;
      html.push(`<option value="${l.id}">${label}</option>`);
    });
    selectEl.innerHTML = html.join('') || '<option value="">No locations</option>';
    const value = pickDefaultLocationId(locations, selectedId, allowAll);
    if (value) selectEl.value = value;
    return selectEl.value;
  }

  async function loadLocations(api) {
    const cached = getCachedLocations();
    try {
      const res = await api.pos.listLocations();
      const list = unwrapLocations(res);
      if (list.length) {
        setCachedLocations(list);
        return list;
      }
    } catch {
      /* use cache */
    }
    return cached;
  }

  global.bisonLocation = {
    ALL,
    getStoredLocationId,
    setStoredLocationId,
    getLastSyncedLocationId,
    setLastSyncedLocationId,
    getCachedLocations,
    unwrapLocations,
    pickDefaultLocationId,
    fillLocationSelect,
    loadLocations,
    effectiveId,
  };
})(window);
