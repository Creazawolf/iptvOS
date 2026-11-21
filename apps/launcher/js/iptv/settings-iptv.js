/*
 * Settings › IPTV (added via window.SETTINGS_PAGES, see docs/ARCHITECTURE.md §4).
 * The same pages can be reached from the TV app's tab bar (the cog).
 *
 *   iptv            overview with the sub-pages below
 *   iptv-source     source (hub/direct), addresses, test, status
 *   iptv-nav        how tabs, the channel list, ▲▼ and Back behave
 *   iptv-live       live TV: channel info, preview, picture format, tracks for channels
 *   iptv-player     movies and series: next episode, skip step, track info
 *   iptv-lang       audio language and subtitles (language, size, position)
 *   iptv-reminders  reminders
 *   iptv-clean      clear history and cache
 *   iptv-cats       visible live categories in direct mode (in hub mode this is done in the web admin)
 */
(function (global) {
  'use strict';

  const IPTV = global.IPTV;
  const pages = global.SETTINGS_PAGES || (global.SETTINGS_PAGES = {});

  const MODE_LABEL = { '': tr('common.auto'), hub: 'G3 Hub', direct: tr('settingsIptv.conn.modeDirect') };
  const test = { running: false, text: '' };
  const cats = { loading: false, list: null, error: '' };

  function runTest(h) {
    if (!IPTV.configured()) {
      UI.toast(IPTV.mode() === 'hub' ? tr('settingsIptv.test.enterHubFirst') : tr('settingsIptv.test.fillInFirst'));
      return;
    }
    test.running = true;
    test.text = tr('settingsIptv.test.testing');
    h.render();
    IPTV.test().then((r) => {
      const b = r.boot || {};
      const live = ((b.live || {}).categories || []).length;
      const vod = ((b.vod || {}).categories || []).length;
      const ser = ((b.series || {}).categories || []).length;
      let text;
      if (r.mode === 'hub') {
        const pl = (b.playlists || []).filter((p) => p.enabled !== false).length;
        text = tr('common.ok') + ' · ' + ((r.health && r.health.name) || 'G3 Hub') + ' · ' + tr('settingsIptv.test.playlists', { n: pl });
      } else {
        const ui = (r.info && r.info.user_info) || {};
        const exp = ui.exp_date ? new Date(+ui.exp_date * 1000) : null;
        text = tr('common.ok') + (exp && !isNaN(exp) ? ' · ' + tr('settingsIptv.test.validUntil', { date: exp.toISOString().slice(0, 10) }) : '') +
          (ui.max_connections ? ' · ' + tr('settingsIptv.test.connections', { active: ui.active_cons || 0, max: ui.max_connections }) : '');
      }
      test.text = text;
      UI.toast(text + ' · ' + tr('settingsIptv.test.counts', { live, vod, series: ser }), 6000);
      IPTV.reload();
    }, (e) => {
      test.text = tr('settingsIptv.test.failed');
      UI.toast(tr('settingsIptv.test.failedWith', { error: e.message }), 7000);
    }).then(() => {
      test.running = false;
      h.render();
    });
  }

  function statusRows(h) {
    const st = IPTV.status();
    const b = st.boot || {};
    const rows = [h.note(tr('settingsIptv.status.title'))];
    let state = tr('settingsIptv.status.notConnected');
    if (IPTV.configured()) {
      state = st.state === 'ok' ? tr('settingsIptv.status.connected') : st.state === 'error' ? tr('settingsIptv.status.errorWith', { error: (st.error && st.error.message) || '' }) : tr('settingsIptv.status.connecting');
    }
    rows.push(h.action(tr('settingsIptv.status.connection'), () => IPTV.reload(), { value: state.length > 46 ? state.slice(0, 44) + '…' : state, detail: tr('settingsIptv.status.pressOkToReload') }));
    if (IPTV.configured() && st.state === 'ok') {
      const lc = (b.live && b.live.categories.length) || 0;
      const vc = (b.vod && b.vod.categories.length) || 0;
      const sc = (b.series && b.series.categories.length) || 0;
      rows.push(h.action(tr('settingsIptv.status.visibleCategories'), () => {}, { value: tr('settingsIptv.status.categoryCounts', { live: lc, vod: vc, series: sc }) }));
      rows.push(h.action(tr('settingsIptv.status.favouriteChannels'), () => {}, { value: String(IPTV.favorites().length) }));
      if (st.mode === 'hub' && b.playlists && b.playlists.length) {
        b.playlists.forEach((p) => rows.push(h.action(p.name || tr('settingsIptv.status.playlist'), () => {}, {
          value: p.enabled === false ? tr('settingsIptv.status.disabled') : p.status && p.status.ok === false ? tr('settingsIptv.status.error') : tr('settingsIptv.status.active'),
          detail: p.status && p.status.error ? p.status.error : (p.type === 'm3u' ? 'M3U' : 'Xtream Codes')
        })));
      }
    }
    return rows;
  }

  const stateText = () => {
    const st = IPTV.status();
    if (!IPTV.configured()) return tr('settingsIptv.status.notConnected');
    return st.state === 'ok' ? tr('settingsIptv.status.connected') : st.state === 'error' ? tr('settingsIptv.status.error') : tr('settingsIptv.status.connecting');
  };

  // --- Overview ---------------------------------------------------------------------------------

  pages.iptv = (h) => ({
    title: 'IPTV',
    icon: 'tv',
    desc: tr('settingsIptv.overview.desc'),
    rows: [
      h.nav(tr('settingsIptv.pages.source'), 'iptv-source', { icon: 'signal', value: stateText() }),
      h.nav(tr('settingsIptv.pages.nav'), 'iptv-nav', { icon: 'move', detail: tr('settingsIptv.overview.navDetail') }),
      h.nav(tr('settingsIptv.pages.live'), 'iptv-live', { icon: 'tv', detail: tr('settingsIptv.overview.liveDetail') }),
      h.nav(tr('settingsIptv.pages.player'), 'iptv-player', { icon: 'film', detail: tr('settingsIptv.overview.playerDetail') }),
      h.nav(tr('settingsIptv.pages.lang'), 'iptv-lang', { icon: 'list', detail: tr('settingsIptv.overview.langDetail') }),
      IPTV.reminders && h.nav(tr('settingsIptv.pages.reminders'), 'iptv-reminders', { icon: 'bell', value: String(IPTV.reminders.list().length) }),
      h.nav(tr('settingsIptv.pages.clean'), 'iptv-clean', { icon: 'trash', detail: tr('settingsIptv.overview.cleanDetail') })
    ].filter(Boolean)
  });

  // --- Source and connection --------------------------------------------------------------------

  pages['iptv-source'] = (h) => {
    const stored = Store.get('iptv.mode') || '';
    const mode = IPTV.mode();
    const hub = Store.get('iptv.hub') || {};
    const d = Store.get('iptv.direct') || {};
    const modes = ['', 'hub', 'direct'];
    const hubAddr = IPTV.hubUrl();

    let rows = [
      h.action(tr('settingsIptv.conn.source'), () => Store.set('iptv.mode', modes[(modes.indexOf(stored) + 1) % modes.length]), {
        icon: 'tv',
        value: MODE_LABEL[stored] + (stored ? '' : ' (' + (mode === 'hub' ? tr('settingsIptv.conn.activeHub') : tr('settingsIptv.conn.activeDirect')) + ')'),
        detail: tr('settingsIptv.conn.sourceDetail')
      })
    ];

    if (mode === 'hub') {
      rows = rows.concat([
        h.note('G3 Hub'),
        h.action(tr('settingsIptv.conn.hubAddress'), () => h.edit({
          title: 'G3 Hub',
          label: tr('settingsIptv.conn.hubAddressHint'),
          value: hub.url || '',
          type: 'url'
        }, (v) => Store.set('iptv.hub.url', v ? IPTV.normalizeHub(v) : '')), {
          value: hub.url || (hubAddr ? tr('settingsIptv.conn.previewAddress', { url: hubAddr }) : tr('settingsIptv.conn.notSet'))
        }),
        h.action(tr('settingsIptv.conn.token'), () => h.edit({
          title: tr('settingsIptv.conn.token'),
          label: tr('settingsIptv.conn.tokenHint'),
          value: hub.token || '',
          type: 'password'
        }, (v) => Store.set('iptv.hub.token', v)), { value: hub.token ? '••••••' : tr('common.none') }),
        hubAddr && h.note(tr('settingsIptv.conn.hubNote', { url: hubAddr }))
      ]);
    } else {
      rows = rows.concat([
        h.note('Xtream Codes'),
        h.action(tr('settingsIptv.conn.server'), () => h.edit({ title: tr('settingsIptv.conn.server'), label: tr('settingsIptv.conn.serverHint'), value: d.server || '', type: 'url' },
          (v) => Store.set('iptv.direct.server', IPTV.xtream.normalizeServer(v))), { value: d.server || (TV.isTV ? tr('settingsIptv.conn.notSet') : tr('settingsIptv.conn.demo')) }),
        h.action(tr('settingsIptv.conn.username'), () => h.edit({ title: tr('settingsIptv.conn.username'), label: tr('settingsIptv.conn.username'), value: d.username || '' },
          (v) => Store.set('iptv.direct.username', v)), { value: d.username || '—' }),
        h.action(tr('settingsIptv.conn.password'), () => h.edit({ title: tr('settingsIptv.conn.password'), label: tr('settingsIptv.conn.password'), value: d.password || '', type: 'password' },
          (v) => Store.set('iptv.direct.password', v)), { value: d.password ? '••••••••' : '—' }),
        h.action(tr('settingsIptv.conn.streamFormat'), () => Store.set('iptv.direct.format', d.format === 'ts' ? 'm3u8' : 'ts'), {
          value: d.format === 'ts' ? 'MPEG-TS (.ts)' : 'HLS (.m3u8)', detail: tr('settingsIptv.conn.streamFormatDetail')
        }),
        h.nav(tr('settingsIptv.pages.cats'), 'iptv-cats', { value: tr('settingsIptv.conn.visibleCount', { count: IPTV.categories('live').length }), detail: tr('settingsIptv.conn.catsDetail') })
      ]);
    }

    rows.push(h.action(tr('settingsIptv.conn.test'), () => runTest(h), { icon: 'signal', value: test.text || null }));
    rows = rows.concat(statusRows(h));

    return {
      title: tr('settingsIptv.pages.source'),
      icon: 'signal',
      desc: mode === 'hub'
        ? tr('settingsIptv.conn.descHub')
        : tr('settingsIptv.conn.descDirect'),
      rows: rows.filter(Boolean)
    };
  };

  // --- Navigation -------------------------------------------------------------------------------

  const nav = (key, def) => { const v = Store.get('iptv.nav.' + key); return v == null || v === '' ? def : v; };

  pages['iptv-nav'] = (h) => ({
    title: tr('settingsIptv.pages.nav'),
    icon: 'move',
    desc: tr('settingsIptv.nav.desc'),
    rows: [
      h.pick(tr('settingsIptv.nav.tabs'), [
        { v: 'ok', label: tr('settingsIptv.nav.tabsOk'), short: tr('settingsIptv.nav.tabsOkShort'), detail: tr('settingsIptv.nav.tabsOkDetail') },
        { v: 'focus', label: tr('settingsIptv.nav.tabsFocus'), short: tr('settingsIptv.nav.tabsFocusShort'), detail: tr('settingsIptv.nav.tabsFocusDetail') }
      ], nav('tabs', 'ok'), (v) => Store.set('iptv.nav.tabs', v), { detail: tr('settingsIptv.nav.tabsDetail') }),
      h.pick(tr('settingsIptv.nav.list'), [
        { v: 'ok', label: tr('settingsIptv.nav.listOk'), short: tr('settingsIptv.nav.listOkShort'), detail: tr('settingsIptv.nav.listOkDetail') },
        { v: 'auto', label: tr('settingsIptv.nav.listAuto'), short: tr('common.auto'), detail: tr('settingsIptv.nav.listAutoDetail') },
        { v: 'off', label: tr('settingsIptv.nav.listOff'), short: tr('settingsIptv.nav.listOffShort'), detail: tr('settingsIptv.nav.listOffDetail') }
      ], nav('preview', 'ok'), (v) => Store.set('iptv.nav.preview', v), { detail: tr('settingsIptv.nav.listDetail') }),
      h.pick(tr('settingsIptv.nav.zap'), [
        { v: 'direct', label: tr('settingsIptv.nav.zapDirect'), short: tr('settingsIptv.nav.zapDirectShort') },
        { v: 'confirm', label: tr('settingsIptv.nav.zapConfirm'), short: tr('settingsIptv.nav.zapConfirmShort'), detail: tr('settingsIptv.nav.zapConfirmDetail') }
      ], nav('zap', 'direct'), (v) => Store.set('iptv.nav.zap', v)),
      h.pick(tr('settingsIptv.nav.back'), [
        { v: 'app', label: tr('settingsIptv.nav.backApp'), detail: tr('settingsIptv.nav.backAppDetail') },
        { v: 'home', label: tr('settingsIptv.nav.backHome') }
      ], nav('back', 'app'), (v) => Store.set('iptv.nav.back', v), { detail: tr('settingsIptv.nav.backDetail') }),
      h.note(tr('settingsIptv.nav.note'))
    ]
  });

  // --- Live TV ------------------------------------------------------------------------------------

  pages['iptv-live'] = (h) => {
    const sec = Number(Store.get('live.bannerSeconds')) || 5;
    const fit = IPTV.fit.current();
    return {
      title: tr('settingsIptv.pages.live'),
      icon: 'tv',
      desc: tr('settingsIptv.live.desc'),
      rows: [
        h.pick(tr('settingsIptv.live.banner'), [3, 5, 8, 12].map((n) => ({ v: n, label: tr('common.seconds', { n }), short: tr('settingsIptv.secondsShort', { n }) })), sec,
          (v) => Store.set('live.bannerSeconds', v), { detail: tr('settingsIptv.live.bannerDetail') }),
        h.pick(tr('settingsIptv.live.fit'), IPTV.fit.list.map((f) => ({ v: f.id, label: f.label, detail: f.detail })), fit.id,
          (v) => IPTV.fit.set(v), { detail: tr('settingsIptv.live.fitDetail') }),
        h.toggle(tr('settingsIptv.live.homePreview'), () => Store.get('iptv.homePreview') !== false, (v) => Store.set('iptv.homePreview', v),
          { detail: tr('settingsIptv.live.homePreviewDetail') }),
        h.toggle(tr('settingsIptv.live.mediaInfo'), () => Store.get('live.mediaInfo') === true, (v) => Store.set('live.mediaInfo', v),
          { detail: tr('settingsIptv.live.mediaInfoDetail') }),
        h.note(IPTV.mode() === 'hub'
          ? tr('settingsIptv.live.noteHub') : tr('settingsIptv.live.noteDirect'))
      ]
    };
  };

  // --- Movies and series --------------------------------------------------------------------------

  pages['iptv-player'] = (h) => {
    const skip = Number(Store.get('player.skip')) || 10;
    return {
      title: tr('settingsIptv.pages.player'),
      icon: 'film',
      desc: tr('settingsIptv.player.desc'),
      rows: [
        h.toggle(tr('settingsIptv.player.autoNext'), () => Store.get('player.autoNext') !== false, (v) => Store.set('player.autoNext', v),
          { detail: tr('settingsIptv.player.autoNextDetail') }),
        h.pick(tr('settingsIptv.player.skip'), [5, 10, 15, 30].map((n) => ({ v: n, label: tr('common.seconds', { n }), short: tr('settingsIptv.secondsShort', { n }) })), skip,
          (v) => Store.set('player.skip', v), { detail: tr('settingsIptv.player.skipDetail') }),
        h.toggle(tr('settingsIptv.player.mediaInfo'), () => Store.get('player.mediaInfo') !== false, (v) => Store.set('player.mediaInfo', v),
          { detail: tr('settingsIptv.player.mediaInfoDetail') }),
        h.nav(tr('settingsIptv.pages.lang'), 'iptv-lang', { detail: tr('settingsIptv.overview.langDetail') })
      ]
    };
  };

  // --- Audio and subtitles ------------------------------------------------------------------------

  pages['iptv-lang'] = (h) => {
    const TR = IPTV.tracks;
    const langs = TR.prefLangs.map((c) => ({ v: c, label: TR.langName(c) }));
    const audioOpts = [{ v: 'last', label: tr('settingsIptv.lang.sameAsLast'), detail: tr('settingsIptv.lang.sameAsLastAudio') }].concat(langs);
    const subOpts = [
      { v: 'last', label: tr('settingsIptv.lang.sameAsLast'), detail: tr('settingsIptv.lang.sameAsLastSubs') },
      { v: 'off', label: tr('common.off') }
    ].concat(langs);
    const st = TR.style();
    const pref = (key) => Store.get(key) || 'last';
    return {
      title: tr('settingsIptv.pages.lang'),
      icon: 'list',
      desc: tr('settingsIptv.lang.desc'),
      rows: [
        h.note(tr('settingsIptv.pages.player')),
        h.pick(tr('settingsIptv.lang.audio'), audioOpts, pref('player.audioPref'), (v) => Store.set('player.audioPref', v)),
        h.pick(tr('settingsIptv.lang.subs'), subOpts, pref('player.subPref'), (v) => Store.set('player.subPref', v),
          { detail: tr('settingsIptv.lang.subsDetail') }),
        h.pick(tr('settingsIptv.lang.size'), TR.sizes, st.size, (v) => TR.setStyle({ size: v })),
        h.pick(tr('settingsIptv.lang.position'), TR.positions, st.position, (v) => TR.setStyle({ position: v }),
          { detail: tr('settingsIptv.lang.positionDetail') }),
        h.toggle(tr('settingsIptv.lang.box'), () => !!st.box, (v) => TR.setStyle({ box: v })),
        IPTV.mode() === 'hub' && h.toggle(tr('settingsIptv.lang.hubSubs'), () => Store.get('player.hubSubs') !== false, (v) => Store.set('player.hubSubs', v),
          { detail: tr('settingsIptv.lang.hubSubsDetail') }),
        h.note(tr('settingsIptv.pages.live')),
        h.pick(tr('settingsIptv.lang.audio'), audioOpts, pref('live.audioPref'), (v) => Store.set('live.audioPref', v)),
        h.pick(tr('settingsIptv.lang.subs'), subOpts, pref('live.subPref'), (v) => Store.set('live.subPref', v)),
        h.note(tr('settingsIptv.lang.note'))
      ].filter(Boolean)
    };
  };

  // --- Clear --------------------------------------------------------------------------------------

  pages['iptv-clean'] = (h) => ({
    title: tr('settingsIptv.pages.clean'),
    icon: 'trash',
    desc: tr('settingsIptv.clean.desc'),
    rows: [
      h.action(tr('settingsIptv.clean.recent'), () => { Store.set('iptv.recent', []); Store.set('iptv.lastChannel', null); UI.toast(tr('settingsIptv.clean.recentDone')); }),
      IPTV.mode() === 'direct' && h.action(tr('settingsIptv.clean.continue'), () => { Store.set('iptv.local.progress', []); IPTV.reload(); UI.toast(tr('settingsIptv.clean.continueDone')); }),
      h.action(tr('settingsIptv.clean.cache'), () => {
        try { localStorage.removeItem('g3:iptv:boot:v1'); } catch (e) { /* ignore */ }
        if (IPTV.source.direct && IPTV.source.direct.clear) IPTV.source.direct.clear();
        IPTV.epg.clear();
        IPTV.reload();
        UI.toast(tr('settingsIptv.clean.cacheDone'));
      }),
      h.action(tr('settingsIptv.clean.reset'), () => {
        ['iptv.nav', 'player.sub'].forEach((k) => Store.set(k, {}));
        ['player.audioPref', 'player.subPref', 'live.audioPref', 'live.subPref', 'player.skip', 'live.bannerSeconds'].forEach((k) => Store.set(k, null));
        Store.set('player.mediaInfo', true);
        Store.set('live.mediaInfo', false);
        UI.toast(tr('settingsIptv.clean.resetDone'));
      }, { detail: tr('settingsIptv.clean.resetDetail') })
    ].filter(Boolean)
  });

  // --- Categories in direct mode ----------------------------------------------------------

  function loadCats(h) {
    if (cats.loading) return;
    cats.loading = true;
    cats.error = '';
    IPTV.source.direct.allCategories('live').then((list) => {
      cats.list = list;
    }, (e) => {
      cats.error = e.message;
    }).then(() => {
      cats.loading = false;
      h.render();
    });
  }

  const reloadSoon = IPTV.u.debounce(() => IPTV.reload(), 600);

  function setVisible(id, on) {
    const hidden = (Store.get('iptv.local.catHidden.live') || []).filter((x) => x !== id);
    if (!on) hidden.push(id);
    IPTV.source.direct.setHidden('live', hidden);
    if (cats.list) cats.list.forEach((c) => { if (c.id === id) c.visible = on; });
    reloadSoon();
  }

  // --- Reminders --------------------------------------------------------------------------

  pages['iptv-reminders'] = (h) => {
    const list = IPTV.reminders ? IPTV.reminders.list() : [];
    const rows = [];
    if (!list.length) rows.push(h.note(tr('settingsIptv.reminders.none')));
    list.forEach((r) => rows.push(h.action(r.title, () => {
      IPTV.reminders.remove(r.id);
      UI.toast(tr('settingsIptv.reminders.removed', { title: r.title }));
      h.render();
    }, {
      value: IPTV.reminders.day(r.start) + ' ' + IPTV.u.time(r.start),
      detail: tr('settingsIptv.reminders.detail', { channel: r.chName })
    })));
    return {
      title: tr('settingsIptv.pages.reminders'),
      icon: 'clock',
      desc: tr('settingsIptv.reminders.desc'),
      rows
    };
  };

  pages['iptv-cats'] = (h) => {
    if (!cats.list && !cats.loading && !cats.error) loadCats(h);
    const rows = [];
    if (cats.loading && !cats.list) rows.push(h.note(tr('settingsIptv.cats.loading')));
    if (cats.error) rows.push(h.action(tr('settingsIptv.cats.loadFailed'), () => loadCats(h), { value: cats.error }));
    if (cats.list) {
      const shown = cats.list.filter((c) => c.visible).length;
      rows.push(h.action(tr('settingsIptv.cats.showAll'), () => {
        IPTV.source.direct.setHidden('live', []);
        cats.list.forEach((c) => { c.visible = true; });
        reloadSoon();
      }, { value: tr('settingsIptv.cats.shownOf', { shown, total: cats.list.length }) }));
      rows.push(h.action(tr('settingsIptv.cats.hideAll'), () => {
        IPTV.source.direct.setHidden('live', cats.list.map((c) => c.id));
        cats.list.forEach((c) => { c.visible = false; });
        reloadSoon();
      }, { detail: tr('settingsIptv.cats.hideAllDetail') }));
      rows.push(h.note(tr('settingsIptv.pages.cats')));
      cats.list.forEach((c) => rows.push(h.toggle(c.name, () => c.visible, (v) => setVisible(c.id, v))));
    }
    return {
      title: tr('settingsIptv.pages.cats'),
      icon: 'grid',
      desc: tr('settingsIptv.cats.desc'),
      rows
    };
  };
})(window);
