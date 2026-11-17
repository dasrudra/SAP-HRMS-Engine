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

const CONTAINER_CHROMIUM = '/opt/pw-browsers/chromium';

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

  // Playwright's own, if the full package downloaded one. executablePath()
  // answers even when nothing was downloaded, so the file is checked.
  try {
    const own = chromium.executablePath && chromium.executablePath();
    if (own && fs.existsSync(own)) return own;
  } catch (e) { /* core with no browser: nothing to find */ }

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
  if (said) return 'CHROMIUM_PATH is set to ' + said + ', and there is no file there';
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
