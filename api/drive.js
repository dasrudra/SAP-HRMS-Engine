/**
 * drive.js - the Learnings folders, read and rearranged.
 * ===========================================================================
 *
 * The one place this system talks to Google. It lists the two Drive folders
 * the library is built from, and moves a file from one to the other when
 * somebody archives it.
 *
 * ---------------------------------------------------------------------------
 * NO NEW DEPENDENCY, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * The obvious build is `npm install googleapis`. It is about a hundred
 * megabytes and brings in a hundred APIs to call two endpoints. This
 * package.json has five dependencies and every one of them earns its place.
 *
 * A service account signs in by making a JWT, signing it with its own
 * private key, and swapping it for an access token. Node signs RS256 with
 * the crypto module it already has - messenger-write.js requires the same
 * one - and the two Drive calls are ordinary fetch. That is the whole
 * client, and it is ninety lines rather than a hundred megabytes.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CAN REACH, AND WHY THE SCOPE IS NOT THE ANSWER TO THAT
 * ---------------------------------------------------------------------------
 *
 * The scope is the full drive scope, because moving a file is a write and
 * the narrower drive.file scope only covers files the application itself
 * created - which is none of these.
 *
 * WHAT LIMITS THIS IS NOT THE SCOPE BUT THE SHARING. A service account is
 * its own Google account with an empty Drive, and it can see exactly what
 * has been shared with it and nothing else. Share the two Learnings folders
 * with it and that is its whole world; share nothing and the scope buys it
 * nothing at all. So the thing to be careful about is what you share, not
 * what this asks for.
 *
 * AND IT IS NOT A PERSON. The key belongs to no employee, so nothing here
 * can read somebody's mail or their own Drive, and an employee leaving does
 * not take the library with them.
 *
 * ---------------------------------------------------------------------------
 * THE KEY
 * ---------------------------------------------------------------------------
 *
 * In a file, with its path in api/.env, and never in the repository:
 *
 *     GOOGLE_KEY_FILE=C:\keys\tvl-eas-learnings.json
 *
 * .gitignore covers the usual names, but the only safe place for it is
 * outside this folder altogether. The file is a password: anybody holding
 * it can do to those folders whatever the account can.
 *
 * NOTHING HERE IS REQUIRED FOR THE REST OF THE SYSTEM. With no key
 * configured, ready() answers false and the Learnings screen says the
 * library has not been connected yet - every other screen is unaffected.
 * That is the same choice backup.js makes about BACKUP_SCHEDULED: a feature
 * that is not set up says so, and does not take the application down.
 */

const crypto = require('crypto');
const fs = require('fs');


const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive';

/* An access token lasts an hour. Asked for again a minute early, because a
   token that expires between the check and the call is a 401 nobody can
   reproduce. */
const EARLY_MS = 60 * 1000;

let cached = { token: '', until: 0 };


/** The service account, or null when none is configured. */
function account() {
  const file = String(process.env.GOOGLE_KEY_FILE || '').trim();
  if (!file) return null;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error('GOOGLE_KEY_FILE is set to ' + file +
                    ', which could not be read: ' + err.message);
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error('GOOGLE_KEY_FILE is not JSON. Download the key again ' +
                    'from the Google Cloud console.');
  }

  if (!json.client_email || !json.private_key) {
    throw new Error('GOOGLE_KEY_FILE has no client_email or private_key. ' +
                    'That is not a service account key file.');
  }
  return json;
}


/** Whether the library can be reached at all. */
function ready() {
  try {
    return Boolean(account());
  } catch (err) {
    // A key that is configured but broken is NOT ready, and the reason is
    // worth a line in the log where an admin will see it rather than a
    // thrown error on a page that could have drawn without it.
    console.error('  drive: ' + err.message);
    return false;
  }
}


function base64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}


/**
 * An access token, cached until it is nearly out.
 *
 * The JWT is the whole of the sign-in: header and claim set, base64url, a
 * dot between them, signed RS256 with the account's private key. Google
 * swaps it for a token.
 */
async function token() {
  if (cached.token && Date.now() < cached.until) return cached.token;

  const sa = account();
  if (!sa) throw new Error('No Google key is configured. See GOOGLE_KEY_FILE.');

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + claim);
  const jwt = header + '.' + claim + '.' +
              base64url(signer.sign(sa.private_key));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const data = await res.json().catch(function () { return null; });
  if (!res.ok || !data || !data.access_token) {
    /*
      THE REASON GOOGLE GIVES, not just the status. 'invalid_grant' here
      almost always means the machine's clock is wrong or the key has been
      revoked, and neither is guessable from "the server answered 400".
    */
    throw new Error('Google refused the key: ' +
                    ((data && (data.error_description || data.error)) ||
                     ('HTTP ' + res.status)));
  }

  cached = {
    token: data.access_token,
    until: Date.now() + (Number(data.expires_in) || 3600) * 1000 - EARLY_MS
  };
  return cached.token;
}


async function call(url, options) {
  const opts = options || {};
  const res = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({ Authorization: 'Bearer ' + await token() },
                           opts.headers || {})
  }));

  const data = await res.json().catch(function () { return null; });
  if (!res.ok) {
    const why = (data && data.error && data.error.message) ||
                ('HTTP ' + res.status);
    /*
      404 FROM DRIVE USUALLY MEANS "not shared with me" rather than "does
      not exist", because a service account cannot see what it has not been
      given. Said here, because the alternative is somebody checking the
      folder id three times while the real answer is a sharing dialog.
    */
    throw new Error(res.status === 404
      ? why + ' - check the folder is shared with the service account'
      : why);
  }
  return data;
}


/**
 * One folder's files and subfolders.
 *
 * PAGED, because Drive answers 100 at a time by default and the library is
 * already 250 documents. A first version that ignored nextPageToken would
 * work on a test folder and silently lose two thirds of the real one.
 *
 * `trashed` comes back on every file so the walk can skip it: Drive keeps a
 * trashed file reachable through its parent, and a document somebody
 * deleted last week should not still be on the page.
 */
async function list(folderId) {
  const files = [];
  const folders = [];
  let page = '';

  do {
    const params = new URLSearchParams({
      q: "'" + String(folderId).replace(/'/g, "\\'") + "' in parents",
      fields: 'nextPageToken, files(id, name, mimeType, size, ' +
              'modifiedTime, trashed)',
      pageSize: '200',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    });
    if (page) params.set('pageToken', page);

    const got = await call(FILES_URL + '?' + params.toString());
    (got.files || []).forEach(function (f) {
      if (f.mimeType === 'application/vnd.google-apps.folder') folders.push(f);
      else files.push(f);
    });
    page = got.nextPageToken || '';
  } while (page);

  return { files: files, folders: folders };
}


/** One file's name, parents and type. */
async function get(fileId) {
  return call(FILES_URL + '/' + encodeURIComponent(fileId) +
              '?fields=id,name,mimeType,size,modifiedTime,trashed,parents' +
              '&supportsAllDrives=true');
}


/**
 * Moves a file from wherever it is into one folder.
 *
 * A MOVE IN DRIVE IS A CHANGE OF PARENT, not a copy and a delete. That
 * matters here: the file id does not change, so the row in `learn` keeps
 * its primary key, every link already written down still opens it, and its
 * revision history comes with it. Copying and deleting would break all
 * three and look identical on screen.
 */
async function move(fileId, intoFolderId) {
  const file = await get(fileId);
  const from = (file.parents || []).join(',');

  const params = new URLSearchParams({
    addParents: String(intoFolderId),
    fields: 'id, name, parents',
    supportsAllDrives: 'true'
  });
  if (from) params.set('removeParents', from);

  return call(FILES_URL + '/' + encodeURIComponent(fileId) + '?' +
              params.toString(), { method: 'PATCH' });
}


/** The two roots, from api/.env. */
function roots() {
  return {
    live: String(process.env.LEARN_FOLDER_ID || '').trim(),
    archive: String(process.env.LEARN_ARCHIVE_FOLDER_ID || '').trim()
  };
}


/**
 * Whoever this is, for the log and for the setup screen.
 *
 * The address is what has to be shared with the folders, and an admin
 * reading "share it with the service account" needs to be told which one.
 */
function whoAmI() {
  try {
    const sa = account();
    return sa ? sa.client_email : '';
  } catch (err) {
    return '';
  }
}


module.exports = { ready, whoAmI, roots, token, list, get, move };
