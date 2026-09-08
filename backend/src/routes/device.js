const express = require('express');
const { pool } = require('../db');
const { requireDeviceKind } = require('../deviceAuth');
const { buildSevenDayPlan } = require('../planner');

// Status strings actually posted by a room controller (env sensor + shared
// misting for every bench in it) vs. a farm controller (shared water tank +
// fertigation rig, used on behalf of whichever room's feed day it is).
const ROOM_ACTIVITIES = ['idle', 'misting'];
const TANK_ACTIVITIES = ['idle', 'filling', 'dechlorinating', 'overflow'];
const FERT_ACTIVITIES = ['idle', 'mixing', 'stirring', 'filtering', 'feeding'];

function buildRoomDeviceRouter(io) {
  const router = express.Router();
  router.use(requireDeviceKind('room'));

  router.get('/config', async (req, res) => {
    const room = req.device;
    const [scheduleRes, farmRes] = await Promise.all([
      pool.query('SELECT * FROM room_schedules WHERE room_id = $1', [room.id]),
      pool.query('SELECT * FROM farms WHERE id = $1', [room.farm_id]),
    ]);
    const s = scheduleRes.rows[0];
    if (!s) return res.status(404).json({ error: 'no schedule configured for this room yet' });
    const farm = farmRes.rows[0];

    // `?boot=1` — the device sends this only on its very first config fetch
    // after power-on, so a field reboot is visible on the dashboard instead
    // of looking identical to a routine poll. last_config_sync_at is
    // touched on every fetch, booted or not, so "last check-in" is always
    // accurate even between reboots.
    const booted = req.query.boot === '1';
    await pool.query(
      `UPDATE rooms SET last_config_sync_at = now()${booted ? ', last_boot_at = now()' : ''} WHERE id = $1`,
      [room.id]
    );

    res.json({
      roomId: room.id,
      roomName: room.name,
      trigger: { humidityBelow: s.humidity_below, tempAbove: Number(s.temp_above) },
      schedule: { windowStart: s.window_start, windowEnd: s.window_end, pollSeconds: s.poll_seconds },
      feed: {
        cycleWeeks: s.cycle_weeks,
        feedStartDate: s.feed_start_date,
        preWaterWaitMinutes: s.pre_water_wait_minutes,
        doseMl: s.dose_ml,
        mixRatioMlPerL: Number(s.feed_mix_ratio_ml_per_l),
        batchWaterL: Number(s.feed_batch_water_l),
        // Persisted so "already fed today" survives a simulator restart —
        // an in-memory-only guard re-doses every room whose feed day
        // matches today the moment the process restarts.
        lastFedDate: s.last_fed_date,
      },
      fungicide: {
        intervalDays: s.fungicide_interval_days,
        lastSprayedDate: s.fungicide_last_sprayed_date,
        doseMl: s.fungicide_dose_ml,
        automated: s.fungicide_automated,
        mixRatioMlPerL: Number(s.fungicide_mix_ratio_ml_per_l),
        batchWaterL: Number(s.fungicide_batch_water_l),
      },
      paused: s.paused,
      skipFeedOnce: s.skip_feed_once,
      pumpFlowLpm: farm ? Number(farm.pump_flow_lpm) : null,
      tank: {
        // The farm's shared tank gates whether this room is allowed to
        // mist/feed right now. Blocked while low (empty or draining down),
        // mid-fill (pressure/flow isn't settled yet), dechlorinating, or in
        // overflow — any one of these means "don't draw from this tank".
        ready: !!farm && !farm.water_low && !farm.water_overflow
          && farm.tank_activity !== 'dechlorinating' && farm.tank_activity !== 'filling',
        low: farm ? farm.water_low : null,
      },
      // Server-initiated scheduling: the room caches this and can decide
      // "is today a feed day / is fungicide due" purely from this array,
      // fully offline, for up to a week without contacting the server
      // again. Regenerated fresh (relative to today) on every fetch.
      scheduleVersion: s.schedule_version,
      plan: buildSevenDayPlan(s),
      syncedAt: new Date().toISOString(),
    });
  });

  router.post('/status', async (req, res) => {
    const { activity } = req.body || {};
    if (!ROOM_ACTIVITIES.includes(activity)) {
      return res.status(400).json({ error: `activity must be one of ${ROOM_ACTIVITIES.join(', ')}` });
    }
    const { rows } = await pool.query(
      'UPDATE rooms SET mist_activity = $2, mist_activity_started_at = now() WHERE id = $1 RETURNING *',
      [req.device.id, activity]
    );
    io.to(`room:${req.device.id}`).emit('room_status', { roomId: req.device.id, activity: rows[0].mist_activity });
    res.status(201).json(rows[0]);
  });

  router.post('/telemetry', async (req, res) => {
    const { humidity, tempC, raining, scheduleVersion } = req.body || {};
    const inserts = [
      pool.query(
        `INSERT INTO room_telemetry (room_id, humidity, temp_c, raining) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.device.id, humidity, tempC, !!raining]
      ),
    ];
    // The device echoes back whichever schedule_version it fetched last —
    // this is what makes "synced" a checkable fact instead of an assumption.
    // Comes in on telemetry (posted every cycle already) rather than a
    // dedicated endpoint, so it costs nothing extra on the wire.
    if (scheduleVersion != null) {
      inserts.push(pool.query('UPDATE rooms SET synced_schedule_version = $2 WHERE id = $1', [req.device.id, scheduleVersion]));
    }
    const [reading] = await Promise.all(inserts);
    io.to(`room:${req.device.id}`).emit('room_telemetry', reading.rows[0]);
    res.status(201).json(reading.rows[0]);
  });

  router.post('/events', async (req, res) => {
    const { type, durationSeconds, volumeMl, meta } = req.body || {};
    const allowed = ['mist', 'fungicide_reminder', 'fungicide_sprayed', 'mist_skipped', 'feed_reminder'];
    if (!allowed.includes(type)) return res.status(400).json({ error: `type must be one of ${allowed.join(', ')}` });

    const { rows } = await pool.query(
      'INSERT INTO events (room_id, type, duration_seconds, volume_ml, meta) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.device.id, type, durationSeconds || null, volumeMl || null, meta || null]
    );
    if (type === 'fungicide_sprayed') {
      await pool.query('UPDATE room_schedules SET fungicide_last_sprayed_date = CURRENT_DATE WHERE room_id = $1', [req.device.id]);
    }
    io.to(`room:${req.device.id}`).emit('room_event', rows[0]);
    res.status(201).json(rows[0]);
  });

  router.get('/commands', async (req, res) => {
    const { rows } = await pool.query(
      "SELECT * FROM commands WHERE room_id = $1 AND status = 'pending' ORDER BY created_at",
      [req.device.id]
    );
    if (rows.length > 0) {
      await pool.query("UPDATE commands SET status = 'delivered', delivered_at = now() WHERE id = ANY($1)", [rows.map((r) => r.id)]);
    }
    res.json(rows);
  });

  return router;
}

function buildFarmDeviceRouter(io) {
  const router = express.Router();
  router.use(requireDeviceKind('farm'));

  router.get('/config', async (req, res) => {
    const farm = req.device;
    res.json({
      farmId: farm.id,
      farmName: farm.name,
      autofillEnabled: farm.autofill_enabled,
      dechlorinateHours: farm.dechlorinate_hours,
      pumpFlowLpm: Number(farm.pump_flow_lpm),
      syncedAt: new Date().toISOString(),
    });
  });

  router.post('/tank-status', async (req, res) => {
    const { activity } = req.body || {};
    if (!TANK_ACTIVITIES.includes(activity)) {
      return res.status(400).json({ error: `activity must be one of ${TANK_ACTIVITIES.join(', ')}` });
    }
    const setFilledAt = activity === 'filling' ? ', tank_filled_at = now()' : '';
    const { rows } = await pool.query(
      `UPDATE farms SET tank_activity = $2${setFilledAt} WHERE id = $1 RETURNING *`,
      [req.device.id, activity]
    );
    io.to(`farm:${req.device.id}`).emit('farm_tank_status', { farmId: req.device.id, activity: rows[0].tank_activity });
    res.status(201).json(rows[0]);
  });

  router.post('/fert-status', async (req, res) => {
    const { activity, roomId, source } = req.body || {};
    if (!FERT_ACTIVITIES.includes(activity)) {
      return res.status(400).json({ error: `activity must be one of ${FERT_ACTIVITIES.join(', ')}` });
    }
    if (source && !['fertilizer_early', 'fertilizer_late'].includes(source)) {
      return res.status(400).json({ error: 'source must be fertilizer_early or fertilizer_late' });
    }
    const { rows } = await pool.query(
      `UPDATE farms SET fert_activity = $2, fert_activity_room_id = $3, fert_activity_source = $4, fert_activity_started_at = now()
       WHERE id = $1 RETURNING *`,
      [req.device.id, activity, activity === 'idle' ? null : roomId || null, activity === 'idle' ? null : source || null]
    );
    io.to(`farm:${req.device.id}`).emit('farm_fert_status', {
      farmId: req.device.id, activity: rows[0].fert_activity, roomId: rows[0].fert_activity_room_id, source: rows[0].fert_activity_source,
    });
    if (rows[0].fert_activity_room_id) {
      io.to(`room:${rows[0].fert_activity_room_id}`).emit('room_fert_status', {
        roomId: rows[0].fert_activity_room_id, activity: rows[0].fert_activity, source: rows[0].fert_activity_source,
      });
    }
    res.status(201).json(rows[0]);
  });

  router.post('/telemetry', async (req, res) => {
    const {
      waterLow, waterFull, waterOverflow,
      rawWaterCounts, rawFertilizerEarlyCounts, rawFertilizerLateCounts, rawFungicideCounts,
    } = req.body || {};
    const [reading, farm] = await Promise.all([
      pool.query(
        `INSERT INTO farm_tank_readings (farm_id, water_low, water_full, water_overflow) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.device.id, waterLow ?? null, waterFull ?? null, waterOverflow ?? null]
      ),
      pool.query(
        `UPDATE farms SET
          water_low = $2, water_full = $3, water_overflow = $4,
          raw_water_counts = COALESCE($5, raw_water_counts),
          raw_fertilizer_early_counts = COALESCE($6, raw_fertilizer_early_counts),
          raw_fertilizer_late_counts = COALESCE($7, raw_fertilizer_late_counts),
          raw_fungicide_counts = COALESCE($8, raw_fungicide_counts)
         WHERE id = $1 RETURNING raw_water_counts, raw_fertilizer_early_counts, raw_fertilizer_late_counts, raw_fungicide_counts`,
        [req.device.id, waterLow ?? null, waterFull ?? null, waterOverflow ?? null,
          rawWaterCounts ?? null, rawFertilizerEarlyCounts ?? null, rawFertilizerLateCounts ?? null, rawFungicideCounts ?? null]
      ),
    ]);
    io.to(`farm:${req.device.id}`).emit('farm_telemetry', { ...reading.rows[0], ...farm.rows[0] });
    res.status(201).json(reading.rows[0]);
  });

  router.post('/events', async (req, res) => {
    const { type, roomId, durationSeconds, volumeMl, meta } = req.body || {};
    const allowed = ['autofill', 'feed', 'fert_stock_low', 'tank_empty_no_autofill'];
    if (!allowed.includes(type)) return res.status(400).json({ error: `type must be one of ${allowed.join(', ')}` });
    if (type === 'feed' && !roomId) return res.status(400).json({ error: 'roomId is required for a feed event' });

    const { rows } = await pool.query(
      'INSERT INTO events (farm_id, room_id, type, duration_seconds, volume_ml, meta) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.device.id, roomId || null, type, durationSeconds || null, volumeMl || null, meta || null]
    );
    if (type === 'feed') {
      await pool.query('UPDATE room_schedules SET skip_feed_once = false, last_fed_date = CURRENT_DATE WHERE room_id = $1', [roomId]);
      io.to(`room:${roomId}`).emit('room_event', rows[0]);
    }
    io.to(`farm:${req.device.id}`).emit('farm_event', rows[0]);
    res.status(201).json(rows[0]);
  });

  router.get('/commands', async (req, res) => {
    const { rows } = await pool.query(
      "SELECT * FROM commands WHERE farm_id = $1 AND status = 'pending' ORDER BY created_at",
      [req.device.id]
    );
    if (rows.length > 0) {
      await pool.query("UPDATE commands SET status = 'delivered', delivered_at = now() WHERE id = ANY($1)", [rows.map((r) => r.id)]);
    }
    res.json(rows);
  });

  return router;
}

module.exports = { buildRoomDeviceRouter, buildFarmDeviceRouter };
