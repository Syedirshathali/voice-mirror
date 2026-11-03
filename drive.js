/* Voice Mirror: Google Drive storage.
 *
 * Keeps generated clips, recordings and progress in a "Voice Mirror" folder in
 * the user's own Drive, so nothing large has to live on the phone.
 * Scope is drive.file: the app can only see files it created itself.
 * Sign-in uses Google Identity Services (token flow, no server needed).
 */
const Drive = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const FOLDER_NAME = 'Voice Mirror';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const K_ON = 'vm_drive_on', K_FOLDER = 'vm_drive_folder';

  const mem = {};
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { mem[k] = v; } },
    del(k) { try { localStorage.removeItem(k); } catch { delete mem[k]; } }
  };

  let clientId = '';
  let token = null, expires = 0, tokenClient = null, pendingToken = null;
  let folderId = null, index = null, indexLoading = null;
  const inflight = new Map();

  function fail(code, message) { const e = new Error(message); e.code = code; return e; }

  function configure(id) {
    id = (id || '').trim();
    if (id !== clientId) { clientId = id; tokenClient = null; token = null; expires = 0; }
  }
  const hasClientId = () => !!clientId;
  const connected = () => !!clientId && ls.get(K_ON) === '1';
  const hasToken = () => !!token && Date.now() < expires;

  // ---- sign-in -----------------------------------------------------------
  function loadGis() {
    if (globalThis.google?.accounts?.oauth2) return Promise.resolve(globalThis.google.accounts.oauth2);
    return new Promise((res, rej) => {
      if (typeof document === 'undefined') return rej(fail('no_gis', 'Google sign-in is unavailable here.'));
      const s = document.createElement('script');
      s.src = GIS_SRC; s.async = true;
      s.onload = () => globalThis.google?.accounts?.oauth2
        ? res(globalThis.google.accounts.oauth2)
        : rej(fail('no_gis', 'Google sign-in did not load.'));
      s.onerror = () => rej(fail('offline', 'Could not load Google sign-in. Check your connection.'));
      document.head.appendChild(s);
    });
  }

  async function requestToken(prompt) {
    if (!clientId) throw fail('no_client', 'Add your Google OAuth client ID in Settings first.');
    if (pendingToken) return pendingToken;
    const oauth2 = await loadGis();
    pendingToken = new Promise((res, rej) => {
      tokenClient = oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        callback: r => {
          if (r.error) return rej(fail('auth', r.error_description || r.error));
          token = r.access_token;
          expires = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
          res(token);
        },
        error_callback: e => rej(fail('auth', e?.type === 'popup_failed_to_open'
          ? 'The sign-in window was blocked. Tap the Drive banner to sign in.'
          : (e?.message || e?.type || 'Sign-in was cancelled.')))
      });
      tokenClient.requestAccessToken({ prompt });
    }).finally(() => { pendingToken = null; });
    return pendingToken;
  }

  /** Interactive sign-in; call from a tap. */
  async function connect() {
    await requestToken('');
    ls.set(K_ON, '1');
    await ensureIndex(true);
    return true;
  }

  /** Token for background use. Needs a prior connect(); may need a tap if the browser blocks the pop-up. */
  async function ensureToken() {
    if (hasToken()) return token;
    if (!connected()) throw fail('not_connected', 'Google Drive is not connected.');
    return requestToken('');
  }

  function disconnect() {
    try { if (token && globalThis.google?.accounts?.oauth2) globalThis.google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ }
    token = null; expires = 0; folderId = null; index = null; indexLoading = null;
    ls.del(K_ON); ls.del(K_FOLDER);
  }

  // ---- REST --------------------------------------------------------------
  async function call(url, opts = {}, retry = true) {
    const t = await ensureToken();
    let r;
    try {
      r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
    } catch (e) {
      throw fail('offline', 'Could not reach Google Drive. Check your connection.');
    }
    if (r.status === 401 && retry) { token = null; expires = 0; return call(url, opts, false); }
    if (!r.ok) {
      let msg = r.status + ' ' + (r.statusText || '');
      try { const j = await r.json(); msg = j.error?.message || msg; } catch { /* keep status */ }
      throw fail(r.status === 404 ? 'not_found' : 'http', 'Google Drive: ' + msg);
    }
    return r;
  }

  const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  async function ensureFolder() {
    if (folderId) return folderId;
    folderId = ls.get(K_FOLDER);
    if (folderId) return folderId;
    const found = await (await call(`${API}/files?` + new URLSearchParams({
      q: `name='${q(FOLDER_NAME)}' and mimeType='${FOLDER_MIME}' and trashed=false`,
      fields: 'files(id)', pageSize: '1', spaces: 'drive'
    }))).json();
    if (found.files?.length) folderId = found.files[0].id;
    else {
      const made = await (await call(`${API}/files?fields=id`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME })
      })).json();
      folderId = made.id;
    }
    ls.set(K_FOLDER, folderId);
    return folderId;
  }

  async function ensureIndex(force) {
    if (index && !force) return index;
    if (indexLoading && !force) return indexLoading;
    indexLoading = (async () => {
      const fid = await ensureFolder();
      const map = new Map();
      let pageToken = '';
      do {
        const p = new URLSearchParams({
          q: `'${fid}' in parents and trashed=false`,
          fields: 'nextPageToken,files(id,name,modifiedTime)', pageSize: '1000'
        });
        if (pageToken) p.set('pageToken', pageToken);
        let j;
        try { j = await (await call(`${API}/files?${p}`)).json(); }
        catch (e) {
          if (e.code === 'not_found') { folderId = null; ls.del(K_FOLDER); return ensureIndex(true); } // folder was deleted
          throw e;
        }
        for (const f of j.files || []) {
          const old = map.get(f.name);
          if (!old || f.modifiedTime > old.modifiedTime) map.set(f.name, { id: f.id, modifiedTime: f.modifiedTime });
        }
        pageToken = j.nextPageToken || '';
      } while (pageToken);
      index = map;
      return map;
    })().finally(() => { indexLoading = null; });
    return indexLoading;
  }

  const has = async name => (await ensureIndex()).has(name);
  async function nameStarting(prefix) {
    let best = null;
    for (const [n, f] of await ensureIndex()) if (n.startsWith(prefix) && (!best || f.modifiedTime > best.t)) best = { n, t: f.modifiedTime };
    return best ? best.n : null;
  }

  async function getBlob(name) {
    const f = (await ensureIndex()).get(name);
    if (!f) return null;
    try { return await (await call(`${API}/files/${f.id}?alt=media`)).blob(); }
    catch (e) { if (e.code === 'not_found') { index.delete(name); return null; } throw e; }
  }

  function multipart(meta, blob) {
    const b = 'vm' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${b}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`, blob, `\r\n--${b}--`
    ]);
    return { body, type: `multipart/related; boundary=${b}` };
  }

  async function putBlob(name, blob, description = '') {
    if (inflight.has(name)) await inflight.get(name).catch(() => {});
    const job = (async () => {
      const fid = await ensureFolder();
      const idx = await ensureIndex();
      const existing = idx.get(name);
      const meta = { name, description: String(description).slice(0, 500) };
      if (blob.type) meta.mimeType = blob.type;
      if (!existing) meta.parents = [fid];
      const { body, type } = multipart(meta, blob);
      const url = existing
        ? `${UPLOAD}/files/${existing.id}?uploadType=multipart&fields=id,modifiedTime`
        : `${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`;
      const j = await (await call(url, { method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': type }, body })).json();
      idx.set(name, { id: j.id, modifiedTime: j.modifiedTime || new Date().toISOString() });
    })();
    inflight.set(name, job);
    try { await job; } finally { if (inflight.get(name) === job) inflight.delete(name); }
  }

  async function getJson(name) {
    const b = await getBlob(name);
    if (!b) return null;
    try { return JSON.parse(await b.text()); } catch { return null; }
  }
  const putJson = (name, obj, description) =>
    putBlob(name, new Blob([JSON.stringify(obj)], { type: 'application/json' }), description);

  /** Stable, filesystem-safe file name for an arbitrary key. */
  async function hash(str) {
    const data = new TextEncoder().encode(str);
    if (globalThis.crypto?.subtle) {
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
      return [...d].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (const c of data) { h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  return { configure, hasClientId, connected, hasToken, connect, ensureToken, disconnect,
           has, nameStarting, getBlob, putBlob, getJson, putJson, hash, FOLDER_NAME };
})();

if (typeof module !== 'undefined') module.exports = Drive;
