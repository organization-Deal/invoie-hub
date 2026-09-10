const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

const DEFAULT_QUERY = '{subject:invoice subject:receipt subject:"tax invoice" subject:"ใบเสร็จ" subject:"ใบกำกับภาษี" filename:pdf}';

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/') return html(dashboardHtml());
      if (url.pathname === '/health') return json({ ok: true, app: env.APP_NAME || 'DEAL Invoice Hub' });

      if (url.pathname === '/auth/gmail/start') return startOAuth(env, 'gmail_source');
      if (url.pathname === '/auth/gmail/callback') return finishOAuth(request, env, 'gmail_source');
      if (url.pathname === '/auth/drive/start') return startOAuth(env, 'drive_storage');
      if (url.pathname === '/auth/drive/callback') return finishOAuth(request, env, 'drive_storage');

      if (url.pathname === '/api/accounts' && request.method === 'GET') return listAccounts(env);
      if (url.pathname === '/api/documents' && request.method === 'GET') return listDocuments(request, env);
      if (url.pathname === '/api/stats' && request.method === 'GET') return stats(env);
      if (url.pathname === '/api/settings' && request.method === 'GET') return getSettings(env);
      if (url.pathname === '/api/settings' && request.method === 'POST') return saveSettings(request, env);
      if (url.pathname === '/api/sync' && request.method === 'POST') return syncOne(request, env);
      if (url.pathname === '/api/sync-all' && request.method === 'POST') return syncAll(env, 30);
      if (url.pathname.startsWith('/api/documents/') && request.method === 'PATCH') return updateDocument(request, env);
      if (url.pathname.startsWith('/api/accounts/') && request.method === 'DELETE') return disableAccount(request, env);

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error(err);
      return json({ error: err.message || String(err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAllInternal(env, 2));
  }
};

async function startOAuth(env, flowType) {
  requireSecrets(env);
  const state = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO oauth_states(state, flow_type) VALUES(?, ?)').bind(state, flowType).run();

  const scopes = flowType === 'gmail_source'
    ? ['https://www.googleapis.com/auth/gmail.readonly']
    : ['https://www.googleapis.com/auth/drive.file'];

  const redirect = `${env.BASE_URL}/auth/${flowType === 'gmail_source' ? 'gmail' : 'drive'}/callback`;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state
  });
  return Response.redirect(`${GOOGLE_AUTH}?${params}`, 302);
}

async function finishOAuth(request, env, flowType) {
  requireSecrets(env);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) return html(messagePage('เชื่อมต่อไม่สำเร็จ', error), 400);
  if (!code || !state) return html(messagePage('ข้อมูล OAuth ไม่ครบ', 'Missing code/state'), 400);

  const row = await env.DB.prepare('SELECT * FROM oauth_states WHERE state=? AND flow_type=?').bind(state, flowType).first();
  if (!row) return html(messagePage('State ไม่ถูกต้องหรือหมดอายุ', 'ลองเชื่อมบัญชีใหม่อีกครั้ง'), 400);
  await env.DB.prepare('DELETE FROM oauth_states WHERE state=?').bind(state).run();

  const redirect = `${env.BASE_URL}/auth/${flowType === 'gmail_source' ? 'gmail' : 'drive'}/callback`;
  const tokenResp = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirect,
      grant_type: 'authorization_code'
    })
  });
  const token = await tokenResp.json();
  if (!tokenResp.ok) throw new Error(`OAuth token exchange failed: ${JSON.stringify(token)}`);
  if (!token.refresh_token) throw new Error('Google did not return refresh_token. Revoke app access then connect again with consent.');

  let email;
  if (flowType === 'gmail_source') {
    const profile = await googleJson(`${GMAIL_API}/users/me/profile`, token.access_token);
    email = profile.emailAddress;
  } else {
    email = await getDriveOwnerEmail(token.access_token);
  }

  const enc = await encryptSecret(token.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  await env.DB.prepare(`
    INSERT INTO google_accounts(email, account_type, refresh_token_enc, scope, is_active, updated_at)
    VALUES(?,?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(email, account_type) DO UPDATE SET
      refresh_token_enc=excluded.refresh_token_enc,
      scope=excluded.scope,
      is_active=1,
      updated_at=CURRENT_TIMESTAMP
  `).bind(email, flowType, enc, token.scope || '').run();

  if (flowType === 'drive_storage') {
    const root = await createDriveFolder(token.access_token, 'DEAL Invoice Hub');
    await setSetting(env, 'root_drive_folder_id', root.id);
    await env.DB.prepare('INSERT OR REPLACE INTO drive_folders(path, drive_folder_id) VALUES(?,?)').bind('/', root.id).run();
  }

  return html(messagePage('เชื่อมต่อสำเร็จ', `${email} ถูกเพิ่มเข้า Invoice Hub แล้ว`, true));
}

async function getDriveOwnerEmail(accessToken) {
  const about = await googleJson(`${DRIVE_API}/about?fields=user(emailAddress)`, accessToken);
  return about.user?.emailAddress || 'drive-storage';
}

async function listAccounts(env) {
  const rs = await env.DB.prepare(`SELECT id,email,account_type,last_sync_at,is_active,created_at FROM google_accounts ORDER BY account_type,email`).all();
  return json(rs.results || []);
}

async function listDocuments(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const status = (url.searchParams.get('status') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 300);
  const params = [];
  let where = 'WHERE 1=1';
  if (q) {
    where += ' AND (d.subject LIKE ? OR d.sender LIKE ? OR d.filename LIKE ? OR d.vendor LIKE ? OR d.invoice_number LIKE ?)';
    const like = `%${q}%`; params.push(like, like, like, like, like);
  }
  if (status) { where += ' AND d.status=?'; params.push(status); }
  params.push(limit);
  const rs = await env.DB.prepare(`
    SELECT d.*, a.email AS source_email
    FROM documents d JOIN google_accounts a ON a.id=d.source_account_id
    ${where}
    ORDER BY COALESCE(d.received_at,d.created_at) DESC LIMIT ?
  `).bind(...params).all();
  return json(rs.results || []);
}

async function stats(env) {
  const docs = await env.DB.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN status='needs_review' THEN 1 ELSE 0 END) review FROM documents`).first();
  const accounts = await env.DB.prepare(`SELECT SUM(CASE WHEN account_type='gmail_source' AND is_active=1 THEN 1 ELSE 0 END) gmail, SUM(CASE WHEN account_type='drive_storage' AND is_active=1 THEN 1 ELSE 0 END) drive FROM google_accounts`).first();
  const last = await env.DB.prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1`).first();
  return json({ documents: docs?.n || 0, needs_review: docs?.review || 0, gmail_accounts: accounts?.gmail || 0, drive_connected: (accounts?.drive || 0) > 0, last_sync: last || null });
}

async function getSettings(env) {
  const rs = await env.DB.prepare('SELECT key,value FROM settings').all();
  const out = Object.fromEntries((rs.results || []).map(r => [r.key, r.value]));
  if (!out.gmail_query) out.gmail_query = DEFAULT_QUERY;
  return json(out);
}

async function saveSettings(request, env) {
  const body = await request.json();
  if (typeof body.gmail_query === 'string') await setSetting(env, 'gmail_query', body.gmail_query.trim() || DEFAULT_QUERY);
  return getSettings(env);
}

async function setSetting(env, key, value) {
  await env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(key, value).run();
}

async function syncOne(request, env) {
  const body = await request.json();
  const accountId = Number(body.account_id);
  const daysBack = Math.max(1, Math.min(Number(body.days_back || 30), 1460));
  const result = await syncAccount(env, accountId, daysBack);
  return json(result);
}

async function syncAll(env, daysBack) {
  return json(await syncAllInternal(env, daysBack));
}

async function syncAllInternal(env, daysBack) {
  const rs = await env.DB.prepare(`SELECT id FROM google_accounts WHERE account_type='gmail_source' AND is_active=1 ORDER BY id`).all();
  const results = [];
  for (const row of rs.results || []) {
    try { results.push(await syncAccount(env, row.id, daysBack)); }
    catch (e) { results.push({ account_id: row.id, error: e.message }); }
  }
  return { ok: true, results };
}

async function syncAccount(env, accountId, daysBack) {
  const account = await env.DB.prepare(`SELECT * FROM google_accounts WHERE id=? AND account_type='gmail_source' AND is_active=1`).bind(accountId).first();
  if (!account) throw new Error('Gmail account not found');

  const driveAccount = await env.DB.prepare(`SELECT * FROM google_accounts WHERE account_type='drive_storage' AND is_active=1 ORDER BY id DESC LIMIT 1`).first();
  if (!driveAccount) throw new Error('กรุณาเชื่อม Google Drive กลางก่อน Sync');

  const run = await env.DB.prepare(`INSERT INTO sync_runs(account_id) VALUES(?) RETURNING id`).bind(accountId).first();
  const runId = run.id;
  let scanned=0, added=0, dup=0, errors=0;

  try {
    const gmailToken = await refreshAccessToken(env, account.refresh_token_enc);
    const driveToken = await refreshAccessToken(env, driveAccount.refresh_token_enc);
    const settings = await settingsMap(env);
    const baseQuery = settings.gmail_query || DEFAULT_QUERY;
    const since = account.last_sync_at ? new Date(account.last_sync_at) : new Date(Date.now() - daysBack*86400000);
    // Gmail's after: query is day-granular. Subtract one day to avoid boundary misses; DB uniqueness prevents duplicates.
    since.setUTCDate(since.getUTCDate()-1);
    const after = `${since.getUTCFullYear()}/${String(since.getUTCMonth()+1).padStart(2,'0')}/${String(since.getUTCDate()).padStart(2,'0')}`;
    const query = `after:${after} ${baseQuery}`;

    let pageToken = null;
    do {
      const qs = new URLSearchParams({ q: query, maxResults: '100' });
      if (pageToken) qs.set('pageToken', pageToken);
      const list = await googleJson(`${GMAIL_API}/users/me/messages?${qs}`, gmailToken);
      for (const stub of list.messages || []) {
        scanned++;
        try {
          const msg = await googleJson(`${GMAIL_API}/users/me/messages/${stub.id}?format=full`, gmailToken);
          const meta = messageMeta(msg);
          const attachments = collectAttachments(msg.payload);
          for (const att of attachments) {
            if (!isInvoiceLike(att.filename, att.mimeType, meta.subject)) continue;
            const exists = await env.DB.prepare(`SELECT id FROM documents WHERE source_account_id=? AND gmail_message_id=? AND gmail_attachment_id=?`).bind(accountId,msg.id,att.attachmentId).first();
            if (exists) { dup++; continue; }

            const raw = await googleJson(`${GMAIL_API}/users/me/messages/${msg.id}/attachments/${att.attachmentId}`, gmailToken);
            const bytes = base64UrlToBytes(raw.data || '');
            const sha = await sha256Hex(bytes);
            const hashExists = await env.DB.prepare('SELECT id FROM documents WHERE sha256=?').bind(sha).first();
            if (hashExists) { dup++; continue; }

            const vendor = inferVendor(meta.sender);
            const received = meta.date ? new Date(meta.date) : new Date(Number(msg.internalDate || Date.now()));
            const yyyy = received.getFullYear();
            const ym = `${yyyy}-${String(received.getMonth()+1).padStart(2,'0')}`;
            const folderId = await ensureDrivePath(env, driveToken, [String(yyyy), ym, safeName(vendor || 'Other')]);
            const driveName = `${received.toISOString().slice(0,10)}_${safeName(vendor || 'Other')}_${safeName(att.filename)}`.slice(0,180);
            const driveFile = await uploadDriveFile(driveToken, folderId, driveName, att.mimeType || 'application/octet-stream', bytes);

            await env.DB.prepare(`
              INSERT INTO documents(source_account_id,gmail_message_id,gmail_thread_id,gmail_attachment_id,subject,sender,received_at,filename,mime_type,size_bytes,sha256,vendor,drive_file_id,drive_web_view_link,drive_path)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            `).bind(accountId,msg.id,msg.threadId,att.attachmentId,meta.subject,meta.sender,received.toISOString(),att.filename,att.mimeType,bytes.byteLength,sha,vendor,driveFile.id,driveFile.webViewLink || null,`${yyyy}/${ym}/${safeName(vendor || 'Other')}`).run();
            added++;
          }
        } catch (e) {
          errors++; console.error('message sync error', account.email, stub.id, e);
        }
      }
      pageToken = list.nextPageToken || null;
    } while (pageToken);

    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE google_accounts SET last_sync_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(now, accountId).run();
    await env.DB.prepare(`UPDATE sync_runs SET finished_at=CURRENT_TIMESTAMP,status='success',messages_scanned=?,documents_added=?,duplicates_skipped=?,errors=? WHERE id=?`).bind(scanned,added,dup,errors,runId).run();
    return { account_id: accountId, email: account.email, scanned, added, duplicates_skipped: dup, errors };
  } catch (e) {
    await env.DB.prepare(`UPDATE sync_runs SET finished_at=CURRENT_TIMESTAMP,status='failed',messages_scanned=?,documents_added=?,duplicates_skipped=?,errors=?,error_message=? WHERE id=?`).bind(scanned,added,dup,errors+1,String(e.message).slice(0,1000),runId).run();
    throw e;
  }
}

function messageMeta(msg) {
  const h = Object.fromEntries((msg.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
  return { subject: h.subject || '', sender: h.from || '', date: h.date || null };
}

function collectAttachments(part, out=[]) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, size: part.body.size || 0 });
  for (const child of part.parts || []) collectAttachments(child, out);
  return out;
}

function isInvoiceLike(filename, mime, subject) {
  const s = `${filename} ${subject}`.toLowerCase();
  if ((mime || '').toLowerCase() === 'application/pdf') return true;
  return /(invoice|receipt|tax|billing|ใบเสร็จ|ใบกำกับ|แจ้งหนี้)/i.test(s);
}

function inferVendor(from) {
  const m = String(from || '').match(/^\s*"?([^"<]+)"?\s*</);
  if (m && m[1].trim() && !m[1].includes('@')) return m[1].trim().slice(0,80);
  const email = String(from || '').match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (!email) return 'Unknown';
  const domain = email[1].replace(/^mail\./,'').replace(/^no-reply\./,'');
  return domain.split('.')[0].replace(/[-_]/g,' ').replace(/\b\w/g,c=>c.toUpperCase()).slice(0,80);
}

async function ensureDrivePath(env, accessToken, segments) {
  let parent = (await env.DB.prepare(`SELECT value FROM settings WHERE key='root_drive_folder_id'`).first())?.value;
  if (!parent) throw new Error('Drive root folder missing. Reconnect Drive storage.');
  let path = '';
  for (const seg of segments) {
    path += '/' + seg;
    let row = await env.DB.prepare('SELECT drive_folder_id FROM drive_folders WHERE path=?').bind(path).first();
    if (!row) {
      const folder = await createDriveFolder(accessToken, seg, parent);
      await env.DB.prepare('INSERT OR REPLACE INTO drive_folders(path,drive_folder_id) VALUES(?,?)').bind(path,folder.id).run();
      row = { drive_folder_id: folder.id };
    }
    parent = row.drive_folder_id;
  }
  return parent;
}

async function createDriveFolder(accessToken, name, parentId=null) {
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const r = await fetch(`${DRIVE_API}/files?fields=id,name,webViewLink`, {
    method:'POST', headers:{Authorization:`Bearer ${accessToken}`,'content-type':'application/json'}, body:JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Drive folder create failed: ${JSON.stringify(data)}`);
  return data;
}

async function uploadDriveFile(accessToken, folderId, name, mimeType, bytes) {
  const boundary = '----invoicehub' + crypto.randomUUID().replace(/-/g,'');
  const meta = JSON.stringify({ name, parents:[folderId] });
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head,0); body.set(bytes,head.length); body.set(tail,head.length+bytes.length);
  const r = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method:'POST', headers:{Authorization:`Bearer ${accessToken}`,'content-type':`multipart/related; boundary=${boundary}`}, body
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Drive upload failed: ${JSON.stringify(data)}`);
  return data;
}

async function refreshAccessToken(env, refreshTokenEnc) {
  requireSecrets(env);
  const refreshToken = await decryptSecret(refreshTokenEnc, env.TOKEN_ENCRYPTION_KEY);
  const r = await fetch(GOOGLE_TOKEN, {
    method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:refreshToken,grant_type:'refresh_token'})
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Refresh token failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function googleJson(url, accessToken) {
  const r = await fetch(url,{headers:{Authorization:`Bearer ${accessToken}`}});
  const data = await r.json();
  if (!r.ok) throw new Error(`Google API ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

async function settingsMap(env) {
  const rs = await env.DB.prepare('SELECT key,value FROM settings').all();
  return Object.fromEntries((rs.results || []).map(r=>[r.key,r.value]));
}

async function updateDocument(request, env) {
  const id = Number(new URL(request.url).pathname.split('/').pop());
  const b = await request.json();
  const allowedStatus = ['needs_review','reviewed','sent_to_accounting','ignored'];
  const status = allowedStatus.includes(b.status) ? b.status : 'needs_review';
  await env.DB.prepare(`UPDATE documents SET vendor=?,invoice_number=?,document_date=?,amount=?,currency=?,vat_amount=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(b.vendor || null,b.invoice_number || null,b.document_date || null,numOrNull(b.amount),b.currency || null,numOrNull(b.vat_amount),status,id).run();
  return json({ok:true});
}

async function disableAccount(request, env) {
  const id = Number(new URL(request.url).pathname.split('/').pop());
  await env.DB.prepare('UPDATE google_accounts SET is_active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(id).run();
  return json({ok:true});
}

function numOrNull(x){ const n=Number(x); return x===''||x==null||!Number.isFinite(n)?null:n; }
function safeName(s){ return String(s||'Unknown').replace(/[\\/:*?"<>|\x00-\x1F]/g,' ').replace(/\s+/g,' ').trim().slice(0,80) || 'Unknown'; }
function base64UrlToBytes(s){ s=s.replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4)s+='='; const bin=atob(s); return Uint8Array.from(bin,c=>c.charCodeAt(0)); }
async function sha256Hex(bytes){ const h=await crypto.subtle.digest('SHA-256',bytes); return [...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join(''); }

function requireSecrets(env){
  for(const k of ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','TOKEN_ENCRYPTION_KEY','BASE_URL']) if(!env[k]) throw new Error(`Missing ${k}`);
}
async function aesKey(secret){ return crypto.subtle.importKey('raw',new TextEncoder().encode(secret.padEnd(32,'0').slice(0,32)),{name:'AES-GCM'},false,['encrypt','decrypt']); }
async function encryptSecret(text, secret){ const iv=crypto.getRandomValues(new Uint8Array(12)); const key=await aesKey(secret); const enc=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(text))); return btoa(String.fromCharCode(...iv,...enc)); }
async function decryptSecret(blob, secret){ const raw=Uint8Array.from(atob(blob),c=>c.charCodeAt(0)); const iv=raw.slice(0,12), enc=raw.slice(12); const key=await aesKey(secret); const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,enc); return new TextDecoder().decode(dec); }

function json(data,status=200){ return new Response(JSON.stringify(data,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}}); }
function html(body,status=200){ return new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}}); }
function messagePage(title, detail, autoClose=false){ return `<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;background:#f7f7f4;padding:48px;color:#171717}.card{max-width:560px;margin:auto;background:#fff;padding:32px;border-radius:20px;border:1px solid #e5e5df}a{color:#04878a}</style><div class="card"><h2>${esc(title)}</h2><p>${esc(detail)}</p><p><a href="/">กลับ Dashboard</a></p></div>${autoClose?'<script>setTimeout(()=>location.href="/",1200)</script>':''}`; }
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

function dashboardHtml(){ return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DEAL Invoice Hub</title>
<style>
:root{--bg:#f6f6f2;--card:#fff;--ink:#171717;--muted:#73736e;--line:#e6e6df;--brand:#04878a;--soft:#e8f5f4}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,"IBM Plex Sans Thai",system-ui,sans-serif}.wrap{max-width:1260px;margin:auto;padding:26px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:24px}.title h1{font-size:28px;margin:0 0 5px}.title p{margin:0;color:var(--muted)}button,.btn{border:0;border-radius:12px;padding:11px 15px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}.primary{background:var(--brand);color:#fff}.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stat,.card{background:var(--card);border:1px solid var(--line);border-radius:18px}.stat{padding:18px}.stat b{font-size:29px;display:block;margin-top:6px}.muted{color:var(--muted)}.layout{display:grid;grid-template-columns:330px 1fr;gap:14px;margin-top:14px}.card{padding:18px}.card h3{margin:0 0 14px}.account{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:12px 0}.account:first-of-type{border-top:0}.dot{width:9px;height:9px;border-radius:99px;background:var(--brand);display:inline-block;margin-right:8px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}input,select{border:1px solid var(--line);background:#fff;border-radius:11px;padding:11px 12px;font:inherit}input[type=text]{flex:1;min-width:220px}.tableWrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;color:var(--muted);font-weight:600;padding:11px 9px;border-bottom:1px solid var(--line);white-space:nowrap}td{padding:12px 9px;border-bottom:1px solid var(--line);vertical-align:top}.pill{display:inline-block;background:#f0f0ea;padding:5px 8px;border-radius:99px;font-size:12px}.review{background:#fff1cf}.ok{background:var(--soft);color:#046d6f}.empty{padding:40px;text-align:center;color:var(--muted)}dialog{border:0;border-radius:18px;padding:0;max-width:560px;width:calc(100% - 30px);box-shadow:0 22px 70px #0003}dialog::backdrop{background:#0005}.modal{padding:22px}.modal label{display:block;font-size:12px;color:var(--muted);margin:12px 0 5px}.modal input,.modal select{width:100%}.row{display:flex;gap:8px}.row>*{flex:1}@media(max-width:900px){.grid{grid-template-columns:1fr 1fr}.layout{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}}@media(max-width:540px){.wrap{padding:14px}.grid{grid-template-columns:1fr 1fr}.stat b{font-size:24px}.topActions{display:flex;gap:6px;flex-wrap:wrap}}
</style></head><body><div class="wrap">
<div class="top"><div class="title"><h1>Invoice Hub</h1><p>รวมใบแจ้งหนี้และใบเสร็จจากทุก Gmail ไว้ที่เดียว</p></div><div class="topActions"><a class="btn secondary" href="/auth/drive/start">เชื่อม Drive กลาง</a><a class="btn primary" href="/auth/gmail/start">+ เชื่อม Gmail</a></div></div>
<div class="grid"><div class="stat"><span class="muted">Gmail ที่เชื่อม</span><b id="sAccounts">-</b></div><div class="stat"><span class="muted">เอกสารทั้งหมด</span><b id="sDocs">-</b></div><div class="stat"><span class="muted">รอตรวจสอบ</span><b id="sReview">-</b></div><div class="stat"><span class="muted">Drive กลาง</span><b id="sDrive">-</b></div></div>
<div class="layout"><div><div class="card"><h3>บัญชีที่เชื่อม</h3><div id="accounts"></div><a class="btn primary" style="width:100%;margin-top:10px" href="/auth/gmail/start">+ เพิ่ม Gmail อีกบัญชี</a></div><div class="card" style="margin-top:14px"><h3>การ Sync</h3><div class="muted" style="font-size:13px;margin-bottom:10px">รอบอัตโนมัติทุก 30 นาที และสแกนย้อนหลังเผื่อ 1 วันเพื่อกันเมลตกหล่น</div><button class="primary" style="width:100%" onclick="syncAll()" id="syncBtn">Sync ทุก Gmail ตอนนี้</button><div id="syncMsg" class="muted" style="font-size:12px;margin-top:9px"></div></div></div>
<div class="card"><div class="toolbar"><input id="search" type="text" placeholder="ค้นหา Vendor, Invoice, ชื่อไฟล์, ผู้ส่ง..." oninput="loadDocs()"><select id="status" onchange="loadDocs()"><option value="">ทุกสถานะ</option><option value="needs_review">รอตรวจ</option><option value="reviewed">ตรวจแล้ว</option><option value="sent_to_accounting">ส่งบัญชีแล้ว</option><option value="ignored">ไม่นับ</option></select></div><div class="tableWrap"><table><thead><tr><th>วันที่</th><th>Vendor / เอกสาร</th><th>Gmail ต้นทาง</th><th>ยอด</th><th>สถานะ</th><th></th></tr></thead><tbody id="docs"></tbody></table></div></div></div>
</div>
<dialog id="editDialog"><div class="modal"><h3 style="margin-top:0">ตรวจเอกสาร</h3><input type="hidden" id="eId"><label>Vendor</label><input id="eVendor"><label>Invoice No.</label><input id="eInvoice"><div class="row"><div><label>วันที่เอกสาร</label><input id="eDate" type="date"></div><div><label>สกุลเงิน</label><input id="eCurrency" placeholder="THB"></div></div><div class="row"><div><label>ยอดรวม</label><input id="eAmount" type="number" step="0.01"></div><div><label>VAT</label><input id="eVat" type="number" step="0.01"></div></div><label>สถานะ</label><select id="eStatus"><option value="needs_review">รอตรวจ</option><option value="reviewed">ตรวจแล้ว</option><option value="sent_to_accounting">ส่งบัญชีแล้ว</option><option value="ignored">ไม่นับ</option></select><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px"><button class="secondary" onclick="editDialog.close()">ยกเลิก</button><button class="primary" onclick="saveDoc()">บันทึก</button></div></div></dialog>
<script>
let docsCache=[];
async function j(url,opt){const r=await fetch(url,opt);const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d}
async function load(){const [s,a]=await Promise.all([j('/api/stats'),j('/api/accounts')]);sAccounts.textContent=s.gmail_accounts;sDocs.textContent=s.documents;sReview.textContent=s.needs_review;sDrive.textContent=s.drive_connected?'พร้อม':'ยังไม่เชื่อม';accounts.innerHTML=a.filter(x=>x.account_type==='gmail_source'&&x.is_active).map(x=>'<div class="account"><div><span class="dot"></span><b>'+h(x.email)+'</b><div class="muted" style="font-size:12px;margin-left:17px">'+(x.last_sync_at?'Sync '+new Date(x.last_sync_at).toLocaleString('th-TH'):'ยังไม่เคย Sync')+'</div></div><button class="secondary" onclick="syncOne('+x.id+')">Sync</button></div>').join('')||'<div class="empty">ยังไม่มี Gmail</div>';loadDocs()}
async function loadDocs(){const q=encodeURIComponent(search.value||''),st=encodeURIComponent(status.value||'');docsCache=await j('/api/documents?q='+q+'&status='+st);docs.innerHTML=docsCache.map(d=>'<tr><td>'+fmtDate(d.received_at)+'</td><td><b>'+h(d.vendor||'ยังไม่ระบุ')+'</b><div class="muted">'+h(d.filename)+'</div><div class="muted">'+h((d.subject||'').slice(0,80))+'</div></td><td>'+h(d.source_email)+'</td><td>'+(d.amount!=null?Number(d.amount).toLocaleString()+' '+h(d.currency||''):'-')+'</td><td>'+pill(d.status)+'</td><td>'+(d.drive_web_view_link?'<a class="btn secondary" target="_blank" href="'+h(d.drive_web_view_link)+'">เปิด</a> ':'')+'<button class="secondary" onclick="edit('+d.id+')">ตรวจ</button></td></tr>').join('')||'<tr><td colspan="6" class="empty">ยังไม่มีเอกสาร</td></tr>'}
async function syncOne(id){syncMsg.textContent='กำลัง Sync...';try{const r=await j('/api/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account_id:id,days_back:30})});syncMsg.textContent='เสร็จ: เจอ '+r.added+' เอกสารใหม่ / ข้ามซ้ำ '+r.duplicates_skipped;await load()}catch(e){syncMsg.textContent='ผิดพลาด: '+e.message}}
async function syncAll(){syncBtn.disabled=true;syncMsg.textContent='กำลัง Sync ทุกบัญชี...';try{const r=await j('/api/sync-all',{method:'POST'});const n=r.results.reduce((s,x)=>s+(x.added||0),0);syncMsg.textContent='เสร็จ: เพิ่ม '+n+' เอกสารใหม่';await load()}catch(e){syncMsg.textContent='ผิดพลาด: '+e.message}finally{syncBtn.disabled=false}}
function edit(id){const d=docsCache.find(x=>x.id===id);eId.value=d.id;eVendor.value=d.vendor||'';eInvoice.value=d.invoice_number||'';eDate.value=d.document_date||'';eAmount.value=d.amount??'';eVat.value=d.vat_amount??'';eCurrency.value=d.currency||'THB';eStatus.value=d.status;editDialog.showModal()}
async function saveDoc(){await j('/api/documents/'+eId.value,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({vendor:eVendor.value,invoice_number:eInvoice.value,document_date:eDate.value,amount:eAmount.value,vat_amount:eVat.value,currency:eCurrency.value,status:eStatus.value})});editDialog.close();load()}
function pill(s){const m={needs_review:['รอตรวจ','review'],reviewed:['ตรวจแล้ว','ok'],sent_to_accounting:['ส่งบัญชีแล้ว','ok'],ignored:['ไม่นับ','']};const x=m[s]||[s,''];return '<span class="pill '+x[1]+'">'+x[0]+'</span>'}
function fmtDate(x){return x?new Date(x).toLocaleDateString('th-TH',{day:'2-digit',month:'short',year:'2-digit'}):'-'}
function h(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
load();
</script></body></html>`; }
