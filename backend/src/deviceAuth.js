const crypto = require('crypto');
const { pool } = require('./db');

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Two kinds of device now poll this API: a room (env sensor + misting) and
// a farm (shared water tank + fertigation rig). Both authenticate the same
// way — a bearer device_key, checked constant-time against every key on
// file — so this loads both key sets and tags which kind matched.
const KEY_CACHE_TTL_MS = 20000;
let keyCache = []; // [{ id, device_key, kind: 'room' | 'farm' }]
let keyCacheAt = 0;

async function loadKeyCache() {
  const [rooms, farms] = await Promise.all([
    pool.query('SELECT id, device_key FROM rooms'),
    pool.query('SELECT id, device_key FROM farms'),
  ]);
  keyCache = [
    ...rooms.rows.map((r) => ({ id: r.id, device_key: r.device_key, kind: 'room' })),
    ...farms.rows.map((r) => ({ id: r.id, device_key: r.device_key, kind: 'farm' })),
  ];
  keyCacheAt = Date.now();
}

async function requireDevice(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, key] = header.split(' ');
  if (scheme !== 'Bearer' || !key) {
    return res.status(401).json({ error: 'missing device key' });
  }

  if (Date.now() - keyCacheAt > KEY_CACHE_TTL_MS) {
    await loadKeyCache();
  }
  const match = keyCache.find((k) => safeEqual(k.device_key, key));
  if (!match) return res.status(401).json({ error: 'unknown device key' });
  if (match.kind !== req.deviceKind) {
    return res.status(401).json({ error: `this key belongs to a ${match.kind} device` });
  }

  const table = match.kind === 'room' ? 'rooms' : 'farms';
  const { rows } = await pool.query(
    `UPDATE ${table} SET last_seen_at = now() WHERE id = $1 RETURNING *`,
    [match.id]
  );
  req.device = rows[0];
  next();
}

// requireDevice checks the caller's key against the right table for the
// route it hit (a room key can't authenticate as the farm device, or vice
// versa) — wrap it per router with the kind that router represents.
function requireDeviceKind(kind) {
  return (req, res, next) => {
    req.deviceKind = kind;
    return requireDevice(req, res, next);
  };
}

module.exports = { requireDeviceKind };
