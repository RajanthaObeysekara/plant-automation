const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireUser } = require('../auth');

const router = express.Router();
router.use(requireUser);

router.get('/', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      f.id AS farm_id, f.name AS farm_name, f.last_seen_at,
      f.water_low, f.water_full, f.water_overflow, f.tank_activity, f.tank_filled_at,
      f.autofill_enabled, f.dechlorinate_hours, f.pump_flow_lpm,
      f.fert_activity, f.fert_activity_room_id, f.fert_activity_source, f.fert_activity_started_at,
      f.raw_water_counts, f.raw_fertilizer_early_counts, f.raw_fertilizer_late_counts, f.raw_fungicide_counts,
      r.id AS room_id, r.name AS room_name,
      COUNT(b.id)::int AS bench_count
    FROM farms f
    LEFT JOIN rooms r ON r.farm_id = f.id
    LEFT JOIN benches b ON b.room_id = r.id
    GROUP BY f.id, f.name, r.id, r.name
    ORDER BY f.name, r.name
  `);

  const farms = new Map();
  for (const row of rows) {
    if (!farms.has(row.farm_id)) {
      farms.set(row.farm_id, {
        id: row.farm_id, name: row.farm_name, last_seen_at: row.last_seen_at,
        water_low: row.water_low, water_full: row.water_full, water_overflow: row.water_overflow,
        tank_activity: row.tank_activity, tank_filled_at: row.tank_filled_at,
        autofill_enabled: row.autofill_enabled, dechlorinate_hours: row.dechlorinate_hours, pump_flow_lpm: row.pump_flow_lpm,
        fert_activity: row.fert_activity, fert_activity_room_id: row.fert_activity_room_id, fert_activity_source: row.fert_activity_source, fert_activity_started_at: row.fert_activity_started_at,
        raw_water_counts: row.raw_water_counts, raw_fertilizer_early_counts: row.raw_fertilizer_early_counts,
        raw_fertilizer_late_counts: row.raw_fertilizer_late_counts, raw_fungicide_counts: row.raw_fungicide_counts,
        rooms: [],
      });
    }
    if (row.room_id) {
      farms.get(row.farm_id).rooms.push({ id: row.room_id, name: row.room_name, benchCount: row.bench_count });
    }
  }
  res.json([...farms.values()]);
});

router.post('/', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const deviceKey = crypto.randomBytes(16).toString('hex');
  const { rows } = await pool.query(
    'INSERT INTO farms (name, device_key) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING RETURNING *',
    [name, deviceKey]
  );
  if (!rows[0]) return res.status(409).json({ error: 'a farm with that name already exists' });
  res.status(201).json(rows[0]);
});

router.post('/:id/rooms', async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const deviceKey = crypto.randomBytes(16).toString('hex');
  const room = await pool.query(
    'INSERT INTO rooms (farm_id, name, device_key) VALUES ($1,$2,$3) ON CONFLICT (farm_id, name) DO NOTHING RETURNING *',
    [req.params.id, name, deviceKey]
  );
  if (!room.rows[0]) return res.status(409).json({ error: 'a room with that name already exists on this farm' });

  const tpl = (await pool.query('SELECT * FROM templates ORDER BY id LIMIT 1')).rows[0];
  if (tpl) {
    await pool.query(
      `INSERT INTO room_schedules
        (room_id, template_id, humidity_below, temp_above, window_start, window_end,
         poll_seconds, cycle_weeks, pre_water_wait_minutes, dose_ml, fungicide_interval_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        room.rows[0].id, tpl.id, tpl.humidity_below, tpl.temp_above, tpl.window_start, tpl.window_end,
        tpl.poll_seconds, tpl.cycle_weeks, tpl.pre_water_wait_minutes, tpl.dose_ml, tpl.fungicide_interval_days,
      ]
    );
  }
  await pool.query(
    "INSERT INTO maintenance_tasks (room_id, title, recurrence_days) VALUES ($1, 'Rinse & inspect fogging nozzles', 14)",
    [room.rows[0].id]
  );
  res.status(201).json(room.rows[0]);
});

router.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM farms WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'farm not found' });
  res.json(rows[0]);
});

router.patch('/:id', async (req, res) => {
  const { autofillEnabled, dechlorinateHours, pumpFlowLpm } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE farms SET
      autofill_enabled = COALESCE($2, autofill_enabled),
      dechlorinate_hours = COALESCE($3, dechlorinate_hours),
      pump_flow_lpm = COALESCE($4, pump_flow_lpm)
     WHERE id = $1 RETURNING *`,
    [req.params.id, autofillEnabled ?? null, dechlorinateHours ?? null, pumpFlowLpm ?? null]
  );
  if (!rows[0]) return res.status(404).json({ error: 'farm not found' });
  res.json(rows[0]);
});

router.get('/:id/history', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const [tank, events] = await Promise.all([
    pool.query(
      'SELECT water_low, water_full, water_overflow, recorded_at FROM farm_tank_readings WHERE farm_id = $1 ORDER BY recorded_at DESC LIMIT $2',
      [req.params.id, limit]
    ),
    pool.query(
      `SELECT e.type, e.duration_seconds, e.volume_ml, e.meta, e.occurred_at, r.name AS room_name
       FROM events e LEFT JOIN rooms r ON r.id = e.room_id
       WHERE e.farm_id = $1 ORDER BY e.occurred_at DESC LIMIT $2`,
      [req.params.id, limit]
    ),
  ]);
  res.json({ tank: tank.rows.reverse(), events: events.rows.reverse() });
});

function withDueInfo(task) {
  const last = task.last_completed_at ? new Date(task.last_completed_at) : null;
  const dueDate = last ? new Date(last.getTime() + task.recurrence_days * 86400000) : new Date();
  const daysLeft = Math.floor((dueDate - new Date()) / 86400000);
  return { ...task, dueDate, daysLeft, overdue: daysLeft < 0 };
}

router.get('/:id/maintenance', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM maintenance_tasks WHERE farm_id = $1 ORDER BY recurrence_days', [req.params.id]
  );
  res.json(rows.map(withDueInfo));
});

router.post('/:id/maintenance/:taskId/complete', async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE maintenance_tasks SET last_completed_at = now() WHERE id = $1 AND farm_id = $2 RETURNING *',
    [req.params.taskId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'task not found' });
  await pool.query(
    'INSERT INTO events (farm_id, type, meta) VALUES ($1,$2,$3)',
    [req.params.id, 'maintenance_done', JSON.stringify({ task: rows[0].title })]
  );
  res.json(withDueInfo(rows[0]));
});

const TANK_KEYS = ['water', 'fertilizer_early', 'fertilizer_late', 'fungicide'];

// Manual overrides for calibration/maintenance — "fill this tank now" or
// "drain this tank now" (drain is a software-only reset here; there's no
// automated drain valve in the physical build, this just lets you start a
// tare calibration from a known-empty state). Polled and acted on by the
// farm device the same way mist_now is.
router.post('/:id/command', async (req, res) => {
  const { type } = req.body || {};
  const allowed = TANK_KEYS.flatMap((k) => [`fill_${k}`, `drain_${k}`]);
  if (!allowed.includes(type)) {
    return res.status(400).json({ error: `type must be one of ${allowed.join(', ')}` });
  }
  const { rows } = await pool.query('INSERT INTO commands (farm_id, type) VALUES ($1,$2) RETURNING *', [req.params.id, type]);
  res.status(201).json(rows[0]);
});

// Nominal manufacturer numbers for the load cell shipped with each tank
// size — the same starting point printed on the spec sheet you'd get with
// real hardware. Lets the dashboard show a real live level (and a real low-
// stock warning) before anyone has walked out and run the 2-point
// calibration; COALESCE below never overwrites a tank once a real
// calibration is on file, and TankCalibrationCard still shows "Not
// calibrated yet" until calibrated_at is actually set.
const FACTORY_DEFAULTS = {
  water: { tareRaw: 8_400_000, scaleFactor: 23.5, capacityL: 50 },
  fertilizer_early: { tareRaw: 412_000, scaleFactor: 118.2, capacityL: 20 },
  fertilizer_late: { tareRaw: 296_000, scaleFactor: 104.7, capacityL: 20 },
  fungicide: { tareRaw: 305_000, scaleFactor: 96.4, capacityL: 8 },
};

// Ensures a row exists for all 4 tanks so the UI always has something to
// render, backfills any still-uncalibrated tank with its factory default so
// levels read as real numbers instead of an unknown/flat fallback, then
// returns them in a fixed order.
router.get('/:id/calibration', async (req, res) => {
  await pool.query(
    `INSERT INTO tank_calibrations (farm_id, tank_key, tare_raw, scale_factor, capacity_l, density_g_per_ml, notes)
     SELECT $1, d.k, d.tare_raw, d.scale_factor, d.capacity_l, 1.0, 'factory default — run 2-point calibration for an exact reading'
     FROM unnest($2::text[], $3::numeric[], $4::numeric[], $5::numeric[]) AS d(k, tare_raw, scale_factor, capacity_l)
     ON CONFLICT (farm_id, tank_key) DO UPDATE SET
       tare_raw = COALESCE(tank_calibrations.tare_raw, EXCLUDED.tare_raw),
       scale_factor = COALESCE(tank_calibrations.scale_factor, EXCLUDED.scale_factor),
       capacity_l = COALESCE(tank_calibrations.capacity_l, EXCLUDED.capacity_l),
       density_g_per_ml = COALESCE(tank_calibrations.density_g_per_ml, EXCLUDED.density_g_per_ml),
       notes = COALESCE(tank_calibrations.notes, EXCLUDED.notes)`,
    [
      req.params.id, TANK_KEYS,
      TANK_KEYS.map((k) => FACTORY_DEFAULTS[k].tareRaw),
      TANK_KEYS.map((k) => FACTORY_DEFAULTS[k].scaleFactor),
      TANK_KEYS.map((k) => FACTORY_DEFAULTS[k].capacityL),
    ]
  );
  const { rows } = await pool.query(
    'SELECT * FROM tank_calibrations WHERE farm_id = $1', [req.params.id]
  );
  const byKey = Object.fromEntries(rows.map((r) => [r.tank_key, r]));
  res.json(TANK_KEYS.map((k) => byKey[k]));
});

router.put('/:id/calibration/:tankKey', async (req, res) => {
  const { tankKey } = req.params;
  if (!TANK_KEYS.includes(tankKey)) return res.status(400).json({ error: `tankKey must be one of ${TANK_KEYS.join(', ')}` });

  const { tareRaw, knownWeightG, rawAtKnownWeight, capacityL, densityGPerMl, notes } = req.body || {};
  const scaleFactor = (tareRaw != null && knownWeightG != null && rawAtKnownWeight != null && Number(knownWeightG) !== 0)
    ? (Number(rawAtKnownWeight) - Number(tareRaw)) / Number(knownWeightG)
    : null;

  const { rows } = await pool.query(
    `INSERT INTO tank_calibrations (farm_id, tank_key, tare_raw, known_weight_g, raw_at_known_weight, scale_factor, capacity_l, density_g_per_ml, notes, calibrated_at)
     VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,COALESCE($8,1.0),$9, CASE WHEN $6::numeric IS NOT NULL THEN now() ELSE NULL END)
     ON CONFLICT (farm_id, tank_key) DO UPDATE SET
       tare_raw = EXCLUDED.tare_raw,
       known_weight_g = EXCLUDED.known_weight_g,
       raw_at_known_weight = EXCLUDED.raw_at_known_weight,
       scale_factor = EXCLUDED.scale_factor,
       capacity_l = EXCLUDED.capacity_l,
       density_g_per_ml = EXCLUDED.density_g_per_ml,
       notes = EXCLUDED.notes,
       calibrated_at = CASE WHEN EXCLUDED.scale_factor IS NOT NULL THEN now() ELSE tank_calibrations.calibrated_at END
     RETURNING *`,
    [req.params.id, tankKey, tareRaw ?? null, knownWeightG ?? null, rawAtKnownWeight ?? null,
      scaleFactor, capacityL ?? null, densityGPerMl ?? null, notes || null]
  );
  res.json(rows[0]);
});

module.exports = router;
