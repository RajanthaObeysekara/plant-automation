const express = require('express');
const { pool } = require('../db');
const { requireUser } = require('../auth');

const router = express.Router();
router.use(requireUser);

router.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      f.id AS farm_id, f.name AS farm_name,
      r.id AS room_id, r.name AS room_name,
      COUNT(u.id)::int AS unit_count
    FROM farms f
    LEFT JOIN rooms r ON r.farm_id = f.id
    LEFT JOIN units u ON u.room_id = r.id
    GROUP BY f.id, f.name, r.id, r.name
    ORDER BY f.name, r.name
  `);

  const farms = new Map();
  for (const row of rows) {
    if (!farms.has(row.farm_id)) farms.set(row.farm_id, { id: row.farm_id, name: row.farm_name, rooms: [] });
    if (row.room_id) {
      farms.get(row.farm_id).rooms.push({ id: row.room_id, name: row.room_name, unitCount: row.unit_count });
    }
  }
  res.json([...farms.values()]);
});

router.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await pool.query(
    'INSERT INTO farms (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *',
    [name]
  );
  if (!rows[0]) return res.status(409).json({ error: 'a farm with that name already exists' });
  res.status(201).json(rows[0]);
});

router.post('/:id/rooms', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await pool.query(
    'INSERT INTO rooms (farm_id, name) VALUES ($1,$2) ON CONFLICT (farm_id, name) DO NOTHING RETURNING *',
    [req.params.id, name]
  );
  if (!rows[0]) return res.status(409).json({ error: 'a room with that name already exists on this farm' });
  res.status(201).json(rows[0]);
});

module.exports = router;
