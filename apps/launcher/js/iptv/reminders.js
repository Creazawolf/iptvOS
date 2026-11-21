/*
 * IPTV.reminders — programme reminders ("tell me when the match starts").
 *
 * On the TV the launcher's service keeps track of the time and shows a webOS box with "Watch now" on top of
 * whatever is on screen, even when the launcher is not in front; "Watch now" starts the launcher on the channel.
 * In the browser (the preview) a timer on the page takes care of it.
 *
 *   IPTV.reminders.toggle(channel, programme)  -> bool (switched on?)
 *   IPTV.reminders.has(channel, programme)     IPTV.reminders.list()    IPTV.reminders.remove(id)
 *   IPTV.reminders.menuItems(channel)          rows for the Options menu (the next programme on the channel)
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const KEY = 'iptv.reminders';
  const AHEAD = 60 * 1000; // remind one minute before
  const u = IPTV.u;

  const idOf = (ch, p) => String(ch.id) + '@' + p.start;
  const all = () => (Store.get(KEY) || []).filter((r) => r && r.end > Date.now());

  function list() {
    return all().sort((a, b) => a.start - b.start);
  }

  const has = (ch, p) => !!(ch && p) && all().some((r) => r.id === idOf(ch, p));

  let dayFmt = null; // "lör 22/11" / "Sat 22/11" – created once
  function day(ms) {
    const d = new Date(ms);
    const today = new Date();
    const tomorrow = new Date(Date.now() + 86400e3);
    if (d.toDateString() === today.toDateString()) return tr('reminders.today');
    if (d.toDateString() === tomorrow.toDateString()) return tr('reminders.tomorrow');
    if (!dayFmt) dayFmt = new Intl.DateTimeFormat(I18n.locale, { weekday: 'short', day: 'numeric', month: 'numeric' });
    return dayFmt.format(d);
  }

  // --- Sync with the service (the TV) or timers here (the browser) ---------------------------------

  let localTimers = [];
  let syncTimer = null;

  function sync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      // Only those that have not been shown yet (the box appears one minute before the start).
      const items = all().filter((r) => r.start - AHEAD > Date.now()).map((r) => ({
        id: r.id,
        at: r.start - AHEAD,
        title: r.title,
        message: r.chName + ' · ' + u.time(r.start),
        params: { action: 'tune', channel: r.ch, reminder: r.id },
        // The service shows the alert on its own and has no dictionaries: send the button labels along.
        watch: tr('reminders.watchNow'),
        close: tr('common.close')
      }));
      if (TV.isTV && global.Root && Root.remind) {
        Root.remind(items).catch(() => local(items));
      } else {
        local(items);
      }
    }, 300);
  }

  function local(items) {
    localTimers.forEach(clearTimeout);
    localTimers = items.map((r) => setTimeout(() => {
      Store.set(KEY, (Store.get(KEY) || []).filter((x) => x.id !== r.id));
      UI.menu({
        title: r.title,
        subtitle: tr('reminders.startsSoon', { info: r.message }),
        items: [
          { label: tr('reminders.watchNow'), action: () => IPTV.open({ tab: 'live', channel: r.params.channel, fullscreen: true }) },
          { label: tr('common.close') }
        ]
      });
    }, Math.max(0, r.at - Date.now())));
  }

  function add(ch, p) {
    const list = (Store.get(KEY) || []).filter((r) => r && r.end > Date.now() && r.id !== idOf(ch, p));
    list.push({
      id: idOf(ch, p),
      ch: IPTV.minimal ? IPTV.minimal(ch) : ch,
      chName: ch.name,
      title: p.title,
      start: p.start,
      end: p.end
    });
    Store.set(KEY, list.slice(-100));
    sync();
  }

  function remove(id) {
    Store.set(KEY, (Store.get(KEY) || []).filter((r) => r && r.id !== id));
    sync();
  }

  function toggle(ch, p) {
    if (!ch || !p) return false;
    if (has(ch, p)) {
      remove(idOf(ch, p));
      UI.toast(tr('reminders.removed', { title: p.title }));
      return false;
    }
    if (p.start <= Date.now()) {
      UI.toast(tr('reminders.alreadyStarted', { title: p.title }));
      return false;
    }
    add(ch, p);
    UI.toast(tr('reminders.set', { day: day(p.start), time: u.time(p.start - AHEAD), title: p.title }), 4000);
    return true;
  }

  // The Options menu in full screen: a reminder for the next programme on the channel.
  function menuItems(ch) {
    if (!ch || !IPTV.epg) return [];
    const nn = IPTV.epg.peek(ch);
    const next = nn && nn.next;
    if (!next || next.start <= Date.now()) return [];
    const on = has(ch, next);
    return [{
      label: on ? tr('reminders.removeReminder') : tr('reminders.remindNext'),
      detail: u.time(next.start) + ' ' + next.title,
      action: () => toggle(ch, next)
    }];
  }

  // Start: make sure the service has the list (e.g. after a reinstall).
  setTimeout(sync, 4000);

  IPTV.reminders = { toggle, has, list, remove, menuItems, day };
})(window);
