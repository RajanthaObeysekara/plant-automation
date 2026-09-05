const crypto = require('crypto');
const { pool } = require('./db');

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function requireDevice(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, key] = header.split(' ');
  if (scheme !== 'Bearer' || !key) {
    return res.status(401).json({ error: 'missing device key' });
  }

  const { rows } = await pool.query('SELECT * FROM units', []);
  const unit = rows.find((u) => safeEqual(u.device_key, key));
  if (!unit) return res.status(401).json({ error: 'unknown device key' });

  await pool.query('UPDATE units SET last_seen_at = now() WHERE id = $1', [unit.id]);
  req.unit = unit;
  next();
}

module.exports = { requireDevice };
