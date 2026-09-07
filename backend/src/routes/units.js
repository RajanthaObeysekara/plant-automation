const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireUser } = require('../auth');

const router = express.Router();

const LIST_SELECT = `
  SELECT
    u.id, u.name, u.bench, u.room_id, u.last_seen_at, u.created_at,
    r.name AS room_name, r.farm_id, f.name AS farm_name,
    s.humidity_below, s.temp_above, s.window_start, s.window_end,
    s.paused, s.feed_start_date, s.cycle_weeks,
    s.fungicide_interval_days, s.fungicide_last_sprayed_date,
    t.humidity, t.temp_c, t.raining, t.recorded_at AS last_reading_at,
    t.water_low, t.water_full, t.water_overflow,
    COALESCE(st.activity, 'idle') AS activity, st.started_at AS activity_started_at
  FROM units u
  LEFT JOIN rooms r ON r.id = u.room_id
  LEFT JOIN farms f ON f.id = r.farm_id
  LEFT JOIN unit_schedules s ON s.unit_id = u.id
  LEFT JOIN unit_status st ON st.unit_id = u.id
  LEFT JOIN LATERAL (
    SELECT humidity, temp_c, raining, water_low, water_full, water_overflow, recorded_at
    FROM telemetry
    WHERE unit_id = u.id
    ORDER BY recorded_at DESC
    LIMIT 1
  ) t ON true
`;

router.get('/', requireUser, async (req, res) => {
  const { rows } = await pool.query(`${LIST_SELECT} ORDER BY u.id`);
  res.json(rows);
});

router.post('/', requireUser, async (req, res) => {
  const { name, bench, roomId, templateId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const deviceKey = crypto.randomBytes(16).toString('hex');
  const unit = await pool.query(
    'INSERT INTO units (name, bench, room_id, device_key) VALUES ($1,$2,$3,$4) RETURNING *',
    [name, bench || null, roomId || null, deviceKey]
  );
  const unitId = unit.rows[0].id;

  const tpl = templateId
    ? (await pool.query('SELECT * FROM templates WHERE id = $1', [templateId])).rows[0]
    : (await pool.query('SELECT * FROM templates ORDER BY id LIMIT 1')).rows[0];

  if (tpl) {
    await pool.query(
      `INSERT INTO unit_schedules
        (unit_id, template_id, humidity_below, temp_above, window_start, window_end,
         poll_seconds, cycle_weeks, pre_water_wait_minutes, dose_ml, fungicide_interval_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        unitId, tpl.id, tpl.humidity_below, tpl.temp_above, tpl.window_start, tpl.window_end,
        tpl.poll_seconds, tpl.cycle_weeks, tpl.pre_water_wait_minutes, tpl.dose_ml,
        tpl.fungicide_interval_days,
      ]
    );
  }

  res.status(201).json({ ...unit.rows[0], deviceKey });
});

router.get('/:id', requireUser, async (req, res) => {
  const { rows } = await pool.query(`${LIST_SELECT} WHERE u.id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'unit not found' });
  res.json(rows[0]);
});

router.patch('/:id', requireUser, async (req, res) => {
  const { name, bench, roomId } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE units SET
      name = COALESCE($2, name),
      bench = COALESCE($3, bench),
      room_id = COALESCE($4, room_id)
     WHERE id = $1 RETURNING *`,
    [req.params.id, name || null, bench || null, roomId || null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'unit not found' });
  res.json(rows[0]);
});

router.get('/:id/schedule', requireUser, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM unit_schedules WHERE unit_id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'no schedule for this unit' });
  res.json(rows[0]);
});

router.post('/:id/schedule', requireUser, async (req, res) => {
  const unitId = req.params.id;
  const body = req.body || {};

  let base = body;
  if (body.templateId) {
    const tpl = await pool.query('SELECT * FROM templates WHERE id = $1', [body.templateId]);
    if (!tpl.rows[0]) return res.status(400).json({ error: 'unknown templateId' });
    base = { ...tpl.rows[0], ...body };
  }

  const { rows } = await pool.query(
    `UPDATE unit_schedules SET
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
      autofill_enabled = $17,
      dechlorinate_hours = $18,
      pump_flow_lpm = $19,
      feed_mix_ratio_ml_per_l = $20,
      feed_batch_water_l = $21,
      fungicide_mix_ratio_ml_per_l = $22,
      fungicide_batch_water_l = $23,
      updated_at = now()
     WHERE unit_id = $1
     RETURNING *`,
    [
      unitId,
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
      base.autofillEnabled ?? base.autofill_enabled ?? false,
      base.dechlorinateHours ?? base.dechlorinate_hours ?? 24,
      base.pumpFlowLpm ?? base.pump_flow_lpm ?? 4.5,
      base.feedMixRatioMlPerL ?? base.feed_mix_ratio_ml_per_l ?? 5,
      base.feedBatchWaterL ?? base.feed_batch_water_l ?? 50,
      base.fungicideMixRatioMlPerL ?? base.fungicide_mix_ratio_ml_per_l ?? 5,
      base.fungicideBatchWaterL ?? base.fungicide_batch_water_l ?? 50,
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'no schedule for this unit' });
  res.json(rows[0]);
});

router.get('/:id/history', requireUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const [telemetry, events] = await Promise.all([
    pool.query(
      'SELECT humidity, temp_c, raining, water_low, water_full, water_overflow, recorded_at FROM telemetry WHERE unit_id = $1 ORDER BY recorded_at DESC LIMIT $2',
      [req.params.id, limit]
    ),
    pool.query(
      'SELECT type, duration_seconds, volume_ml, meta, occurred_at FROM events WHERE unit_id = $1 ORDER BY occurred_at DESC LIMIT $2',
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
    'SELECT type, duration_seconds, volume_ml, occurred_at FROM events WHERE unit_id = $1 ORDER BY occurred_at',
    [req.params.id]
  );
  const header = 'type,duration_seconds,volume_ml,occurred_at\n';
  const body = rows
    .map((r) => [r.type, r.duration_seconds ?? '', r.volume_ml ?? '', r.occurred_at.toISOString()].join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="unit-${req.params.id}-events.csv"`);
  res.send(header + body);
});

router.post('/:id/command', requireUser, async (req, res) => {
  const { type } = req.body || {};
  const allowed = ['mist_now', 'pause', 'resume', 'skip_feed'];
  if (!allowed.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${allowed.join(', ')}` });
  }

  if (type === 'pause' || type === 'resume') {
    await pool.query('UPDATE unit_schedules SET paused = $2 WHERE unit_id = $1', [
      req.params.id,
      type === 'pause',
    ]);
  }
  if (type === 'skip_feed') {
    await pool.query('UPDATE unit_schedules SET skip_feed_once = true WHERE unit_id = $1', [req.params.id]);
  }

  const { rows } = await pool.query(
    'INSERT INTO commands (unit_id, type) VALUES ($1,$2) RETURNING *',
    [req.params.id, type]
  );
  res.status(201).json(rows[0]);
});

module.exports = router;
