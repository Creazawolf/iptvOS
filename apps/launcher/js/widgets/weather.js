/*
 * Weather from Open-Meteo (free, no key). The location is set under Settings > Weather.
 *   Weather.current()  -> { place, temp, text, icon, hi, lo, sunrise, sunset, … } | null
 *   Weather.on(fn)     -> called when new data has arrived
 */
(function (global) {
  'use strict';

  const REFRESH_MS = 15 * 60 * 1000;
  // Short weekday ("sön" / "Sun") – created once.
  let dayFmt = null;
  const dayName = (d) => (dayFmt || (dayFmt = new Intl.DateTimeFormat(I18n.locale, { weekday: 'short' }))).format(d);
  const listeners = [];

  // WMO weather codes -> [text, day icon, night icon]
  function describe(code) {
    if (code === 0) return [tr('weather.cond.clear'), 'sun', 'moon'];
    if (code === 1) return [tr('weather.cond.mostlyClear'), 'sun', 'moon'];
    if (code === 2) return [tr('weather.cond.partlyCloudy'), 'cloud-sun', 'cloud-moon'];
    if (code === 3) return [tr('weather.cond.overcast'), 'cloud', 'cloud'];
    if (code === 45 || code === 48) return [tr('weather.cond.fog'), 'fog', 'fog'];
    if (code >= 51 && code <= 57) return [tr('weather.cond.drizzle'), 'drizzle', 'drizzle'];
    if (code === 61) return [tr('weather.cond.lightRain'), 'rain', 'rain'];
    if (code === 63) return [tr('weather.cond.rain'), 'rain', 'rain'];
    if (code === 65) return [tr('weather.cond.heavyRain'), 'rain', 'rain'];
    if (code === 66 || code === 67) return [tr('weather.cond.freezingRain'), 'rain', 'rain'];
    if (code === 71) return [tr('weather.cond.lightSnow'), 'snow', 'snow'];
    if (code === 73) return [tr('weather.cond.snow'), 'snow', 'snow'];
    if (code === 75) return [tr('weather.cond.heavySnow'), 'snow', 'snow'];
    if (code === 77) return [tr('weather.cond.snowGrains'), 'snow', 'snow'];
    if (code >= 80 && code <= 82) return [tr('weather.cond.rainShowers'), 'rain', 'rain'];
    if (code === 85 || code === 86) return [tr('weather.cond.snowShowers'), 'snow', 'snow'];
    if (code >= 95) return [tr('weather.cond.thunder'), 'thunder', 'thunder'];
    return ['—', 'cloud', 'cloud'];
  }

  const loc = () => Store.get('weather') || {};
  const cacheKey = () => 'g3:weather:' + loc().latitude + ',' + loc().longitude;
  const hhmm = (iso) => (iso || '').slice(11, 16);

  function url(o) {
    return 'https://api.open-meteo.com/v1/forecast' +
      '?latitude=' + o.latitude + '&longitude=' + o.longitude +
      '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day' +
      '&hourly=temperature_2m,weather_code,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max' +
      '&timezone=auto&forecast_days=7&forecast_hours=12&wind_speed_unit=ms';
  }

  let entry = null;
  try { entry = JSON.parse(localStorage.getItem(cacheKey())); } catch (e) { entry = null; }

  function current() {
    if (!entry || !entry.data || !entry.data.current) return null;
    const d = entry.data;
    const c = d.current;
    const info = describe(c.weather_code);
    return {
      place: loc().name || '',
      temp: Math.round(c.temperature_2m),
      feels: Math.round(c.apparent_temperature),
      wind: Math.round(c.wind_speed_10m),
      text: info[0],
      icon: c.is_day ? info[1] : info[2],
      hi: d.daily ? Math.round(d.daily.temperature_2m_max[0]) : null,
      lo: d.daily ? Math.round(d.daily.temperature_2m_min[0]) : null,
      sunrise: d.daily ? hhmm(d.daily.sunrise[0]) : '',
      sunset: d.daily ? hhmm(d.daily.sunset[0]) : '',
      at: entry.at
    };
  }

  function hours() {
    if (!entry || !entry.data || !entry.data.hourly) return [];
    const h = entry.data.hourly;
    return h.time.map((t, i) => {
      const info = describe(h.weather_code[i]);
      return { time: hhmm(t), temp: Math.round(h.temperature_2m[i]), icon: h.is_day[i] ? info[1] : info[2] };
    });
  }

  function days() {
    if (!entry || !entry.data || !entry.data.daily) return [];
    const d = entry.data.daily;
    return d.time.map((t, i) => {
      const p = t.split('-');
      const info = describe(d.weather_code[i]);
      return {
        name: i === 0 ? tr('common.today') : dayName(new Date(+p[0], +p[1] - 1, +p[2])),
        hi: Math.round(d.temperature_2m_max[i]),
        lo: Math.round(d.temperature_2m_min[i]),
        rain: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
        text: info[0],
        icon: info[1]
      };
    });
  }

  function emit() {
    listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    if (global.Widgets) Widgets.refresh('weather');
  }

  function refresh() {
    const o = loc();
    if (o.latitude == null) return Promise.resolve();
    return Net.json(url(o), { direct: true, timeout: 12000 })
      .then((data) => {
        entry = { at: Date.now(), data };
        try { localStorage.setItem(cacheKey(), JSON.stringify(entry)); } catch (e) { /* full */ }
        emit();
      })
      .catch((err) => console.warn('[weather]', err));
  }

  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  Store.on((path) => {
    if (path === '*' || path.indexOf('weather') === 0) {
      try { entry = JSON.parse(localStorage.getItem(cacheKey())); } catch (e) { entry = null; }
      emit();
      refresh();
    }
  });

  // Search for a location (for settings).
  function search(name) {
    const q = 'https://geocoding-api.open-meteo.com/v1/search?count=8&language=' + I18n.lang + '&format=json&name=' + encodeURIComponent(name);
    return Net.json(q, { direct: true }).then((r) =>
      (r.results || []).map((x) => ({
        name: x.name,
        detail: [x.admin1, x.country].filter(Boolean).join(', '),
        latitude: x.latitude,
        longitude: x.longitude
      }))
    );
  }

  global.Weather = { current, hours, days, refresh, search, on: (fn) => listeners.push(fn), describe };

  // --- Widget card ------------------------------------------------------------

  const esc = (s) => UI.esc(s);

  Widgets.register('weather', {
    title: tr('weather.title'),
    size: 2,
    render(face) {
      const w = current();
      if (!w) {
        face.innerHTML = '<div class="wg wg-empty">' + Icons.svg('cloud') + '<span>' + tr('weather.loading') + '</span></div>';
        return;
      }
      const next = hours().slice(1, 6);
      face.innerHTML =
        '<div class="wg wg-weather">' +
        '<div class="wg-w-now">' +
        '<span class="wg-w-icon">' + Icons.svg(w.icon) + '</span>' +
        '<span class="wg-w-temp">' + w.temp + '°</span>' +
        '<span class="wg-w-meta"><b>' + esc(w.place) + '</b>' + esc(w.text) + '<br>' + tr('weather.hiLo', { hi: w.hi, lo: w.lo }) + '</span>' +
        '</div>' +
        '<ol class="wg-w-hours">' +
        next.map((h) => '<li><span>' + h.time.slice(0, 2) + '</span>' + Icons.svg(h.icon) + '<b>' + h.temp + '°</b></li>').join('') +
        '</ol></div>';
    },
    activate() {
      const w = current();
      if (!w) return;
      UI.menu({
        title: w.place + ' · ' + w.temp + '° ' + w.text,
        subtitle: tr('weather.details', { feels: w.feels, wind: w.wind, sunrise: w.sunrise, sunset: w.sunset }),
        items: days().map((d) => ({
          label: d.name.charAt(0).toUpperCase() + d.name.slice(1) + ' · ' + d.text,
          detail: d.hi + '° / ' + d.lo + '°' + (d.rain != null ? '  ·  ' + d.rain + ' %' : '')
        }))
      });
    }
  });
})(window);
