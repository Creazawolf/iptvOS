/* Clock + date. Clock.* is also used by the home screen's top shelf. */
(function (global) {
  'use strict';

  // "söndag 21 november" / "Sunday 21 November" – created once.
  let dateFmt = null;
  const dateText = (d) => (dateFmt || (dateFmt = new Intl.DateTimeFormat(I18n.locale, { weekday: 'long', day: 'numeric', month: 'long' }))).format(d);
  const pad = (n) => (n < 10 ? '0' : '') + n;

  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const jan1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - jan1) / 86400000 + 1) / 7);
  }

  function greeting(h) {
    if (h >= 5 && h < 10) return tr('clock.greeting.morning');
    if (h >= 10 && h < 12) return tr('clock.greeting.forenoon');
    if (h >= 12 && h < 18) return tr('clock.greeting.afternoon');
    if (h >= 18 && h < 23) return tr('clock.greeting.evening');
    return tr('clock.greeting.night');
  }

  const Clock = {
    time: (d) => pad((d = d || new Date()).getHours()) + ':' + pad(d.getMinutes()),
    date: (d) => dateText(d || new Date()),
    week: (d) => isoWeek(d || new Date()),
    greeting: (d) => greeting((d || new Date()).getHours()),
    hhmm: (ms) => Clock.time(new Date(ms))
  };
  global.Clock = Clock;

  Widgets.register('clock', {
    title: tr('clock.title'),
    size: 1,
    render(face) {
      const d = new Date();
      face.innerHTML =
        '<div class="wg wg-clock">' +
        '<span class="wg-c-time">' + Clock.time(d) + '</span>' +
        '<span class="wg-c-date">' + Clock.date(d) + ' · ' + tr('clock.week', { week: Clock.week(d) }) + '</span>' +
        '</div>';
    }
  });
})(window);
