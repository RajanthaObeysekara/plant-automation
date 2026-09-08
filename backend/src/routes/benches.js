const express = require('express');
const { pool } = require('../db');
const { requireUser } = require('../auth');

// Benches are just named, positioned spots on a room's floor-plan map — no
// device_key, sensor, or schedule. They inherit their room's climate and
// their farm's shared water/fertilizer supply.
function buildBenchesRouter(io) {
  const router = express.Router();
  router.use(requireUser);

  router.get('/', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM benches ORDER BY id');
    res.json(rows);
  });

  router.post('/', async (req, res) => {
    const { roomId, name, variety } = req.body || {};
    if (!roomId || !name) return res.status(400).json({ error: 'roomId and name are required' });
    const { rows } = await pool.query(
      'INSERT INTO benches (room_id, name, variety, pos_x, pos_y) VALUES ($1,$2,$3,50,50) RETURNING *',
      [roomId, name, variety || null]
    );
    res.status(201).json(rows[0]);
  });

  router.patch('/:id', async (req, res) => {
    const { name, variety, rowLabel, posX, posY } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE benches SET
        name = COALESCE($2, name),
        variety = COALESCE($3, variety),
        row_label = COALESCE($4, row_label),
        pos_x = COALESCE($5, pos_x),
        pos_y = COALESCE($6, pos_y)
       WHERE id = $1 RETURNING *`,
      [req.params.id, name || null, variety || null, rowLabel || null, posX ?? null, posY ?? null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'bench not found' });
    if (posX != null || posY != null) {
      io.emit('bench_position', { benchId: rows[0].id, posX: rows[0].pos_x, posY: rows[0].pos_y });
    }
    res.json(rows[0]);
  });

  router.delete('/:id', async (req, res) => {
    const { rowCount } = await pool.query('DELETE FROM benches WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'bench not found' });
    res.status(204).end();
  });

  return router;
}

module.exports = buildBenchesRouter;
