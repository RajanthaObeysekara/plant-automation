const express = require('express');
const { pool } = require('../db');
const { requireDevice } = require('../deviceAuth');

function buildDeviceRouter(io) {
  const router = express.Router();
  router.use(requireDevice);

  router.get('/config', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM unit_schedules WHERE unit_id = $1', [req.unit.id]);
    if (!rows[0]) return res.status(404).json({ error: 'no schedule configured for this unit yet' });
    const s = rows[0];
    res.json({
      unitId: req.unit.id,
      unitName: req.unit.name,
      trigger: { humidityBelow: s.humidity_below, tempAbove: Number(s.temp_above) },
      schedule: { windowStart: s.window_start, windowEnd: s.window_end, pollSeconds: s.poll_seconds },
      feed: {
        cycleWeeks: s.cycle_weeks,
        feedStartDate: s.feed_start_date,
        preWaterWaitMinutes: s.pre_water_wait_minutes,
        doseMl: s.dose_ml,
        mixRatioMlPerL: Number(s.feed_mix_ratio_ml_per_l),
        batchWaterL: Number(s.feed_batch_water_l),
      },
      fungicide: {
        intervalDays: s.fungicide_interval_days,
        lastSprayedDate: s.fungicide_last_sprayed_date,
        doseMl: s.fungicide_dose_ml,
        automated: s.fungicide_automated,
        mixRatioMlPerL: Number(s.fungicide_mix_ratio_ml_per_l),
        batchWaterL: Number(s.fungicide_batch_water_l),
      },
      autofillEnabled: s.autofill_enabled,
      dechlorinateHours: s.dechlorinate_hours,
      pumpFlowLpm: Number(s.pump_flow_lpm),
      paused: s.paused,
      skipFeedOnce: s.skip_feed_once,
      syncedAt: new Date().toISOString(),
    });
  });

  router.post('/status', async (req, res) => {
    const { activity } = req.body || {};
    // Matches every status string the firmware actually posts (main.cpp)
    const allowed = ['idle', 'misting', 'feeding', 'filling', 'fungicide', 'dechlorinating', 'overflow'];
    if (!allowed.includes(activity)) {
      return res.status(400).json({ error: `activity must be one of ${allowed.join(', ')}` });
    }
    const { rows } = await pool.query(
      `INSERT INTO unit_status (unit_id, activity, started_at) VALUES ($1,$2,now())
       ON CONFLICT (unit_id) DO UPDATE SET activity = $2, started_at = now()
       RETURNING *`,
      [req.unit.id, activity]
    );
    io.to(`unit:${req.unit.id}`).emit('status', { unitId: req.unit.id, ...rows[0] });
    res.status(201).json(rows[0]);
  });

  router.post('/telemetry', async (req, res) => {
    const { humidity, tempC, raining, waterLow, waterFull, waterOverflow } = req.body || {};
    const { rows } = await pool.query(
      `INSERT INTO telemetry (unit_id, humidity, temp_c, raining, water_low, water_full, water_overflow)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.unit.id, humidity, tempC, !!raining, waterLow ?? null, waterFull ?? null, waterOverflow ?? null]
    );
    io.to(`unit:${req.unit.id}`).emit('telemetry', rows[0]);
    res.status(201).json(rows[0]);
  });

  router.post('/events', async (req, res) => {
    const { type, durationSeconds, volumeMl, meta } = req.body || {};
    if (!type) return res.status(400).json({ error: 'type is required' });

    const { rows } = await pool.query(
      'INSERT INTO events (unit_id, type, duration_seconds, volume_ml, meta) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.unit.id, type, durationSeconds || null, volumeMl || null, meta || null]
    );

    if (type === 'fungicide_sprayed') {
      await pool.query(
        'UPDATE unit_schedules SET fungicide_last_sprayed_date = CURRENT_DATE WHERE unit_id = $1',
        [req.unit.id]
      );
    }
    if (type === 'feed' && req.unit) {
      await pool.query('UPDATE unit_schedules SET skip_feed_once = false WHERE unit_id = $1', [req.unit.id]);
    }

    io.to(`unit:${req.unit.id}`).emit('event', rows[0]);
    res.status(201).json(rows[0]);
  });

  router.get('/commands', async (req, res) => {
    const { rows } = await pool.query(
      "SELECT * FROM commands WHERE unit_id = $1 AND status = 'pending' ORDER BY created_at",
      [req.unit.id]
    );
    if (rows.length > 0) {
      await pool.query(
        "UPDATE commands SET status = 'delivered', delivered_at = now() WHERE id = ANY($1)",
        [rows.map((r) => r.id)]
      );
    }
    res.json(rows);
  });

  return router;
}

module.exports = { buildDeviceRouter };
