/**
 * dialog.js - the one modal, for every screen that has to ask something.
 * ===========================================================================
 *
 * confirmDialog from src/App.html, lifted out of the Uploads screen so the
 * Accounts screen does not get a second copy of it. Same markup, same ids,
 * same classes, same behaviour - app.css already dresses it, because
 * app.css is Styles.html copied whole.
 *
 * WHY THIS IS A FILE AND NOT SIXTY COPIED LINES. Two screens ask people
 * things, and both ask in ways that matter: "Remove the login for 20990025?"
 * and "Delete this upload?" are the two most destructive buttons in the
 * system. A dialog that behaves slightly differently on one of them -
 * Escape not working, Enter landing on Delete, the backdrop not closing -
 * is a difference nobody would notice until it mattered.
 *
 * THE MARKUP INJECTS ITSELF on first use rather than being pasted into
 * every page. A page that never asks anything never grows the element.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.easDialog = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MARKUP =
    '<div class="modal-backdrop" id="modalBackdrop" hidden>' +
      '<div class="modal" id="modal" role="alertdialog" aria-modal="true" ' +
           'aria-labelledby="modalTitle" aria-describedby="modalBody">' +
        '<div class="modal-head">' +
          '<span class="modal-icon" id="modalIcon" aria-hidden="true"></span>' +
          '<div>' +
            '<h2 id="modalTitle"></h2>' +
            '<p class="modal-sub" id="modalSub"></p>' +
          '</div>' +
        '</div>' +
        '<div class="modal-body" id="modalBody"></div>' +
        '<div class="modal-foot">' +
          '<button class="btn btn-ghost" id="modalCancel">Cancel</button>' +
          '<button class="btn btn-danger" id="modalConfirm">Delete</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  const BIN =
    '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>' +
    '<path d="M10 11v5M14 11v5"/></svg>';

  const INFO =
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 11v5M12 8h.01"/></svg>';


  /** Puts the markup on the page if it is not there already. */
  function ensure() {
    if (document.getElementById('modalBackdrop')) return true;
    if (!document.body) return false;
    const holder = document.createElement('div');
    holder.innerHTML = MARKUP;
    document.body.appendChild(holder.firstChild);
    return true;
  }


  /**
   * Asks, and resolves true or false.
   *
   * @param {Object} opts
   *   title        the question
   *   subtitle     a line under it, optional
   *   target       HTML shown above the body - what is being acted on
   *   body         HTML
   *   confirmLabel the word on the button that does it
   *   tone         'info' for anything that is not destructive. NOT
   *                decoration: the dialog wears a bin icon and a red button
   *                unless told otherwise, and "Make admin" wearing a bin is
   *                a sentence the screen did not mean to say.
   *   oneButton    true to drop Cancel, for a dialog that only informs
   */
  function ask(opts) {
    const o = opts || {};
    if (!ensure()) return Promise.resolve(window.confirm(o.title));

    const backdrop = document.getElementById('modalBackdrop');
    const box = document.getElementById('modal');
    const danger = o.tone !== 'info';

    box.className = 'modal' + (danger ? '' : ' is-info');
    document.getElementById('modalIcon').innerHTML = danger ? BIN : INFO;
    document.getElementById('modalTitle').textContent = o.title || 'Are you sure?';
    document.getElementById('modalSub').textContent = o.subtitle || '';
    document.getElementById('modalBody').innerHTML =
      (o.target || '') + (o.body || '');

    const confirm = document.getElementById('modalConfirm');
    const cancel = document.getElementById('modalCancel');
    confirm.textContent = o.confirmLabel || 'Delete';
    confirm.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    confirm.disabled = false;
    cancel.hidden = Boolean(o.oneButton);

    backdrop.hidden = false;
    // Cancel takes focus, not Delete - Enter should not destroy anything.
    // Unless there is no Cancel, which is the one-button form.
    (cancel.hidden ? confirm : cancel).focus();

    return new Promise(function (resolve) {
      function close(answer) {
        backdrop.hidden = true;
        /*
          AND THE BODY IS EMPTIED, which is not tidiness.

          Two dialogs in this system show a password exactly once - a reset
          and an invitation - and both say "it is shown here and nowhere
          else". That was very nearly true: hiding the backdrop leaves the
          markup in the page, so the password sat in the DOM until the next
          dialog happened to overwrite it, readable by anything that could
          read the page. A test asked whether the sentence was true and it
          was not.

          Cleared on the way out rather than on the way in, so it is gone
          the moment the dialog is dismissed rather than whenever the next
          one opens.
        */
        document.getElementById('modalBody').innerHTML = '';
        document.getElementById('modalTitle').textContent = '';
        document.getElementById('modalSub').textContent = '';
        confirm.removeEventListener('click', onYes);
        cancel.removeEventListener('click', onNo);
        backdrop.removeEventListener('mousedown', onOutside);
        document.removeEventListener('keydown', onKey);
        resolve(answer);
      }
      function onYes() { close(true); }
      function onNo() { close(false); }
      function onOutside(e) { if (e.target === backdrop) close(false); }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
      }
      confirm.addEventListener('click', onYes);
      cancel.addEventListener('click', onNo);
      backdrop.addEventListener('mousedown', onOutside);
      document.addEventListener('keydown', onKey);
    });
  }


  /**
   * Says something and waits to be dismissed. One button, never red.
   *
   * Used for the two places a password is shown once and cannot be shown
   * again - a reset and an invitation - where there is nothing to confirm
   * and the only thing that matters is that it was read.
   */
  function tell(opts) {
    const o = opts || {};
    return ask({
      title: o.title,
      subtitle: o.subtitle,
      body: o.body,
      tone: 'info',
      oneButton: true,
      confirmLabel: o.confirmLabel || 'Close'
    });
  }


  return { confirm: ask, tell: tell };
}));
