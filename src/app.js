import { Hono } from 'hono';
import { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createClient } from '@libsql/client';
import { put } from '@vercel/blob';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';


const app = new Hono();

// ============ B2 client cache (per b2_group) ============

const _s3Clients = {};

function normalizeB2Group(b2Group) {
  const n = Number(b2Group);
  return n === 1 || n === 2 ? n : 0;
}

function s3(b2Group = 0) {
  const t = normalizeB2Group(b2Group);
  if (_s3Clients[t]) return _s3Clients[t];

  let endpoint = process.env.B2_ENDPOINT_URL;
  if (!endpoint) throw new Error('B2_ENDPOINT_URL is not set');
  endpoint = endpoint.replace(/\/+$/, '');
  const region = new URL(endpoint).hostname.split('.')[1];

  let accessKeyId, secretAccessKey;
  if (t === 1) {
    accessKeyId = process.env.B2_APPLICATION_KEY_ID_ONE ?? process.env.B2_APPLICATION_KEY_ID;
    secretAccessKey = process.env.B2_APPLICATION_KEY_ONE ?? process.env.B2_APPLICATION_KEY;
  } else if (t === 2) {
    accessKeyId = process.env.B2_APPLICATION_KEY_ID_TWO ?? process.env.B2_APPLICATION_KEY_ID;
    secretAccessKey = process.env.B2_APPLICATION_KEY_TWO ?? process.env.B2_APPLICATION_KEY;
  } else {
    accessKeyId = process.env.B2_APPLICATION_KEY_ID;
    secretAccessKey = process.env.B2_APPLICATION_KEY;
  }

  _s3Clients[t] = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    // Disable checksum modes that B2 doesn't support
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId, secretAccessKey },
  });
  return _s3Clients[t];
}

function getBucketForGroup(b2Group) {
  switch (normalizeB2Group(b2Group)) {
    case 1: return process.env.B2_BUCKET_NAME_ONE;
    case 2: return process.env.B2_BUCKET_NAME_TWO;
    case 0:
    default: return process.env.B2_BUCKET_NAME;
  }
}

// ============ Turso ============

let _turso;

function turso() {
  if (!_turso) {
    _turso = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _turso;
}

// ============ Vercel Blob ============

let _blob;

function blob() {
  if (!_blob) {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
    _blob = {
      put: (pathname, body, opts = {}) => put(pathname, body, { ...opts, token }),
    };
  }
  return _blob;
}

// ============ Middleware ============

app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  c.header('Cache-Control', 'no-store');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

app.use('/api/*', async (c, next) => {
  const expected = process.env.API_PASSWORD;
  if (!expected) {
    return c.json({ success: false, error: 'Server misconfigured: API_PASSWORD not set' }, 500);
  }
  const provided = c.req.header('X-API-Key') || '';
  if (provided !== expected) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  await next();
});

// ============ Debug config ============

app.get('/api/config', async (c) => {
  const pick = (name) => process.env[name] ?? null;
  const redact = (name) => (process.env[name] ? '***set***' : null);

  const endpointInfo = (urlStr) => {
    if (!urlStr) return { endpointUrl: null, region: null, host: null };
    try {
      const u = new URL(urlStr);
      return {
        endpointUrl: urlStr,
        region: u.hostname.split('.')[1] || null,
        host: u.hostname,
      };
    } catch {
      return { endpointUrl: urlStr, region: null, host: null };
    }
  };

  const group = (suffix) => {
    const ep = pick(`B2_ENDPOINT_URL${suffix}`);
    const info = endpointInfo(ep);
    return {
      [`B2_ENDPOINT_URL${suffix}`]:        info.endpointUrl,
      [`B2_REGION${suffix}`]:              info.region,
      [`B2_HOST${suffix}`]:                info.host,
      [`B2_BUCKET_NAME${suffix}`]:         pick(`B2_BUCKET_NAME${suffix}`),
      [`B2_APPLICATION_KEY_ID${suffix}`]:  pick(`B2_APPLICATION_KEY_ID${suffix}`),
      [`B2_APPLICATION_KEY${suffix}`]:     redact(`B2_APPLICATION_KEY${suffix}`),
    };
  };

  let tursoHost = null;
  try {
    tursoHost = new URL(process.env.TURSO_DATABASE_URL).host;
  } catch {}

  return c.json({
    success: true,
    warning: 'DEBUG CONFIG — reveals B2 key IDs + buckets. API keys are redacted. Remove + rotate after debugging.',

    config: {
      // ── Group 0 (default) ──────────────────────────
      ...group(''),

      // ── Group 1 ────────────────────────────────────
      ...group('_ONE'),

      // ── Group 2 ────────────────────────────────────
      ...group('_TWO'),

      // ── Turso ──────────────────────────────────────
      TURSO_DATABASE_URL_HOST: tursoHost,
      TURSO_AUTH_TOKEN:        redact('TURSO_AUTH_TOKEN'),

      // ── Deployment ─────────────────────────────────
      VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null,
      VERCEL_ENV:            process.env.VERCEL_ENV || null,
      NODE_ENV:              process.env.NODE_ENV || null,
    },
  });
});

// ── Backblaze B2 account info ─────────────────────────────
// Calls the native b2_authorize_account endpoint and returns
// only the account info (never the authorizationToken).
// Optional ?group=0|1|2 to inspect a specific key.
app.get('/api/b2/account-info', async (c) => {
  try {
    const groupParam = normalizeB2Group(c.req.query('group'));
    let keyId, appKey;
    if (groupParam === 1) {
      keyId = process.env.B2_APPLICATION_KEY_ID_ONE ?? process.env.B2_APPLICATION_KEY_ID;
      appKey = process.env.B2_APPLICATION_KEY_ONE ?? process.env.B2_APPLICATION_KEY;
    } else if (groupParam === 2) {
      keyId = process.env.B2_APPLICATION_KEY_ID_TWO ?? process.env.B2_APPLICATION_KEY_ID;
      appKey = process.env.B2_APPLICATION_KEY_TWO ?? process.env.B2_APPLICATION_KEY;
    } else {
      keyId = process.env.B2_APPLICATION_KEY_ID;
      appKey = process.env.B2_APPLICATION_KEY;
    }
    if (!keyId || !appKey) {
      return c.json({ ok: false, error: `B2 key for group ${groupParam} not set` }, 500);
    }

    const basic = Buffer.from(`${keyId}:${appKey}`).toString('base64');

    // v2 is the most widely deployed version.
    const res = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
      headers: { Authorization: `Basic ${basic}` },
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      return c.json({
        ok: false,
        status: res.status,
        error: body.message || body.code || 'authorization failed',
      }, 502);
    }

    // B2 has returned two shapes over time:
    //   Flat:  { accountId, apiUrl, downloadUrl, allowed: {...} }
    //   Nested: { accountId, apiInfo: { storageApi: { apiUrl, capabilities, ... } } }
    // Normalize both to one flat shape for the browser.
    const s = body.apiInfo?.storageApi || {};
    const allowed = s.capabilities ? s : body.allowed || {};

    return c.json({
      ok: true,
      group: groupParam,
      accountId: body.accountId,
      apiUrl: body.apiUrl || s.apiUrl,
      downloadUrl: body.downloadUrl || s.downloadUrl,
      s3ApiUrl: body.s3ApiUrl || s.s3ApiUrl,
      capabilities: allowed.capabilities || body.allowed?.capabilities || [],
      bucketId: allowed.bucketId || body.allowed?.bucketId || null,
      bucketName: allowed.bucketName || body.allowed?.bucketName || null,
      namePrefix: allowed.namePrefix || body.allowed?.namePrefix || null,
      recommendedPartSize: body.recommendedPartSize || s.recommendedPartSize || null,
      absoluteMinimumPartSize:
        body.absoluteMinimumPartSize || s.absoluteMinimumPartSize || null,
    });
  } catch (e) {
    return c.json({ ok: false, error: `${e.name}: ${e.message}` }, 502);
  }
});

// ============ Static HTML ============

app.get('/', async (c) => {
  try {
    const html = await readFile(join(process.cwd(), 'public/index.html'), 'utf-8');
    return c.html(html);
  } catch {
    return c.text('index.html not found', 500);
  }
});

app.get('/files', async (c) => {
  const html = await readFile(join(process.cwd(), 'public/files.html'), 'utf-8');
  return c.html(html);
});

app.get('/play', async (c) => {
  const html = await readFile(join(process.cwd(), 'public/play.html'), 'utf-8');
  return c.html(html);
});

app.get('/health', async (c) => {
  const html = await readFile(join(process.cwd(), 'public/health.html'), 'utf-8');
  return c.html(html);
});

app.get('/docs', async (c) => {
  const html = await readFile(join(process.cwd(), 'public/docs.html'), 'utf-8');
  return c.html(html);
});

app.get('/account', async (c) => {
  const html = await readFile(join(process.cwd(), 'public/account.html'), 'utf-8');
  return c.html(html);
});

app.get('/config', async (c) => {
  const html = await readFile(join(process.cwd(), 'public/config.html'), 'utf-8');
  return c.html(html);
});

app.get('/debug/files', async (c) => {
  const { readdir } = await import('fs/promises');
  try {
    const cwd = process.cwd();
    const root = await readdir(cwd);
    let publicDir = null;
    try {
      publicDir = await readdir(join(cwd, 'public'));
    } catch (e) {
      publicDir = `error: ${e.message}`;
    }
    return c.json({ cwd, root, public: publicDir });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// ============ Upload from URL ============

const ALLOWED_HOSTS = /(^|\.)(tiktokv|tiktokcdn|byteoversea|ibytedtos|muscdn|tos-)\.com$/i;
const MAX_BYTES = 350 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 90_000;

async function uploadImageFromUrl(client, imageUrl, bucket) {
  if (!imageUrl) return null;

  let parsed;
  try { parsed = new URL(imageUrl); } catch { return null; }
  if (!/^https?:$/.test(parsed.protocol)) return null;
  if (!ALLOWED_HOSTS.test(parsed.hostname)) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);

  try {
    const upstream = await fetch(imageUrl, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' },
    });
    clearTimeout(timer);

    if (!upstream.ok) return null;

    const contentType = upstream.headers.get('content-type') || '';
    if (contentType && !/^image\//i.test(contentType)) return null;

    const ext = (contentType.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5);
    const coverKey = `cover_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const imageUpload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: coverKey,
        Body: upstream.body,
        ContentType: contentType || 'image/jpeg',
      },
    });

    await imageUpload.done();
    return coverKey;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

app.post('/api/upload-from-url', async (c) => {
  try {
    const db = turso();

    const { url, userId, date, likes, coverImg, b2Group } = await c.req.json();
    if (!url) throw new Error('url required');

    const resolvedB2Group = normalizeB2Group(b2Group);
    const client = s3(resolvedB2Group);
    const bucket = getBucketForGroup(resolvedB2Group);

    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('only http(s) URLs');
    if (!ALLOWED_HOSTS.test(parsed.hostname)) throw new Error('host not allowed: ' + parsed.hostname);

    const dateStr = date
      ? String(date).replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40)
      : Date.now().toString();
    const filename = `video_${dateStr}.mp4`;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(url, {
        signal: ctl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' },
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e.name === 'AbortError';
      return c.json({ success: false, error: aborted ? 'upstream timeout' : 'upstream fetch failed' }, 502);
    }

    if (!upstream.ok) {
      clearTimeout(timer);

      let coverKey = null;
      try {
        coverKey = await uploadImageFromUrl(client, coverImg, bucket);
      } catch (e) {
        console.error('Cover upload failed:', e.message);
      }

      const failedUserId = String(userId || 'user_123').trim().slice(0, 100) || 'user_123';
      const failedLikes = Number.isInteger(likes) && likes >= 0 ? likes : 0;

      let failedId = null;
      try {
        const ins = await db.execute({
          sql: `INSERT INTO failed_uploads
                  (video_url, cover_key, user_id, date, likes, error)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [url, coverKey, failedUserId, date || null, failedLikes, `upstream HTTP ${upstream.status}`],
        });
        failedId = ins.lastInsertRowid ?? null;
      } catch (e) {
        console.error('failed_uploads insert failed:', e.message);
      }

      return c.json({
        success: false,
        error: `upstream HTTP ${upstream.status}`,
        coverKey: coverKey || null,
        failedId,
      }, 502);
    }

    const contentLength = Number(upstream.headers.get('content-length')) || 0;
    if (contentLength && contentLength > MAX_BYTES) {
      clearTimeout(timer);
      try { await upstream.body?.cancel(); } catch {}
      return c.json({ success: false, error: 'file too large' }, 413);
    }

    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: filename,
        Body: upstream.body,
        ContentType: 'video/mp4',
        ContentLength: contentLength || undefined,
      },
    });

    await upload.done();
    clearTimeout(timer);

    const coverKey = await uploadImageFromUrl(client, coverImg, bucket);

    const resolvedUserId = String(userId || 'user_123').trim().slice(0, 100) || 'user_123';

    const parsedDate = date ? new Date(String(date).replace(' ', 'T')) : new Date();
    const postedDate = (isNaN(parsedDate.getTime()) ? new Date() : parsedDate)
      .toISOString()
      .slice(0, 10);

    const initialLikes = Number.isInteger(likes) && likes >= 0 ? likes : 0;

    await db.execute({
      sql: `INSERT INTO b2_files
              (video_key, cover_key, user_id, likes, posted_date, file_size, b2_group)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [filename, coverKey, resolvedUserId, initialLikes, postedDate, contentLength || null, resolvedB2Group],
    });

    return c.json({
      success: true,
      videoKey: filename,
      coverKey: coverKey || null,
      bytes: contentLength || null,
      b2Group: resolvedB2Group,
    });
  } catch (error) {
    console.error('Upload Error:', error.message);
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/download-b2-proxy', async (c) => {
  try {
    const db = turso();
    const videoKey = c.req.query('videoKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!videoKey) return c.json({ success: false, error: 'videoKey required' }, 400);

    const check = await db.execute({
      sql: `SELECT video_key, b2_group FROM b2_files WHERE video_key = ? AND user_id = ?`,
      args: [videoKey, userId],
    });
    if (check.rows.length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    const b2Group = check.rows[0].b2_group;
    const client = s3(b2Group);
    const bucket = getBucketForGroup(b2Group);

    // Stream the object straight from B2 through the server
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: videoKey }));

    const headers = new Headers();
    headers.set('Content-Type', obj.ContentType || 'video/mp4');
    if (obj.ContentLength) headers.set('Content-Length', String(obj.ContentLength));
    headers.set('Content-Disposition', `attachment; filename="${videoKey}"`);
    headers.set('Cache-Control', 'private, max-age=0, no-store');

    return new Response(obj.Body, { status: 200, headers });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});
// ============ Download (signed URL) ============

app.get('/api/download-b2-file', async (c) => {
  try {
    const db = turso();

    const videoKey = c.req.query('videoKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!videoKey) throw new Error('videoKey required');

    const check = await db.execute({
      sql: `SELECT video_key, b2_group FROM b2_files
            WHERE video_key = ? AND user_id = ?`,
      args: [videoKey, userId],
    });
    if (check.rows.length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    const b2Group = check.rows[0].b2_group;
    const client = s3(b2Group);
    const bucket = getBucketForGroup(b2Group);

    const disposition = c.req.query('disposition') || 'inline';

    const command = {
      Bucket: bucket,
      Key: videoKey,
    };

    if (disposition === 'attachment') {
      const filename = `${userId}_${videoKey}`;
      const encoded = encodeURIComponent(filename);
      command.ResponseContentDisposition =
        `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
    }

    const downloadUrl = await getSignedUrl(client, new GetObjectCommand(command), { expiresIn: 259200 });

    return c.json({ success: true, downloadUrl });

  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/download-b2-cover', async (c) => {
  try {
    const db = turso();

    const coverKey = c.req.query('coverKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!coverKey) throw new Error('coverKey required');

    const check = await db.execute({
      sql: `SELECT cover_key, b2_group FROM b2_files
            WHERE cover_key = ? AND user_id = ?`,
      args: [coverKey, userId],
    });
    if (check.rows.length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    const b2Group = check.rows[0].b2_group;
    const client = s3(b2Group);
    const bucket = getBucketForGroup(b2Group);

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: coverKey,
    });
    const downloadUrl = await getSignedUrl(client, command, { expiresIn: 259200 });

    return c.json({ success: true, downloadUrl });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/known-video-keys', async (c) => {
  try {
    const db = turso();
    const userId = c.req.query('userId') || 'user_123';

    const rows = await db.execute({
      sql: `SELECT video_key, file_size, posted_date
            FROM b2_files
            WHERE user_id = ?
            ORDER BY posted_date DESC, id DESC`,
      args: [userId],
    });

    return c.json({
      success: true,
      items: rows.rows.map(r => ({
        videoKey: r.video_key,
        fileSize: r.file_size,
        postedDate: r.posted_date,
      })),
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ============ download_links feature (self-contained) ============

const STALE_HOURS = 48; // refresh URLs older than this; 3-day URLs get 1 day of buffer

app.post('/api/download-links/sync', async (c) => {
  try {
    const db = turso();
    const { userId, b2Group } = await c.req.json();
    const resolvedUserId = String(userId || 'user_123').trim().slice(0, 100) || 'user_123';

    // Optional filter by b2_group. If not provided, process every group the user owns.
    const hasGroupFilter = b2Group !== undefined && b2Group !== null && b2Group !== '';
    const groupFilter = hasGroupFilter ? normalizeB2Group(b2Group) : null;

    const allVideos = hasGroupFilter
      ? await db.execute({
          sql: `SELECT video_key, cover_key, file_size, b2_group
                FROM b2_files WHERE user_id = ? AND b2_group = ?`,
          args: [resolvedUserId, groupFilter],
        })
      : await db.execute({
          sql: `SELECT video_key, cover_key, file_size, b2_group
                FROM b2_files WHERE user_id = ?`,
          args: [resolvedUserId],
        });

    // Rows in download_links that are still fresh (created within STALE_HOURS)
    const fresh = await db.execute({
      sql: `SELECT video_key FROM download_links
            WHERE user_id = ?
              AND created_at > datetime('now', ?)`,
      args: [resolvedUserId, `-${STALE_HOURS} hours`],
    });
    const freshKeys = new Set(fresh.rows.map(r => r.video_key));

    // Process = anything not currently fresh (either missing entirely, or stale)
    const toProcess = allVideos.rows.filter(r => !freshKeys.has(r.video_key));
    const skipped = allVideos.rows.length - toProcess.length;

    let added = 0, refreshed = 0;
    for (const r of toProcess) {
      const client = s3(r.b2_group);
      const bucket = getBucketForGroup(r.b2_group);

      const videoCmd = new GetObjectCommand({
        Bucket: bucket,
        Key: r.video_key,
      });
      const videoUrl = await getSignedUrl(client, videoCmd, { expiresIn: 259200 });

      let coverUrl = null;
      if (r.cover_key) {
        const coverCmd = new GetObjectCommand({
          Bucket: bucket,
          Key: r.cover_key,
        });
        coverUrl = await getSignedUrl(client, coverCmd, { expiresIn: 259200 });
      }

      // Detect whether this is a first insert or a refresh by checking existence
      const exists = await db.execute({
        sql: `SELECT 1 FROM download_links WHERE video_key = ? AND user_id = ?`,
        args: [r.video_key, resolvedUserId],
      });

      await db.execute({
        sql: `INSERT INTO download_links
                (video_key, user_id, cover_key, video_url, cover_url, file_size)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT (video_key, user_id) DO UPDATE SET
                cover_key = excluded.cover_key,
                video_url = excluded.video_url,
                cover_url = excluded.cover_url,
                file_size = excluded.file_size,
                created_at = CURRENT_TIMESTAMP`,
        args: [r.video_key, resolvedUserId, r.cover_key, videoUrl, coverUrl, r.file_size],
      });

      if (exists.rows.length > 0) refreshed++;
      else added++;
    }

    return c.json({
      success: true,
      added,
      refreshed,
      skipped,
      total: allVideos.rows.length,
      staleHours: STALE_HOURS,
      b2Group: hasGroupFilter ? groupFilter : 'all',
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/download-links', async (c) => {
  try {
    const db = turso();
    const userId = c.req.query('userId') || 'user_123';

    const rows = await db.execute({
      sql: `SELECT video_key, user_id, cover_key, video_url, cover_url, file_size, created_at
            FROM download_links
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC`,
      args: [userId],
    });

    return c.json({
      success: true,
      items: rows.rows.map(r => ({
        videoKey: r.video_key,
        userId: r.user_id,
        coverKey: r.cover_key,
        videoUrl: r.video_url,
        coverUrl: r.cover_url,
        fileSize: r.file_size,
        createdAt: r.created_at,
      })),
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.delete('/api/download-links', async (c) => {
  try {
    const db = turso();
    const videoKey = c.req.query('videoKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!videoKey) throw new Error('videoKey required');

    await db.execute({
      sql: `DELETE FROM download_links WHERE video_key = ? AND user_id = ?`,
      args: [videoKey, userId],
    });

    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ============ end download_links feature ============


// ---- Row count for b2_files ----

app.get('/api/b2-files-count', async (c) => {
  try {
    const db = turso();
    const userId = c.req.query('userId');
    const b2GroupQuery = c.req.query('b2Group');

    const filters = [];
    const args = [];
    if (userId) { filters.push('user_id = ?'); args.push(userId); }
    if (b2GroupQuery !== undefined && b2GroupQuery !== '') {
      filters.push('b2_group = ?'); args.push(normalizeB2Group(b2GroupQuery));
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const result = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM b2_files ${where}`,
      args,
    });

    const count = Number(result.rows[0]?.n) || 0;
    return c.json({
      success: true,
      count,
      userId: userId || null,
      b2Group: b2GroupQuery !== undefined && b2GroupQuery !== '' ? normalizeB2Group(b2GroupQuery) : null,
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get('/api/download-links-view', async (c) => {
  try {
    const db = turso();
    const userId = c.req.query('userId') || 'user_123';

    const rows = await db.execute({
      sql: `SELECT video_key, user_id, cover_key, video_url, cover_url,
                   file_size, created_at, likes, posted_date
            FROM download_links_view
            WHERE user_id = ?
            ORDER BY likes DESC, posted_date DESC, video_key`,
      args: [userId],
    });

    return c.json({
      success: true,
      items: rows.rows.map(r => ({
        videoKey: r.video_key,
        userId: r.user_id,
        coverKey: r.cover_key,
        videoUrl: r.video_url,
        coverUrl: r.cover_url,
        fileSize: r.file_size,
        createdAt: r.created_at,
        likes: r.likes,
        postedDate: r.posted_date,
      })),
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ═════════════════════════════════════════════════════════════════
// TikTok posts — RPC-style bulk insert / update / summary reads
// ═════════════════════════════════════════════════════════════════

function rowsToObjects(result) {
  const cols = (result.columns || []).map(c => (typeof c === 'string' ? c : c.name));
  return (result.rows || []).map(row => {
    if (Array.isArray(row)) {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    }
    return row;
  });
}

function firstScalar(result) {
  const row = result.rows?.[0];
  if (!row) return null;
  if (Array.isArray(row)) return row[0] ?? null;
  const vals = Object.values(row);
  return vals.length ? vals[0] : null;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

const TIKTOK_INSERT_SQL = `
  INSERT INTO tiktok_posts (
    "Date", "Link", "Likes", "WhoCanView",
    "AllowComments", "AllowStitches", "AllowDuets", "AllowStickers", "AllowSharingToStory",
    "ContentDisclosure", "AIGeneratedContent", "Sound", "Location",
    "Title", "AddYoursText", "AlternateText", "CoverImage", "NumberOfCollections"
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function tiktokPostArgs(post) {
  return [
    post.Date,
    post.Link,
    post.Likes != null ? Number(String(post.Likes).replace(/,/g, '')) : 0,
    post.WhoCanView,
    post.AllowComments ? 1 : 0,
    post.AllowStitches ? 1 : 0,
    post.AllowDuets ? 1 : 0,
    post.AllowStickers ? 1 : 0,
    post.AllowSharingToStory ? 1 : 0,
    post.ContentDisclosure,
    post.AIGeneratedContent,
    post.Sound,
    post.Location,
    post.Title,
    post.AddYoursText,
    post.AlternateText,
    post.CoverImage,
    post.NumberOfCollections,
  ];
}

async function tiktokInsertPost(post) {
  return await turso().execute({ sql: TIKTOK_INSERT_SQL, args: tiktokPostArgs(post) });
}

async function tiktokInsertBulkPosts(posts) {
  const stmts = posts.map(p => ({ sql: TIKTOK_INSERT_SQL, args: tiktokPostArgs(p) }));
  return await turso().batch(stmts, 'write');
}

async function tiktokUpdateStatusByDates(dates, status) {
  if (!Array.isArray(dates) || dates.length === 0) return { updated: 0, success: true };
  if (typeof status !== 'string' || status.length === 0) {
    throw new Error('status must be a non-empty string');
  }
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < dates.length; i += CHUNK) {
    const slice = dates.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const sql = `UPDATE tiktok_posts SET "Status" = ? WHERE "Date" IN (${placeholders})`;
    const r = await turso().execute({ sql, args: [status, ...slice] });
    total += r.rowsAffected ?? 0;
  }
  return { updated: total, success: true };
}

async function tiktokUpdateBlobCoverByDates(dates, blobCoverPathname, blobCoverUrl) {
  if (!Array.isArray(dates) || dates.length === 0) return { updated: 0, success: true };
  if (typeof blobCoverPathname !== 'string' || blobCoverPathname.length === 0) {
    throw new Error('blobCoverPathname must be a non-empty string');
  }
  if (typeof blobCoverUrl !== 'string' || blobCoverUrl.length === 0) {
    throw new Error('blobCoverUrl must be a non-empty string');
  }
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < dates.length; i += CHUNK) {
    const slice = dates.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const sql = `
      UPDATE tiktok_posts
      SET "blob_cover_pathname" = ?, "blob_cover_url" = ?
      WHERE "Date" IN (${placeholders})
    `;
    const r = await turso().execute({ sql, args: [blobCoverPathname, blobCoverUrl, ...slice] });
    total += r.rowsAffected ?? 0;
  }
  return { updated: total, success: true };
}

async function tiktokGetPostsSummary({ limit = 50, offset = 0 } = {}) {
  const r = await turso().execute({
    sql: `SELECT "Date", "Likes", "CoverImage", "Link"
          FROM tiktok_posts_summary ORDER BY "Likes" DESC LIMIT ? OFFSET ?`,
    args: [limit, offset],
  });
  return rowsToObjects(r);
}

async function tiktokGetSummaryByDate(date) {
  const r = await turso().execute({
    sql: `SELECT "Date", "Likes", "CoverImage", "Link"
          FROM tiktok_posts_summary WHERE "Date" = ? LIMIT 1`,
    args: [date],
  });
  return rowsToObjects(r)[0] ?? null;
}

async function tiktokGetTopLikedPosts(n = 10) {
  const r = await turso().execute({
    sql: `SELECT "Date", "Likes", "CoverImage", "Link", "Status",
                 "blob_cover_pathname", "blob_cover_url"
          FROM tiktok_posts_summary ORDER BY "Likes" DESC LIMIT ?`,
    args: [n],
  });
  return rowsToObjects(r);
}
async function tiktokGetFailedPosts(n = 10) {
  const r = await turso().execute({
    sql: `SELECT "Date", "Likes", "CoverImage", "Link", "Status",
                 "blob_cover_pathname", "blob_cover_url"
          FROM all_failed ORDER BY "Likes" DESC LIMIT ?`,
    args: [n],
  });
  return rowsToObjects(r);
}
async function tiktokGetFailedForB2(n = 100) {
  const r = await turso().execute({
    sql: `SELECT "Date", "Likes", "CoverImage", "Link", "Status",
                 "blob_cover_pathname", "blob_cover_url"
          FROM failed_for_b2 ORDER BY "Likes" DESC LIMIT ?`,
    args: [n],
  });
  return rowsToObjects(r);
}

async function tiktokCountPosts() {
  const r = await turso().execute('SELECT COUNT(*) AS total FROM tiktok_posts');
  return Number(firstScalar(r) ?? 0);
}

async function tiktokCountSummaryRows() {
  const r = await turso().execute('SELECT COUNT(*) AS total FROM tiktok_posts_summary');
  return Number(firstScalar(r) ?? 0);
}

async function tiktokCountPostsWithMinLikes(minLikes = 0) {
  const r = await turso().execute({
    sql: `SELECT COUNT(*) AS total FROM tiktok_posts WHERE "Likes" >= ?`,
    args: [minLikes],
  });
  return Number(firstScalar(r) ?? 0);
}

async function tiktokClearAllPosts() {
  const r = await turso().execute('DELETE FROM tiktok_posts');
  return { deleted: r.rowsAffected ?? 0, success: true };
}

async function tiktokDebugViewCols() {
  const info = await turso().execute('PRAGMA table_info(tiktok_posts_summary)');
  const cols = rowsToObjects(info).map(r => r.name);
  const v = await turso().execute(
    `SELECT sql FROM sqlite_master WHERE type='view' AND name='tiktok_posts_summary'`
  );
  return { columns: cols, viewSql: firstScalar(v) || null };
}

// ── POST /api/tiktok ─────────────────────────────────────────────
app.post('/api/tiktok', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { action, payload = {} } = body || {};

  try {
    switch (action) {
      case 'insertPost': {
        if (!payload.post || typeof payload.post !== 'object') {
          return c.json({ error: 'payload.post is required' }, 400);
        }
        const r = await tiktokInsertPost(payload.post);
        return c.json({
          inserted: 1,
          lastInsertRowid: r.lastInsertRowid != null ? String(r.lastInsertRowid) : null,
        });
      }
      case 'insertBulkPosts': {
        if (!Array.isArray(payload.posts)) {
          return c.json({ error: 'payload.posts must be an array' }, 400);
        }
        const results = await tiktokInsertBulkPosts(payload.posts);
        const safe = results.map(rs => ({
          rowsAffected: rs.rowsAffected ?? 0,
          lastInsertRowid: rs.lastInsertRowid != null ? String(rs.lastInsertRowid) : null,
        }));
        return c.json({ result: safe, inserted: payload.posts.length });
      }
      case 'updatePostsStatusByDates': {
        const { dates, status } = payload;
        if (!Array.isArray(dates) || dates.length === 0) {
          return c.json({ error: 'payload.dates must be a non-empty array' }, 400);
        }
        if (typeof status !== 'string' || status.length === 0) {
          return c.json({ error: 'payload.status must be a non-empty string' }, 400);
        }
        return c.json(await tiktokUpdateStatusByDates(dates, status));
      }
      case 'updateBlobCoverByDates': {
        const { dates, blobCoverPathname, blobCoverUrl } = payload;
        if (!Array.isArray(dates) || dates.length === 0) {
          return c.json({ error: 'payload.dates must be a non-empty array' }, 400);
        }
        if (typeof blobCoverPathname !== 'string' || blobCoverPathname.length === 0) {
          return c.json({ error: 'payload.blobCoverPathname must be a non-empty string' }, 400);
        }
        if (typeof blobCoverUrl !== 'string' || blobCoverUrl.length === 0) {
          return c.json({ error: 'payload.blobCoverUrl must be a non-empty string' }, 400);
        }
        return c.json(await tiktokUpdateBlobCoverByDates(dates, blobCoverPathname, blobCoverUrl));
      }
      default:
        return c.json({ error: `Unknown POST action: ${action}` }, 400);
    }
  } catch (e) {
    console.error('tiktok POST error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// ── GET /api/tiktok ──────────────────────────────────────────────
app.get('/api/tiktok', async (c) => {
  const action = c.req.query('action');

  try {
    switch (action) {
      case 'getPostsSummary': {
        const limit = clamp(Number(c.req.query('limit') ?? 50), 1, 3000);
        const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
        return c.json({ result: await tiktokGetPostsSummary({ limit, offset }) });
      }
      case 'getSummaryByDate': {
        const date = c.req.query('date');
        if (!date) return c.json({ error: 'query.date is required' }, 400);
        return c.json({ result: await tiktokGetSummaryByDate(date) });
      }
      case 'getTopLikedPosts': {
        const n = clamp(Number(c.req.query('n') ?? 10), 1, 3000);
        return c.json({ result: await tiktokGetTopLikedPosts(n) });
      }
      case 'getTopFiledPosts': {
        const n = clamp(Number(c.req.query('n') ?? 10), 1, 3000);
        return c.json({ result: await tiktokGetFailedPosts(n) });
      }
      case 'getFailedForB2': {
        const n = clamp(Number(c.req.query('n') ?? 100), 1, 3000);
        return c.json({ result: await tiktokGetFailedForB2(n) });
      }
      case 'countPosts':
        return c.json({ result: await tiktokCountPosts() });
      case 'countSummaryRows':
        return c.json({ result: await tiktokCountSummaryRows() });
      case 'countPostsWithMinLikes': {
        const min = Number(c.req.query('minLikes') ?? 0);
        return c.json({ result: await tiktokCountPostsWithMinLikes(min) });
      }
      case 'debugViewCols':
        return c.json(await tiktokDebugViewCols());
      case 'clearAllPosts':
        return c.json({ ok: true, ...(await tiktokClearAllPosts()) });
      default:
        return c.json({ error: `Unknown GET action: ${action}` }, 400);
    }
  } catch (e) {
    console.error('tiktok GET error:', e);
    return c.json({ error: e.message }, 500);
  }
});
// ── end TikTok posts ─────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════
// Upload cover image to Vercel Blob
// Two modes:
//   application/json     → server fetches from TikTok CDN
//   multipart/form-data  → browser uploads bytes directly (preferred)
// ═════════════════════════════════════════════════════════════════

function sanitizeCoverDate(date) {
  if (!date) return null;
  return String(date).replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40);
}

function sanitizeUserId(userId) {
  if (!userId) return null;
  return String(userId)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || null;
}

function pickImageExt(url, contentType) {
  const m = String(url || '').match(/\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  if (contentType) {
    if (contentType.includes('png'))  return 'png';
    if (contentType.includes('webp')) return 'webp';
    if (contentType.includes('gif'))  return 'gif';
    if (contentType.includes('avif')) return 'avif';
    if (contentType.includes('jpeg')) return 'jpg';
  }
  return 'jpg';
}

async function putCoverBlob({ body, contentType, date, likes, userId, sourceLink, extHint }) {
  const dateStr = sanitizeCoverDate(date) || Date.now().toString();
  const ext = pickImageExt(extHint, contentType);
  const userSeg = sanitizeUserId(userId) || 'unknown';
  const pathname = `${userSeg}/cover_${dateStr}.${ext}`;

  const blobRes = await blob().put(pathname, body, {
    access: 'public',
    addRandomSuffix: false,
    contentType,
    customMetadata: {
      date: String(date || ''),
      likes: String(likes ?? 0),
      sourceLink: String(sourceLink || ''),
      userId: String(userId || ''),
    },
  });

  return {
    success: true,
    pathname: blobRes.pathname,
    url: blobRes.url,
    contentType,
    size: blobRes.size ?? null,
  };
}

app.post('/api/upload-cover-to-blob', async (c) => {
  const ct = (c.req.header('content-type') || '').toLowerCase();

  try {
    // ── MODE B — multipart/form-data (browser-supplied bytes) ──
    if (ct.startsWith('multipart/form-data')) {
      const body = await c.req.parseBody();
      const file = body.file;

      if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
        return c.json({ success: false, error: 'file field required' }, 400);
      }

      const contentType = file.type || 'image/jpeg';
      if (!/^image\//i.test(contentType)) {
        return c.json({ success: false, error: `not an image: ${contentType}` }, 415);
      }

      // 10 MB guard (matches the original formidable maxFileSize).
      if (file.size > 10 * 1024 * 1024) {
        return c.json({ success: false, error: 'file too large (max 10MB)' }, 413);
      }

      const buf = Buffer.from(await file.arrayBuffer());
      const out = await putCoverBlob({
        body: buf,
        contentType,
        date: body.date,
        likes: body.likes,
        userId: body.userId,
        sourceLink: body.sourceLink,
        extHint: file.name || '',
      });
      return c.json(out);
    }

    // ── MODE A — application/json (server fetches from TikTok CDN) ──
    if (ct.startsWith('application/json')) {
      // Guard: 1 MB body cap like the original readJsonBody().
      const len = Number(c.req.header('content-length') || 0);
      if (len > 1024 * 1024) {
        return c.json({ success: false, error: 'JSON body too large' }, 413);
      }

      const { coverImg, date, likes, userId, sourceLink } = await c.req.json().catch(() => ({}));

      if (!coverImg) {
        return c.json({ success: false, error: 'coverImg required' }, 400);
      }

      let parsed;
      try { parsed = new URL(coverImg); }
      catch { return c.json({ success: false, error: 'invalid coverImg URL' }, 400); }

      if (!/^https?:$/.test(parsed.protocol)) {
        return c.json({ success: false, error: 'only http(s) URLs' }, 400);
      }
      if (!ALLOWED_HOSTS.test(parsed.hostname)) {
        return c.json({ success: false, error: `host not allowed: ${parsed.hostname}` }, 400);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      let upstream;
      try {
        upstream = await fetch(coverImg, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/124 Safari/537.36',
            'Referer': 'https://www.tiktok.com/',
            'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8',
          },
          redirect: 'follow',
          signal: controller.signal,
        });
      } catch (e) {
        const msg = e.name === 'AbortError' ? 'upstream timeout (8s)' : `upstream fetch: ${e.message}`;
        return c.json({ success: false, error: msg }, 504);
      } finally {
        clearTimeout(timer);
      }

      if (!upstream.ok || !upstream.body) {
        return c.json({ success: false, error: `upstream fetch failed: HTTP ${upstream.status}` }, 502);
      }

      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      if (!/^image\//i.test(contentType)) {
        return c.json({ success: false, error: `not an image: ${contentType}` }, 415);
      }

      const out = await putCoverBlob({
        body: upstream.body,
        contentType,
        date,
        likes,
        userId,
        sourceLink,
        extHint: coverImg,
      });
      return c.json(out);
    }

    return c.json({ success: false, error: `unsupported content-type: ${ct}` }, 415);
  } catch (e) {
    console.error('upload-cover-to-blob error:', e);
    return c.json({ success: false, error: e.message || 'Upload failed' }, 500);
  }
});

// ── end upload cover to blob ─────────────────────────────────────

// ═════════════════════════════════════════════════════════════════
// Local file uploads (self-contained)
// NOTE: local_files has no b2_group column — everything stays on group 0.
// If you want per-group local files, add `b2_group` to the schema and pass it through.
// ═════════════════════════════════════════════════════════════════

function lfRowsToObjects(result) {
  const cols = (result.columns || []).map(c => (typeof c === 'string' ? c : c.name));
  return (result.rows || []).map(row => {
    if (Array.isArray(row)) {
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj;
    }
    return row;
  });
}

function lfFirstScalar(result) {
  const row = result.rows?.[0];
  if (!row) return null;
  if (Array.isArray(row)) return row[0] ?? null;
  const vals = Object.values(row);
  return vals.length ? vals[0] : null;
}

// POST /api/local-files/upload
app.post('/api/local-files/upload', async (c) => {
  try {
    // local_files: group 0 only
    const client = s3(0);
    const bucket = getBucketForGroup(0);
    const db = turso();

    const body = await c.req.parseBody();
    const file = body.file;
    const userId = String(body.userId || 'user_123').trim().slice(0, 100) || 'user_123';
    const dateModified = body.dateModified ? String(body.dateModified).slice(0, 40) : null;

    if (!file || typeof file === 'string') {
      return c.json({ success: false, error: 'file field required' }, 400);
    }

    const size = file.size || 0;
    if (size > MAX_BYTES) {
      return c.json({ success: false, error: 'file too large', bytes: size, max: MAX_BYTES }, 413);
    }

    const originalName = String(file.name || 'file').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 120);
    const fileType = file.type || 'application/octet-stream';
    const ext = (originalName.match(/\.([a-z0-9]{1,8})$/i) || [, ''])[1].toLowerCase();
    const fileKey = `local_${randomUUID()}${ext ? '.' + ext : ''}`;

    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: fileKey,
        Body: file.stream(),
        ContentType: fileType,
        ContentLength: size || undefined,
      },
    });

    await upload.done();

    await db.execute({
      sql: `INSERT INTO local_files
              (file_key, original_name, file_type, file_size, user_id, date_modified)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [fileKey, originalName, fileType, size || null, userId, dateModified],
    });

    return c.json({
      success: true,
      fileKey,
      originalName,
      fileType,
      fileSize: size || null,
      userId,
      dateModified,
    });
  } catch (error) {
    console.error('Local upload error:', error.message);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// GET /api/local-files/list
app.get('/api/local-files/list', async (c) => {
  try {
    const db = turso();
    const userId = c.req.query('userId') || 'user_123';

    const result = await db.execute({
      sql: `SELECT file_key, original_name, file_type, file_size, user_id, date_modified, uploaded_at
            FROM local_files
            WHERE user_id = ?
            ORDER BY uploaded_at DESC, id DESC`,
      args: [userId],
    });

    return c.json({
      success: true,
      items: lfRowsToObjects(result).map(r => ({
        fileKey: r.file_key,
        originalName: r.original_name,
        fileType: r.file_type,
        fileSize: r.file_size,
        userId: r.user_id,
        dateModified: r.date_modified,
        uploadedAt: r.uploaded_at,
      })),
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// GET /api/local-files/download — 3-day signed URL
app.get('/api/local-files/download', async (c) => {
  try {
    // local_files: group 0 only
    const client = s3(0);
    const bucket = getBucketForGroup(0);
    const db = turso();
    const fileKey = c.req.query('fileKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!fileKey) return c.json({ success: false, error: 'fileKey required' }, 400);

    const check = await db.execute({
      sql: `SELECT file_key, original_name, file_type, file_size
            FROM local_files
            WHERE file_key = ? AND user_id = ?`,
      args: [fileKey, userId],
    });
    const rows = lfRowsToObjects(check);
    if (rows.length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }
    const row = rows[0];

    const downloadUrl = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: fileKey }),
      { expiresIn: 259200 }
    );

    return c.json({
      success: true,
      downloadUrl,
      fileKey: row.file_key,
      originalName: row.original_name,
      fileType: row.file_type,
      fileSize: row.file_size,
      expiresIn: 259200,
    });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// DELETE /api/local-files/delete
app.delete('/api/local-files/delete', async (c) => {
  try {
    // local_files: group 0 only
    const client = s3(0);
    const bucket = getBucketForGroup(0);
    const db = turso();
    const fileKey = c.req.query('fileKey');
    const userId = c.req.query('userId') || 'user_123';
    if (!fileKey) return c.json({ success: false, error: 'fileKey required' }, 400);

    const check = await db.execute({
      sql: `SELECT file_key FROM local_files WHERE file_key = ? AND user_id = ?`,
      args: [fileKey, userId],
    });
    if (lfRowsToObjects(check).length === 0) {
      return c.json({ success: false, error: 'Not found' }, 404);
    }

    await client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: fileKey,
    }));

    await db.execute({
      sql: `DELETE FROM local_files WHERE file_key = ? AND user_id = ?`,
      args: [fileKey, userId],
    });

    return c.json({ success: true });
  } catch (error) {
    return c.json({ success: false, error: error.message }, 500);
  }
});
// ── end local files ─────────────────────────────────────────────

export default app;
