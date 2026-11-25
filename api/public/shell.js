/**
 * THE SHELL: the sidebar, the top bar, and the one place that knows where a
 * screen lives.
 *
 * Ported from the #appRoot half of src/Index.html (the markup, lines
 * 233-369) and from applyRole / showView / setLive in src/App.html. Same
 * brand block, same groups in the same order, same icons path for path,
 * same labels, same collapse button, same top bar, same ids - so the
 * stylesheet in app.css, which is Styles.html copied whole, dresses it
 * without a single rule being added.
 *
 * ONE DIFFERENCE, AND IT IS THE WHOLE DESIGN.
 *
 * The original is ONE HTML document holding every screen as a hidden
 * <section class="view">, and showView() unhides one. That is not a choice
 * anybody made - HtmlService serves a single page and there is no second URL
 * to navigate to. This serves real files, so each screen is its own page and
 * a nav item is a link. Which means:
 *
 *   the browser's Back button works, and so does a bookmark;
 *   a screen's own state lives in its own URL - ?period=2026-05 opens there;
 *   opening KPI 1 does not first parse, lay out and wire KPI 2, Comparison,
 *   Summary, Accounts, Help and the whole portal, which on the original is
 *   around 20,000 lines of markup and script before anything is on screen.
 *
 * WHAT THAT RETIRES, and it is worth being explicit because they were real
 * features and they are not being dropped quietly:
 *
 *   state.trail and the in-app Back button. They existed because the
 *     browser's own Back would have left the app entirely. Here it does
 *     not, so the browser's is the trail - and it is a better one, because
 *     it survives a reload and the trail never did.
 *   rememberView() and the remembered screen. Same reason: the address bar
 *     remembers, and it remembers out loud.
 *
 * A SCREEN THAT IS NOT PORTED YET IS SHOWN AND DISABLED, not left out. The
 * nav is the map of the system: dropping Comparison would say it does not
 * exist, when what is true is that it is coming. Hovering says which.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.easShell = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLLAPSE_STORE = 'easNavCollapsed';

  /*
    THE ICONS, copied path for path out of Index.html. They are not
    decoration - a collapsed sidebar is nothing but these, so a wrong one
    makes a screen unreachable for anybody working at 58px.
  */
  const ICONS = {
    home:    '<path d="M2 7l6-5 6 5M4 6.5V13h8V6.5"/>',
    kpi1:    '<path d="M2 14h12M4.5 11V6M8 11V3M11.5 11V8"/>',
    kpi2:    '<path d="M14 9.5A1.5 1.5 0 0 1 12.5 11H6l-3.5 3V4.5A1.5 1.5 0 0 1 4 3h8.5A1.5 1.5 0 0 1 14 4.5z"/>',
    compare: '<path d="M2.5 3h4v10h-4zM9.5 3h4v7h-4z"/>',
    uploads: '<path d="M8 10.5V2M5 5l3-3 3 3M2.5 11v1.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V11"/>',
    settings:'<circle cx="8" cy="8" r="2.4"/><path d="M8 1.2v1.6M8 13.2v1.6M14.8 8h-1.6M2.8 8H1.2M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1M12.8 12.8l-1.1-1.1M4.3 4.3L3.2 3.2"/>',
    help:    '<circle cx="8" cy="8" r="6.3"/><path d="M6.1 6.1a1.95 1.95 0 0 1 3.8.6c0 1.3-1.9 1.6-1.9 2.9"/><path d="M8 12.1h.01"/>',
    master:  '<circle cx="6" cy="5.5" r="2.6"/><path d="M1.6 13.6c0-2.4 2-4 4.4-4s4.4 1.6 4.4 4"/><path d="M11.4 4.2a2.2 2.2 0 0 1 0 4.2"/><path d="M12.8 13.6c0-1.5-.5-2.7-1.4-3.5"/>'
  };

  /*
    THE MAP OF THE SYSTEM, in the order the sidebar shows it, from the nav
    in Index.html.

    `label` is what the button says AND what the top bar's viewLabel says.
    In the original those two came from different places - the markup, and
    the labels table inside showView - and were free to drift apart. They
    cannot now.

    `href` null means the screen is not ported yet.

    `needs` is the lowest role that is SHOWN the item, matching the
    data-admin-only / data-master-only attributes in Index.html. It is
    tidiness, not safety: every endpoint behind these screens checks the
    same thing on the server, because a URL is reachable whether or not a
    button for it exists. Code.gs says this about the same code.
  */
  const SCREENS = [
    /*
      HOME IS THE PORTAL, and the portal is a second shell - Portal.html,
      included into the same served page, with its own tabs and its own
      pages: Home, Team, Links, About, By-weekly, Learnings, Knowledge. In
      the original this button has no handler of its own either; showView()
      works out that home lives in the other shell and swaps #appRoot for
      #portalRoot. None of that is ported yet, so the button says so rather
      than landing somewhere nobody asked for.
    */
    { view: 'home', label: 'Home', href: null,
      soon: 'Home is the portal, a separate shell, and it is not ported yet' },

    { group: 'Indicators' },
    { view: 'kpi1', label: 'KPI 1 \u00b7 ITSM',     href: 'kpi1.html' },
    { view: 'kpi2', label: 'KPI 2 \u00b7 Training', href: 'kpi2.html' },
    { view: 'compare', label: 'Comparison', href: null },

    { group: 'Data' },
    { view: 'uploads', label: 'Data Uploads', href: 'uploads.html' },
    /*
      The internal name stays `settings`, so every saved link and bookmark
      with ?view=settings keeps working. Only what people read changes.
      showView in App.html says the same thing in the same words.
    */
    { view: 'settings', label: 'Summary', href: null },
    /*
      Help & FAQ is the team's inbox now rather than a help page, which is
      why it is ADMIN and above. Viewers are not losing anything: the FAQ
      moved into the message bar in the corner. The badge is the number of
      conversations waiting on a reply.
    */
    { view: 'help', label: 'Help & FAQ', href: null, needs: 'ADMIN',
      badge: 'helpBadge' },

    { group: 'Administration', needs: 'MASTER' },
    { view: 'master', label: 'Accounts', href: 'master.html', needs: 'MASTER' }
  ];

  /* Straight from ROLE_RANK in api/auth.js, which is Auth.gs's. */
  const RANK = { USER: 1, ADMIN: 2, MASTER: 3 };

  function rankOf(role) {
    return RANK[String(role || '').toUpperCase()] || 0;
  }

  /** What a screen is called. The pages use it for their own <title> too. */
  function labelOf(view) {
    let found = '';
    SCREENS.forEach(function (entry) {
      if (entry.view === view) found = entry.label;
    });
    return found || view || '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function byId(id) { return document.getElementById(id); }

  function setText(id, text) {
    const el = byId(id);
    if (el) el.textContent = text;
  }


  // =========================================================================
  // MOUNTING
  // =========================================================================

  /**
   * Puts the shell on this page and moves what was already there inside it.
   *
   * Call this ONCE, at DOM ready, BEFORE the page binds its own handlers -
   * Sign out lives in the top bar, so it has to exist before anything can
   * listen to it. Like #appRoot in Index.html the shell starts hidden, so
   * the sign-in card has the screen to itself; signedIn() reveals it.
   *
   * @param {Object} opts { view } - which screen this page is.
   * @return {Element} the .app element, or null if there was nothing to wrap.
   */
  function mount(opts) {
    const o = opts || {};
    const page = byId('page');
    if (!page || byId('appRoot')) return null;

    const app = document.createElement('div');
    app.className = 'app';
    app.id = 'appRoot';
    app.hidden = true;

    const aside = document.createElement('aside');
    aside.className = 'sidebar';
    aside.innerHTML = sidebarHtml(o);

    const main = document.createElement('main');
    main.className = 'main';
    main.innerHTML = topbarHtml(o);

    const content = document.createElement('div');
    content.className = 'content';

    /*
      INSERTED WHERE #page WAS, not appended to the body. A page may have
      things after #page - uploads.html has its dialogs - and appending
      would quietly reorder them.
    */
    page.parentNode.insertBefore(app, page);
    app.appendChild(aside);
    app.appendChild(main);
    main.appendChild(content);
    content.appendChild(page);

    wire(app);
    return app;
  }


  function sidebarHtml(o) {
    let items = '';

    SCREENS.forEach(function (entry) {
      /*
        PRESENT BUT HIDDEN, exactly as Index.html writes it: the attribute
        is in the markup and applyRole() unhides it. Not "left out until the
        role is known" - a nav that rebuilds itself after boot flickers, and
        a hidden attribute is what the stylesheet expects.
      */
      const gate = entry.needs === 'MASTER' ? ' data-master-only hidden'
                 : entry.needs === 'ADMIN'  ? ' data-admin-only hidden'
                 : '';

      if (entry.group) {
        items += '<div class="nav-group-label"' + gate + '>' +
                 escapeHtml(entry.group) + '</div>';
        return;
      }

      const soon = !entry.href;
      const title = soon ? (entry.soon || entry.label + ' is not ported yet')
                         : entry.label;

      items +=
        '<button class="nav-item' +
          (entry.view === o.view ? ' is-active' : '') + '"' +
          ' type="button" data-view="' + escapeHtml(entry.view) + '"' +
          (entry.href ? ' data-href="' + escapeHtml(entry.href) + '"' : '') +
          (soon ? ' data-soon="1"' : '') +
          gate +
          ' title="' + escapeHtml(title) + '">' +
          '<svg viewBox="0 0 16 16">' + (ICONS[entry.view] || '') + '</svg>' +
          '<span class="nav-text">' + escapeHtml(entry.label) + '</span>' +
          (entry.badge
            ? '<span class="nav-badge" id="' + escapeHtml(entry.badge) +
              '" hidden></span>'
            : '') +
        '</button>';
    });

    return '<div class="sidebar-inner">' +
      '<div class="brand">' +
        '<div class="brand-mark">EAS</div>' +
        '<div class="brand-text">' +
          /*
            Empty until boot fills them. The name and version come from the
            server in the original too - they are template values read off
            CONFIG - so a hard-coded copy here could outlive the real one.
          */
          '<strong id="brandName"></strong>' +
          '<span id="brandVersion"></span>' +
        '</div>' +
        '<button class="collapse-btn" id="collapseBtn" type="button" ' +
                'title="Minimise sidebar" aria-label="Minimise sidebar">' +
          '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" ' +
               'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
               'stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>' +
        '</button>' +
      '</div>' +
      '<nav class="nav">' + items + '</nav>' +
    '</div>';
  }


  /*
    THE TOP BAR, from Index.html lines 333-369, minus two things - and for
    stated reasons rather than by accident:

      the in-app Back button, because the browser's Back now does that job
        (see the note at the top of this file);
      the presence dot and the Away button, because presence - Presence.gs,
        paintPresenceSelf, the portal's own bar - is not ported yet. Half a
        presence indicator is worse than none: a dot reading OFFLINE because
        nothing updates it is a lie about a colleague.
  */
  function topbarHtml(o) {
    return '<header class="topbar">' +
      '<div class="topbar-left">' +
        '<span class="topbar-label">SIGNED IN:</span>' +
        '<strong id="operatorName">\u2014</strong>' +
      '</div>' +
      '<div class="topbar-right">' +
        '<span id="viewLabel">' + escapeHtml(labelOf(o.view)) + '</span>' +
        '<span class="topbar-sep"></span>' +
        '<span class="dot" id="liveDot"></span>' +
        '<span class="live-text" id="liveText">Live</span>' +
        '<span class="badge" id="roleBadge">VIEWER</span>' +
        '<button class="signout-btn" id="signOut" type="button" ' +
                'title="Sign out">Sign out</button>' +
      '</div>' +
    '</header>';
  }


  function wire(app) {
    app.querySelector('.nav').addEventListener('click', function (e) {
      const button = e.target.closest ? e.target.closest('.nav-item') : null;
      if (!button) return;

      const href = button.getAttribute('data-href');
      if (href) { window.location.href = href; return; }

      /*
        A SCREEN THAT IS NOT HERE YET SAYS SO WHEN IT IS CLICKED.

        NOT `disabled`, and NOT `aria-disabled` either - and the second one
        is the interesting mistake. It was there for one revision, on the
        reasoning that a screen with no page is disabled. But this button
        works: it is listened to, it answers, and it says something useful.
        `aria-disabled` would have told a screen-reader user the opposite of
        what everybody else gets, and it told Playwright the same thing, so
        the test could not click what a person can. A button that does
        nothing and gives no reason is the one thing worse than a button
        that is not there - and announcing itself as dead while being alive
        is a close third.
      */
      say(button.getAttribute('title') || 'That screen is not ported yet.');
    });

    const collapse = app.querySelector('#collapseBtn');
    if (collapse) {
      collapse.addEventListener('click', function () {
        const now = app.classList.toggle('is-collapsed');
        try { sessionStorage.setItem(COLLAPSE_STORE, now ? '1' : ''); }
        catch (e) { /* private mode - it just will not be remembered */ }
      });
    }
    /*
      Remembered for the tab, not forever: the gesture means "get out of my
      way while I read this table", and sessionStorage lasts exactly that
      long. It has to be re-read on every page now, because every screen is
      a fresh document where the original had one.
    */
    try {
      if (sessionStorage.getItem(COLLAPSE_STORE)) app.classList.add('is-collapsed');
    } catch (e) { /* fine */ }
  }


  // =========================================================================
  // WHO IS LOOKING
  // =========================================================================

  /**
   * Reveals the shell and fills in who this is.
   *
   * Ported from applyRole in App.html, which is where the badge's three
   * words come from: USER reads VIEWER, because "USER" on a badge beside
   * somebody's name tells them nothing they did not already know.
   *
   * @param {Object} boot the boot payload: role, username, appName,
   *                      appVersion.
   */
  function signedIn(boot) {
    const b = boot || {};
    const app = byId('appRoot');
    if (!app) return;

    const rank = rankOf(b.role);
    const isAdmin = rank >= RANK.ADMIN;
    const isMaster = rank >= RANK.MASTER;

    setText('brandName', b.appName || 'TVL-EAS Database');
    setText('brandVersion', b.appVersion || '');
    setText('operatorName', b.username || b.role || '\u2014');

    const badge = byId('roleBadge');
    if (badge) {
      badge.textContent = isMaster ? 'MASTER' : (isAdmin ? 'ADMIN' : 'VIEWER');
      badge.classList.toggle('is-admin', isAdmin);
      badge.classList.toggle('is-master', isMaster);
    }

    /*
      SCOPED TO THE SIDEBAR. The page has data-admin-only elements of its
      own and its own applyRole for them; this one must not reach into them
      and answer a question it was not asked.
    */
    const sidebar = app.querySelector('.sidebar');
    sidebar.querySelectorAll('[data-admin-only]').forEach(function (el) {
      el.hidden = !isAdmin;
    });
    sidebar.querySelectorAll('[data-master-only]').forEach(function (el) {
      el.hidden = !isMaster;
    });

    app.hidden = false;

    /*
      AND IF THE PASSWORD THEY JUST USED IS NOT THEIRS, that is the only
      thing on this screen until it is. See mustChangeCard below.
    */
    if (b.mustChange) mustChangeCard(b);
  }


  // =========================================================================
  // THE PASSWORD SOMEBODY ELSE CHOSE
  // =========================================================================

  /**
   * Shown when must_change is set, over whatever screen they landed on.
   *
   * THE RESET IS NOT FINISHED UNTIL THIS HAPPENS. A master resets somebody's
   * password, reads the new one off the screen and passes it on; that
   * password is temporary by design, and the only thing that makes it
   * temporary is this card. Without it, "Reset password" hands somebody a
   * password a colleague chose and knows, and they keep it.
   *
   * Over the screen rather than instead of it, which is what showView does
   * in the original: the app is up, and this is in front of it. Not
   * dismissible - no Escape, no backdrop click, no Cancel - because there
   * is nothing to go back to. The only ways out are setting a password or
   * signing out, and Sign out is still reachable behind it.
   *
   * It is not a security boundary and does not pretend to be: the token is
   * already valid and the API would answer it. It is the step that makes
   * the temporary password temporary, and the server is what refuses
   * anything that matters.
   */
  function mustChangeCard(boot) {
    if (byId('shellMustChange')) return;

    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.id = 'shellMustChange';
    wrap.innerHTML =
      '<div class="modal is-info" role="dialog" aria-modal="true" ' +
           'aria-labelledby="mcTitle">' +
        '<div class="modal-head">' +
          '<span class="modal-icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" ' +
                 'height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>' +
            '</svg>' +
          '</span>' +
          '<div>' +
            '<h2 id="mcTitle">Choose a password</h2>' +
            '<p class="modal-sub">The one you just used was set for you.</p>' +
          '</div>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p>It was chosen by somebody else and they still know it, so it ' +
             'is only good for getting you this far. Pick one of your own ' +
             'and it stops working.</p>' +
          '<label class="mc-label" for="mcCurrent">The password you just used</label>' +
          '<input class="mc-input" id="mcCurrent" type="password" ' +
                 'autocomplete="current-password">' +
          '<label class="mc-label" for="mcNext">A new password</label>' +
          '<input class="mc-input" id="mcNext" type="password" ' +
                 'autocomplete="new-password">' +
          '<label class="mc-label" for="mcConfirm">The same one again</label>' +
          '<input class="mc-input" id="mcConfirm" type="password" ' +
                 'autocomplete="new-password">' +
          '<p class="mc-why" id="mcWhy"></p>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn btn-primary" id="mcGo">Set my password</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(wrap);

    /*
      THE HANDFUL OF RULES THIS CARD NEEDS. Styles.html has no card like it
      - it is new, because the original's version is a whole view rather
      than a dialog - so the rules come with it rather than being added to
      a stylesheet that is a copy of somebody else's file.
    */
    if (!byId('shellMustChangeCss')) {
      const css = document.createElement('style');
      css.id = 'shellMustChangeCss';
      css.textContent =
        '#shellMustChange .mc-label { display: block; font-size: 12px;' +
        ' color: var(--text-dim); margin: 14px 0 4px; }' +
        '#shellMustChange .mc-input { width: 100%; padding: 9px 11px;' +
        ' border: 1px solid var(--line); border-radius: 8px; font: inherit;' +
        ' background: var(--card); color: var(--text); box-sizing: border-box; }' +
        '#shellMustChange .mc-why { color: var(--red); font-size: 13px;' +
        ' margin: 12px 0 0; min-height: 18px; }';
      document.head.appendChild(css);
    }

    const why = byId('mcWhy');
    const go = byId('mcGo');
    byId('mcCurrent').focus();

    async function save() {
      const current = byId('mcCurrent').value;
      const next = byId('mcNext').value;
      const confirm = byId('mcConfirm').value;

      why.textContent = '';
      go.disabled = true;
      try {
        const res = await fetch('/api/password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + (boot.token || tokenFromStore())
          },
          body: JSON.stringify({ current: current, next: next,
                                 confirm: confirm })
        });
        const data = await res.json().catch(function () { return null; });
        if (!res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) ||
                          ('the server answered ' + res.status));
        }
        wrap.remove();
        say('Your password is set. The old one has stopped working.');
      } catch (err) {
        why.textContent = err.message;
        go.disabled = false;
      }
    }

    go.addEventListener('click', save);
    ['mcCurrent', 'mcNext', 'mcConfirm'].forEach(function (id) {
      byId(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
      });
    });
  }


  /** The token the pages keep, for the one call the shell makes itself. */
  function tokenFromStore() {
    try { return sessionStorage.getItem('easToken') || ''; }
    catch (e) { return ''; }
  }


  /** Hides the shell again, so the sign-in card has the screen. */
  function signedOut() {
    const app = byId('appRoot');
    if (app) app.hidden = true;
  }


  /** setLive from App.html: the dot, and the word beside it. */
  function setLive(isLive) {
    const dot = byId('liveDot');
    const text = byId('liveText');
    if (dot) dot.classList.toggle('is-busy', !isLive);
    if (text) text.textContent = isLive ? 'Live' : 'Error';
  }


  /** A one-line notice at the top of the content column. */
  function say(text) {
    let box = byId('shellSays');
    if (!box) {
      const content = document.querySelector('.main .content');
      if (!content) return;
      box = document.createElement('div');
      box.id = 'shellSays';
      box.className = 'notice notice-info';
      content.insertBefore(box, content.firstChild);
    }
    box.hidden = false;
    box.textContent = text;
    clearTimeout(say.timer);
    say.timer = setTimeout(function () { box.hidden = true; }, 7000);
  }


  // =========================================================================
  // WHERE A SCREEN IS
  // =========================================================================

  /**
   * The URL for a screen, optionally opened on a period.
   *
   * This is the whole reason the shell owns a table of screens rather than
   * each page knowing its neighbours' filenames: the Uploads screen works
   * out which indicator an upload belongs to and which month or quarter it
   * covers, and it should be able to say "open that" without also having to
   * know that KPI 2 is a file called kpi2.html.
   *
   * @param {string} view   'kpi1' or 'kpi2'.
   * @param {string} period optional - YYYY-MM for KPI 1, YYYY-Qn for KPI 2.
   * @return {string} the URL, or '' if that screen is not ported yet.
   */
  function urlFor(view, period) {
    let href = '';
    SCREENS.forEach(function (entry) {
      if (entry.view === view && entry.href) href = entry.href;
    });
    if (!href) return '';
    return period ? href + '?period=' + encodeURIComponent(period) : href;
  }


  /** Goes there. Returns false if that screen is not ported yet. */
  function goTo(view, period) {
    const href = urlFor(view, period);
    if (!href) return false;
    window.location.href = href;
    return true;
  }


  /**
   * The period this page was opened on, if the URL named one.
   *
   * The screens check it themselves - KPI 1 wants a month it has data for,
   * KPI 2 wants a quarter - so this only reads it.
   */
  function periodFromUrl() {
    try {
      return new URLSearchParams(window.location.search).get('period') || '';
    } catch (e) {
      return '';
    }
  }


  return {
    mount: mount,
    signedIn: signedIn,
    mustChangeCard: mustChangeCard,
    signedOut: signedOut,
    setLive: setLive,
    say: say,
    urlFor: urlFor,
    goTo: goTo,
    periodFromUrl: periodFromUrl,
    labelOf: labelOf,
    SCREENS: SCREENS
  };
}));
