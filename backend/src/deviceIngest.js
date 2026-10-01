const { pool } = require('./db');
const { buildSevenDayPlan } = require('./planner');

// Shared between the REST device routes (backend/src/routes/device.js —
// still used by the simulator) and the MQTT bridge (backend/src/mqtt.js —
// used by real hardware). Same DB writes and same Socket.IO emits either
// way, so a room behaves identically regardless of which transport its
// device is actually speaking.

const ROOM_ACTIVITIES = ['idle', 'misting'];
const EVENT_TYPES = ['mist', 'fungicide_reminder', 'fungicide_sprayed', 'mist_skipped', 'feed_reminder'];
const LOG_LEVELS = ['info', 'warn', 'error'];

async function buildRoomConfigPayload(room, { boot } = {}) {
  const [scheduleRes, farmRes] = await Promise.all([
    pool.query('SELECT * FROM room_schedules WHERE room_id = $1', [room.id]),
    pool.query('SELECT * FROM farms WHERE id = $1', [room.farm_id]),
  ]);
  const s = scheduleRes.rows[0];
  if (!s) return null;
  const farm = farmRes.rows[0];

  await pool.query(
    `UPDATE rooms SET last_config_sync_at = now()${boot ? ', last_boot_at = now()' : ''} WHERE id = $1`,
    [room.id]
  );

  return {
    roomId: room.id,
    roomName: room.name,
    farmId: farm ? farm.id : null,
    farmName: farm ? farm.name : null,
    trigger: { humidityBelow: s.humidity_below, tempAbove: Number(s.temp_above) },
    schedule: { windowStart: s.window_start, windowEnd: s.window_end, pollSeconds: s.poll_seconds },
    feed: {
      cycleWeeks: s.cycle_weeks,
      feedStartDate: s.feed_start_date,
      preWaterWaitMinutes: s.pre_water_wait_minutes,
      doseMl: s.dose_ml,
      mixRatioMlPerL: Number(s.feed_mix_ratio_ml_per_l),
      batchWaterL: Number(s.feed_batch_water_l),
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
      ready: !!farm && !farm.water_low && !farm.water_overflow
        && farm.tank_activity !== 'dechlorinating' && farm.tank_activity !== 'filling',
      low: farm ? farm.water_low : null,
    },
    scheduleVersion: s.schedule_version,
    plan: buildSevenDayPlan(s),
    syncedAt: new Date().toISOString(),
  };
}

async function ingestTelemetry(io, room, body) {
  const {
    humidity, tempC, raining, scheduleVersion,
    humiditySensor1, tempCSensor1, humiditySensor2, tempCSensor2,
    // Optional — a room board bench-wired with the farm's tank float
    // switches (no dedicated farm controller exists yet) reports these
    // alongside its own room telemetry. When present, they update the
    // room's own farm's tank state, same fields/event the real farm
    // device's telemetry would — see buildFarmDeviceRouter's /telemetry.
    waterLow, waterHigh,
  } = body || {};
  const inserts = [
    pool.query(
      `INSERT INTO room_telemetry
        (room_id, humidity, temp_c, humidity_sensor1, temp_c_sensor1, humidity_sensor2, temp_c_sensor2, raining)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [room.id, humidity, tempC,
        humiditySensor1 ?? null, tempCSensor1 ?? null, humiditySensor2 ?? null, tempCSensor2 ?? null,
        !!raining]
    ),
  ];
  if (scheduleVersion != null) {
    inserts.push(pool.query('UPDATE rooms SET synced_schedule_version = $2 WHERE id = $1', [room.id, scheduleVersion]));
  }
  if ((waterLow != null || waterHigh != null) && room.farm_id) {
    inserts.push(
      pool.query(
        `WITH old AS (SELECT tank_activity AS previous_tank_activity FROM farms WHERE id = $1)
         UPDATE farms SET
          water_low = COALESCE($2, water_low),
          water_full = COALESCE($3, water_full),
          -- No autofill valve is physically wired to any farm yet (see
          -- Config.h's ACTUATION_ENABLED note on the room side) — this is
          -- the decision a real farm controller would act on the instant
          -- one exists, made visible now rather than left unbuilt. Only
          -- starts a fill from 'idle' (never overrides 'dechlorinating' or
          -- an operator-set 'overflow'), and only autofill_enabled farms.
          tank_activity = CASE
            WHEN COALESCE($3, water_full) AND tank_activity = 'filling' THEN 'idle'
            WHEN COALESCE($2, water_low) AND autofill_enabled AND tank_activity = 'idle' THEN 'filling'
            ELSE tank_activity
          END,
          tank_filled_at = CASE
            WHEN COALESCE($2, water_low) AND autofill_enabled AND tank_activity = 'idle' THEN now()
            ELSE tank_filled_at
          END
         FROM old
         WHERE farms.id = $1
         RETURNING farms.*, old.previous_tank_activity`,
        [room.farm_id, waterLow ?? null, waterHigh ?? null]
      ).then((farmRes) => {
        const farm = farmRes.rows[0];
        if (!farm) return;
        io.to(`farm:${room.farm_id}`).emit('farm_telemetry', farm);
        if (farm.tank_activity !== farm.previous_tank_activity) {
          io.to(`farm:${room.farm_id}`).emit('farm_tank_status', { farmId: room.farm_id, activity: farm.tank_activity });
        }
      })
    );
  }
  const [reading] = await Promise.all(inserts);
  io.to(`room:${room.id}`).emit('room_telemetry', reading.rows[0]);
  return reading.rows[0];
}

async function ingestStatus(io, room, body) {
  const { activity } = body || {};
  if (!ROOM_ACTIVITIES.includes(activity)) {
    throw new Error(`activity must be one of ${ROOM_ACTIVITIES.join(', ')}`);
  }
  const { rows } = await pool.query(
    'UPDATE rooms SET mist_activity = $2, mist_activity_started_at = now() WHERE id = $1 RETURNING *',
    [room.id, activity]
  );
  io.to(`room:${room.id}`).emit('room_status', { roomId: room.id, activity: rows[0].mist_activity });
  return rows[0];
}

async function ingestEvent(io, room, body) {
  const { type, durationSeconds, volumeMl, meta } = body || {};
  if (!EVENT_TYPES.includes(type)) throw new Error(`type must be one of ${EVENT_TYPES.join(', ')}`);

  const { rows } = await pool.query(
    'INSERT INTO events (room_id, type, duration_seconds, volume_ml, meta) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [room.id, type, durationSeconds || null, volumeMl || null, meta || null]
  );
  if (type === 'fungicide_sprayed') {
    await pool.query('UPDATE room_schedules SET fungicide_last_sprayed_date = CURRENT_DATE WHERE room_id = $1', [room.id]);
  }
  io.to(`room:${room.id}`).emit('room_event', rows[0]);
  return rows[0];
}

async function ingestLogs(io, room, body) {
  const { logs } = body || {};
  if (!Array.isArray(logs) || logs.length === 0) throw new Error('logs must be a non-empty array');

  const rowsIn = logs.slice(0, 100).map((l) => ({
    level: LOG_LEVELS.includes(l?.level) ? l.level : 'info',
    message: String(l?.message ?? '').slice(0, 2000),
  }));
  const values = [];
  const params = [];
  rowsIn.forEach((r, i) => {
    params.push(room.id, r.level, r.message);
    values.push(`($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`);
  });
  const { rows: inserted } = await pool.query(
    `INSERT INTO device_logs (room_id, level, message) VALUES ${values.join(',')} RETURNING *`,
    params
  );
  io.to(`room:${room.id}`).emit('room_log_batch', inserted);
  return inserted;
}

// Water rig snapshots (plant/device/water): valves, pump, float levels,
// scale weight and the controller's status line. Kept in memory only - the
// board re-sends on every change plus a 60s heartbeat, so after a backend
// restart the dashboard is current again within a minute. History of what
// the rig did lives in device_logs / events already.
const latestWater = new Map(); // roomId -> snapshot

async function ingestWater(io, room, body) {
  const b = body || {};
  const snap = {
    roomId: room.id,
    inputValve: !!b.inputValve,
    outputValve: !!b.outputValve,
    pump: !!b.pump,
    fill: ['idle', 'filling', 'timeout'].includes(b.fill) ? b.fill : 'idle',
    pumpState: ['idle', 'opening', 'running', 'closing'].includes(b.pumpState) ? b.pumpState : 'idle',
    pumpSecondsLeft: Number.isFinite(b.pumpSecondsLeft) ? b.pumpSecondsLeft : -1,
    levelsKnown: !!b.levelsKnown,
    bottomWet: !!b.bottomWet,
    topWet: !!b.topWet,
    relayTest: !!b.relayTest,
    status: String(b.status ?? '').slice(0, 32),
    weightKg: Number.isFinite(b.weightKg) ? b.weightKg : null,
    fw: String(b.fw ?? '').slice(0, 24),
    receivedAt: new Date().toISOString(),
  };
  latestWater.set(room.id, snap);
  io.to(`room:${room.id}`).emit('room_water', snap);
  return snap;
}

function getLatestWater(roomId) {
  return latestWater.get(Number(roomId)) || null;
}

module.exports = {
  buildRoomConfigPayload, ingestTelemetry, ingestStatus, ingestEvent, ingestLogs, ingestWater, getLatestWater,
};
