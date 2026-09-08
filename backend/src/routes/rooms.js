const express = require('express');
const { pool } = require('../db');
const { requireUser } = require('../auth');

function buildRoomsRouter(io) {
  const router = express.Router();

  const LIST_SELECT = `
    SELECT
      r.id, r.name, r.farm_id, r.last_seen_at, r.created_at,
      r.mist_activity AS activity, r.mist_activity_started_at AS activity_started_at,
      f.name AS farm_name, f.water_low, f.water_full, f.water_overflow,
      f.tank_activity, f.fert_activity, f.fert_activity_room_id,
      s.humidity_below, s.temp_above, s.window_start, s.window_end,
      s.paused, s.feed_start_date, s.cycle_weeks,
      s.fungicide_interval_days, s.fungicide_last_sprayed_date,
      t.humidity, t.temp_c, t.raining, t.recorded_at AS last_reading_at
    FROM rooms r
    LEFT JOIN farms f ON f.id = r.farm_id
    LEFT JOIN room_schedules s ON s.room_id = r.id
    LEFT JOIN LATERAL (
      SELECT humidity, temp_c, raining, recorded_at
      FROM room_telemetry
      WHERE room_id = r.id
      ORDER BY recorded_at DESC
      LIMIT 1
    ) t ON true
  `;

  router.get('/', requireUser, async (req, res) => {
    const { rows } = await pool.query(`${LIST_SELECT} ORDER BY r.id`);
    res.json(rows);
  });

  router.get('/:id', requireUser, async (req, res) => {
    const { rows } = await pool.query(`${LIST_SELECT} WHERE r.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'room not found' });
    res.json(rows[0]);
  });

  router.patch('/:id', requireUser, async (req, res) => {
    const { name } = req.body || {};
    const { rows } = await pool.query(
      'UPDATE rooms SET name = COALESCE($2, name) WHERE id = $1 RETURNING *',
      [req.params.id, name || null]
    );
    if (!rows[0]) return res.status(404).json({ error: 'room not found' });
    res.json(rows[0]);
  });

  router.get('/:id/schedule', requireUser, async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM room_schedules WHERE room_id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'no schedule for this room' });
    res.json(rows[0]);
  });

  router.post('/:id/schedule', requireUser, async (req, res) => {
    const roomId = req.params.id;
    const body = req.body || {};

    let base = body;
    if (body.templateId) {
      const tpl = await pool.query('SELECT * FROM templates WHERE id = $1', [body.templateId]);
      if (!tpl.rows[0]) return res.status(400).json({ error: 'unknown templateId' });
      base = { ...tpl.rows[0], ...body };
    }

    const { rows } = await pool.query(
      `UPDATE room_schedules SET
        template_id = $2,
        humidity_below = $3,
        temp_above = $4,
        window_start = $5,
        window_end = $6,
        cycle_weeks = $7,
        feed_start_date = $8,
        pre_water_wait_minutes = $9,
        dose_ml = $10,
        fungicide_interval_days = $11,
        feed_product_early = $12,
        feed_product_late = $13,
        fungicide_product = $14,
        fungicide_dose_ml = $15,
        fungicide_automated = $16,
        feed_mix_ratio_ml_per_l = $17,
        feed_batch_water_l = $18,
        fungicide_mix_ratio_ml_per_l = $19,
        fungicide_batch_water_l = $20,
        updated_at = now()
       WHERE room_id = $1
       RETURNING *`,
      [
        roomId,
        base.templateId || base.template_id || null,
        base.humidityBelow ?? base.humidity_below,
        base.tempAbove ?? base.temp_above,
        base.windowStart ?? base.window_start,
        base.windowEnd ?? base.window_end,
        base.cycleWeeks ?? base.cycle_weeks,
        base.feedStartDate ?? base.feed_start_date ?? new Date().toISOString().slice(0, 10),
        base.preWaterWaitMinutes ?? base.pre_water_wait_minutes,
        base.doseMl ?? base.dose_ml,
        base.fungicideIntervalDays ?? base.fungicide_interval_days,
        base.feedProductEarly ?? base.feed_product_early,
        base.feedProductLate ?? base.feed_product_late,
        base.fungicideProduct ?? base.fungicide_product,
        base.fungicideDoseMl ?? base.fungicide_dose_ml,
        base.fungicideAutomated ?? base.fungicide_automated ?? false,
        base.feedMixRatioMlPerL ?? base.feed_mix_ratio_ml_per_l ?? 5,
        base.feedBatchWaterL ?? base.feed_batch_water_l ?? 50,
        base.fungicideMixRatioMlPerL ?? base.fungicide_mix_ratio_ml_per_l ?? 5,
        base.fungicideBatchWaterL ?? base.fungicide_batch_water_l ?? 50,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'no schedule for this room' });
    res.json(rows[0]);
  });

  router.get('/:id/history', requireUser, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const [telemetry, events] = await Promise.all([
      pool.query(
        'SELECT humidity, temp_c, raining, recorded_at FROM room_telemetry WHERE room_id = $1 ORDER BY recorded_at DESC LIMIT $2',
        [req.params.id, limit]
      ),
      pool.query(
        'SELECT type, duration_seconds, volume_ml, meta, occurred_at FROM events WHERE room_id = $1 ORDER BY occurred_at DESC LIMIT $2',
        [req.params.id, limit]
      ),
    ]);
    res.json({
      telemetry: telemetry.rows.reverse(),
      events: events.rows.reverse(),
    });
  });

  router.get('/:id/history.csv', requireUser, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT type, duration_seconds, volume_ml, occurred_at FROM events WHERE room_id = $1 ORDER BY occurred_at',
      [req.params.id]
    );
    const header = 'type,duration_seconds,volume_ml,occurred_at\n';
    const body = rows
      .map((r) => [r.type, r.duration_seconds ?? '', r.volume_ml ?? '', r.occurred_at.toISOString()].join(','))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="room-${req.params.id}-events.csv"`);
    res.send(header + body);
  });

  router.post('/:id/command', requireUser, async (req, res) => {
    const { type } = req.body || {};
    const allowed = ['mist_now', 'pause', 'resume', 'skip_feed'];
    if (!allowed.includes(type)) {
      return res.status(400).json({ error: `type must be one of ${allowed.join(', ')}` });
    }

    if (type === 'pause' || type === 'resume') {
      await pool.query('UPDATE room_schedules SET paused = $2 WHERE room_id = $1', [req.params.id, type === 'pause']);
    }
    if (type === 'skip_feed') {
      await pool.query('UPDATE room_schedules SET skip_feed_once = true WHERE room_id = $1', [req.params.id]);
    }

    const { rows } = await pool.query('INSERT INTO commands (room_id, type) VALUES ($1,$2) RETURNING *', [req.params.id, type]);
    res.status(201).json(rows[0]);
  });

  return router;
}

module.exports = buildRoomsRouter;
