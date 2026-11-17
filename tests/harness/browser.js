/**
 * browser.js - where Chromium is, which is a different answer on every machine.
 * ============================================================================
 *
 * WHY THIS EXISTS
 * Ten suites drive a real browser, and each one used to carry the same two
 * lines: a hard-coded '/opt/pw-browsers/chromium' and a check that the file is
 * there. That path is real inside the Linux container this project was first
 * written in, and nowhere else. On a Windows laptop every one of those ten
 * suites printed SKIP - so somebody who had just cloned the repo and done
 * everything right saw ten skipped suites and no explanation of what to
 * install, which looks exactly like a broken checkout.
 *
 * WHERE A BROWSER MIGHT BE, in the order worth trying:
 *
 *   CHROMIUM_PATH          somebody said, so use it and complain if it is wrong
 *   /opt/pw-browsers/...   the container image keeps one here
 *   playwright's own       a full `playwright` install downloads one and knows
 *                          where it put it
 *
 * ON THE TWO PACKAGES
 * `playwright-core` is the driver with NO browser. `playwright` is the same
 * driver that also downloads one. The container has core plus a browser put
 * there by the image, so core is all it needs; a laptop needs the full package
 * (or core plus `npx playwright install chromium`). Both are accepted here
 * because both are correct, and which one you have is not a thing to have to
 * know before the tests will run.
 */

const fs = require('fs');
const path = require('path');

const CONTAINER_CHROMIUM = '/opt/pw-browsers/chromium';


/**
 * Whether that executable can actually start, as far as can be told cheaply.
 *
 * THE FILE BEING THERE IS NOT THE QUESTION, and on a corporate Windows
 * machine it is not even a good guess. Playwright downloads Chromium as a
 * 207MB zip, extracts about sixty files, and endpoint security then deletes
 * the big unsigned ones - chrome.dll and chrome_elf.dll among them - leaving
 * chrome.exe sitting there looking installed. existsSync says yes, the
 * launch says "The specified module could not be found", and every browser
 * suite dies the same way.
 *
 * chrome.dll next to chrome.exe is the cheapest way to tell the difference,
 * and it is the file that goes missing, so checking it costs one stat and
 * turns a wall of launch failures into a clean fall through to the next
 * candidate.
 */
function startable(exe) {
  if (!exe || !fs.existsSync(exe)) return false;
  if (process.platform !== 'win32') return true;
  if (!/chrome\.exe$/i.test(exe)) return true;      // msedge.exe and friends
  return fs.existsSync(path.join(path.dirname(exe), 'chrome.dll'));
}


/**
 * Chromium-based browsers already installed on this machine.
 *
 * The way out when the downloaded one has been quarantined. Edge is on every
 * Windows machine, is Chromium underneath, and - being signed by Microsoft
 * and installed by IT - is the one copy corporate security will not touch.
 * Playwright drives it through the same API.
 *
 * Only consulted after Playwright's own, because a pinned browser is worth
 * having when there is one: a suite that passes here and fails on somebody
 * else's Edge is a suite nobody can trust.
 */
function installedBrowsers() {
  if (process.platform !== 'win32') return [];
  const roots = [process.env['ProgramFiles'],
                 process.env['ProgramFiles(x86)'],
                 process.env.LOCALAPPDATA].filter(Boolean);
  const under = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe']
  ];
  const out = [];
  roots.forEach(function (root) {
    under.forEach(function (bits) {
      out.push(path.join.apply(path, [root].concat(bits)));
    });
  });
  return out;
}

let chromium = null;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  try {
    chromium = require('playwright-core').chromium;
  } catch (e2) {
    chromium = null;
  }
}


/** The browser to launch, or '' when there is not one. */
function findBrowser() {
  if (!chromium) return '';

  // Said explicitly. Not silently ignored when it is wrong: somebody who set
  // this meant it, and falling back to another browser would answer a
  // question they did not ask.
  const said = String(process.env.CHROMIUM_PATH || '').trim();
  if (said) return fs.existsSync(said) ? said : '';

  if (fs.existsSync(CONTAINER_CHROMIUM)) return CONTAINER_CHROMIUM;

  // Playwright's own, if the full package downloaded one AND it survived
  // whatever this machine does to downloaded executables.
  try {
    const own = chromium.executablePath && chromium.executablePath();
    if (startable(own)) return own;
  } catch (e) { /* core with no browser: nothing to find */ }

  // Then whatever Chromium this machine already trusts.
  const installed = installedBrowsers().filter(startable);
  if (installed.length) return installed[0];

  return '';
}


const BROWSER = findBrowser();


/**
 * Why these tests cannot run here, or '' when they can.
 *
 * It names the command to type. A SKIP that says what is missing and not what
 * to do about it is a SKIP that stays for ever.
 */
function skipReason() {
  if (!chromium) {
    return 'playwright is not installed - run: npm install -D playwright';
  }
  const said = String(process.env.CHROMIUM_PATH || '').trim();
  if (said) return 'CHROMIUM_PATH is set to ' + said + ', and there is no usable browser there';

  /*
    AND IF A DOWNLOADED ONE IS THERE BUT GUTTED, say so, because the fix is
    not another download. Security software on a managed machine deletes
    chrome.dll after the install finishes, and "run playwright install" -
    which is what this used to say - sends somebody round that loop for an
    afternoon.
  */
  try {
    const own = chromium.executablePath && chromium.executablePath();
    if (own && fs.existsSync(own) && !startable(own)) {
      return 'Chromium is installed at ' + own + ' but chrome.dll is missing ' +
             'beside it - something removed it after the download, usually ' +
             'antivirus. Ask IT to exclude the ms-playwright folder, or ' +
             'install Microsoft Edge, which these tests will use instead.';
    }
  } catch (e) { /* nothing downloaded at all */ }

  return 'no Chromium to drive - run: npx playwright install chromium';
}


/**
 * Launches it, with executablePath only when one was found.
 *
 * Passing executablePath: undefined is NOT the same as leaving it out -
 * Playwright reads the key, finds undefined and looks for a browser at
 * "undefined". So the key is added or it is not.
 */
function launch(options) {
  const opts = Object.assign({}, options || {});
  if (BROWSER) opts.executablePath = BROWSER;

  /*
    THE FILE BEING THERE IS NOT THE SAME QUESTION AS THE BROWSER WORKING.

    A download that stopped halfway leaves chrome.exe on disk with some of
    the DLLs beside it missing. existsSync says yes, the launch says "The
    specified module could not be found", and Playwright prints the whole
    command line and every browser log line it has - several hundred lines,
    once per suite, ten times over. Somewhere in there is one fact worth
    having and one command that fixes it.
  */
  return chromium.launch(opts).catch(function (err) {
    const why = String((err && err.message) || err);
    if (/module could not be found|0x7E|chrome\.dll|ERR_MODULE/i.test(why)) {
      throw new Error(
        'Chromium is installed but will not start - the download looks ' +
        'incomplete.\n' +
        '      Fix it with:  npx playwright install --force chromium\n' +
        '      Browser: ' + (BROWSER || 'playwright default') + '\n' +
        '      ' + why.split('\n')[0]);
    }
    throw err;
  });
}


module.exports = {
  chromium: chromium,
  browserPath: BROWSER,
  ready: Boolean(chromium && BROWSER),
  skipReason: skipReason,
  launch: launch
};
