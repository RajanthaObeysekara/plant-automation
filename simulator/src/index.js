// Plays the role of every ESP32 controller in the fleet, in one process:
// - a ROOM controller per greenhouse — one shared environment sensor,
//   drives misting for every bench in it together.
// - a FARM controller per site — one shared water tank + fertigation rig
//   (mix/stir/filter/dose), used on behalf of whichever room's feed day it
//   is. Only one room can use the rig at a time (see withFarmLock).
// Sensor baselines track real current weather at each farm's location
// (weather.js) instead of being made up.
const { Pool } = require('pg');
const { shouldMist, feedPhase, fungicideDue } = require('./rules');
const weather = require('./weather');

const BACKEND_URL = process.env.BACKEND_URL || 'http://backend:4000';
const DATABASE_URL = process.env.DATABASE_URL;
const DISCOVERY_REFRESH_MS = Number(process.env.DISCOVERY_REFRESH_MS) || 60000;
const WEATHER_REFRESH_MS = Number(process.env.WEATHER_REFRESH_MS) || 15 * 60 * 1000;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 20000;
const POLL_JITTER_MS = Number(process.env.POLL_JITTER_MS) || 10000;
// A manual dashboard action (Fill/Drain now, Mist room now) waits on this
// instead of the full 20-30s telemetry/config cycle above — real firmware
// can afford to check "any command waiting?" far more often than it does a
// full sensor+config sync, and a button that visibly does nothing for up to
// 30s reads as broken even though it was always going to work eventually.
const COMMAND_POLL_MS = Number(process.env.COMMAND_POLL_MS) || 3000;
const MIST_DURATION_SECONDS = Number(process.env.MIST_DURATION_SECONDS) || 20;
const MIX_WAIT_MS = Number(process.env.MIX_WAIT_MS) || 3000;
const STIR_WAIT_MS = Number(process.env.STIR_WAIT_MS) || 2000;
const FILTER_WAIT_MS = Number(process.env.FILTER_WAIT_MS) || 1500;
const DOSE_WAIT_MS = Number(process.env.DOSE_WAIT_MS) || 3000;
// 90s of demo time stands in for the real default of 24h — kept as a ratio
// so that changing "Dechlorination hold (days)" in Tank Settings actually
// changes simulated behavior instead of being ignored.
const DEMO_DECHLORINATE_MS = Number(process.env.DEMO_DECHLORINATE_MS) || 90 * 1000;
const DECHLORINATE_MS_PER_HOUR = DEMO_DECHLORINATE_MS / 24;
// Long enough to span at least one full room poll cycle, so "tank is empty"
// is a real, observable state rooms can see and correctly refuse to mist
// against — not a same-tick flicker that's invisible in practice.
const DEMO_FILL_MS = Number(process.env.DEMO_FILL_MS) || 45 * 1000;

if (!DATABASE_URL) {
  console.error('[simulator] DATABASE_URL is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function jitter(spread) { return (Math.random() - 0.5) * 2 * spread; }
function round1(v) { return Math.round(v * 10) / 10; }
function todayKey(now) { return now.toISOString().slice(0, 10); }
// Normalizes a DB date/timestamp value (or null) to the same "YYYY-MM-DD"
// shape as todayKey(), so a persisted date and an in-memory one compare
// equal regardless of whether Postgres/JSON round-tripped it as a bare
// date string or a full ISO timestamp.
function dateKey(value) { return value == null ? null : new Date(value).toISOString().slice(0, 10); }

const runningRooms = new Set();
const runningFarms = new Set();
const farmLocks = new Map(); // farmId -> promise chain tail, serializes the shared rig
const farmHandles = new Map(); // farmId -> { requestFeed(room, feedConfig) }

function withFarmLock(farmId, fn) {
  const prev = farmLocks.get(farmId) || Promise.resolve();
  const run = prev.then(fn, fn);
  farmLocks.set(farmId, run.catch(() => {}));
  return run;
}

async function api(deviceKey, pathname, options = {}) {
  const res = await fetch(`${BACKEND_URL}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deviceKey}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Fixed per-tank load-cell characteristics used only to generate a
// plausible, internally-consistent raw ADC signal for the "capture live
// reading" calibration flow — real hardware would report its own numbers.
const TANK_SIM = {
  water: { tareRaw: 8_400_000, scaleCountsPerG: 23.5, maxWeightG: 50000 },
  fertilizer_early: { tareRaw: 412_000, scaleCountsPerG: 118.2, maxWeightG: 20000 },
  fertilizer_late: { tareRaw: 296_000, scaleCountsPerG: 104.7, maxWeightG: 20000 },
  fungicide: { tareRaw: 305_000, scaleCountsPerG: 96.4, maxWeightG: 8000 },
};
function rawCountsFor(tankKey, pct) {
  const t = TANK_SIM[tankKey];
  const weightG = t.maxWeightG * clamp(pct, 0, 100) / 100;
  return Math.round(t.tareRaw + weightG * t.scaleCountsPerG + jitter(6));
}
// Inverse of rawCountsFor — recovers a level from the last raw counts a farm
// reported. A real load cell still reads the physical weight in the tank
// after a controller reboot; without this, restarting the simulator (which
// happens on every deploy) would silently "refill" every tank in memory,
// wiping out a real low/empty state and any manual drain used for testing.
function pctFromRawCounts(tankKey, raw) {
  if (raw == null) return null;
  const t = TANK_SIM[tankKey];
  const weightG = (raw - t.tareRaw) / t.scaleCountsPerG;
  return clamp((weightG / t.maxWeightG) * 100, 0, 100);
}

function simulateReading(now, farmName) {
  const w = weather.getBaseline(farmName);
  const hour = now.getHours() + now.getMinutes() / 60;
  const dayPhase = Math.sin(((hour - 6) / 24) * 2 * Math.PI);
  const humidity = clamp(w.humidity - dayPhase * 12 + jitter(4), 25, 98);
  const tempC = clamp(w.tempC + dayPhase * 4 + jitter(1), 18, 40);
  const raining = w.precipitationMm > 0 ? Math.random() < 0.5 : Math.random() < 0.02;
  return { humidity: round1(humidity), tempC: round1(tempC), raining };
}

// ---------- Farm controller: shared tank + fertigation rig ----------
function runFarm(farm) {
  const { device_key: deviceKey, name: label } = farm;
  // Seed each tank's level from the last raw counts this farm reported, so a
  // simulator restart doesn't silently undo a real low/empty state or a
  // manual drain. Only a farm that has never reported (brand new, no
  // raw_*_counts yet) falls back to a plausible random starting level.
  let waterPct = pctFromRawCounts('water', farm.raw_water_counts) ?? (60 + Math.random() * 30);
  let fertEarlyPct = pctFromRawCounts('fertilizer_early', farm.raw_fertilizer_early_counts) ?? (50 + Math.random() * 40);
  let fertLatePct = pctFromRawCounts('fertilizer_late', farm.raw_fertilizer_late_counts) ?? (50 + Math.random() * 40);
  let fungicidePct = pctFromRawCounts('fungicide', farm.raw_fungicide_counts) ?? (70 + Math.random() * 25);
  let tankFilledAt = farm.tank_filled_at ? new Date(farm.tank_filled_at).getTime() : Date.now() - 25 * 3600 * 1000;
  let filling = false;

  function levelFor(tankKey) {
    if (tankKey === 'water') return waterPct;
    if (tankKey === 'fertilizer_early') return fertEarlyPct;
    if (tankKey === 'fertilizer_late') return fertLatePct;
    return fungicidePct;
  }
  function setLevel(tankKey, pct) {
    if (tankKey === 'water') waterPct = pct;
    else if (tankKey === 'fertilizer_early') fertEarlyPct = pct;
    else if (tankKey === 'fertilizer_late') fertLatePct = pct;
    else fungicidePct = pct;
  }

  async function setTankStatus(activity) {
    try {
      await api(deviceKey, '/api/device/farm/tank-status', { method: 'POST', body: JSON.stringify({ activity }) });
    } catch (err) {
      console.warn(`[farm:${label}] tank-status push failed:`, err.message);
    }
  }
  async function setFertStatus(activity, roomId, source) {
    try {
      await api(deviceKey, '/api/device/farm/fert-status', { method: 'POST', body: JSON.stringify({ activity, roomId, source }) });
    } catch (err) {
      console.warn(`[farm:${label}] fert-status push failed:`, err.message);
    }
  }

  // Manual overrides from the dashboard — "fill_water", "drain_fertilizer_early",
  // etc. Drain is software-only (no drain valve in the physical build);
  // it's here so a calibration pass can start from a known-empty tank.
  // Polled on its own fast COMMAND_POLL_MS loop (see bottom of runFarm), not
  // the slower tank tick — a dashboard button needs to visibly react in a
  // couple of seconds, not wait for the next full sensor cycle.
  async function handleCommands() {
    let commands;
    try {
      commands = await api(deviceKey, '/api/device/farm/commands');
    } catch (err) {
      console.warn(`[farm:${label}] command poll failed:`, err.message);
      return;
    }
    let changed = false;
    for (const cmd of commands) {
      const sep = cmd.type.indexOf('_');
      const action = cmd.type.slice(0, sep);
      const tankKey = cmd.type.slice(sep + 1);
      if (!TANK_SIM[tankKey]) continue;
      const pct = action === 'fill' ? 100 : action === 'drain' ? 0 : null;
      if (pct == null) continue;
      setLevel(tankKey, pct);
      if (tankKey === 'water' && pct === 100) tankFilledAt = Date.now();
      console.log(`[farm:${label}] manual ${action} — ${tankKey} tank set to ${pct}%`);
      changed = true;
    }
    // Push the new level out immediately instead of waiting for the next
    // tank tick — this is what actually makes the dashboard's fill bar and
    // limit-switch animations react right after the button click.
    if (changed) {
      await postWaterTelemetry(waterPct <= 15, waterPct >= 98, false);
    }
  }

  // A room's mist cycle calls this with the volume it actually just used —
  // real usage is now the dominant driver of tank drain, not an arbitrary
  // timer. A small passive evaporation/leak rate is layered on top of that
  // in tickTank() for realism, but usage is what actually moves the needle.
  function consumeWater(volumeMl) {
    const pctUsed = (volumeMl / TANK_SIM.water.maxWeightG) * 100; // water ≈ 1 g/mL
    waterPct = Math.max(0, waterPct - pctUsed);
  }

  async function postWaterTelemetry(low, full, overflow = false) {
    try {
      await api(deviceKey, '/api/device/farm/telemetry', {
        method: 'POST',
        body: JSON.stringify({
          waterLow: low, waterFull: full, waterOverflow: overflow,
          rawWaterCounts: rawCountsFor('water', waterPct),
          rawFertilizerEarlyCounts: rawCountsFor('fertilizer_early', fertEarlyPct),
          rawFertilizerLateCounts: rawCountsFor('fertilizer_late', fertLatePct),
          rawFungicideCounts: rawCountsFor('fungicide', fungicidePct),
        }),
      });
    } catch (err) {
      console.warn(`[farm:${label}] tank telemetry push failed:`, err.message);
    }
  }

  let lastEmptyReminderOn = null;

  async function tickTank() {
    // Live settings — re-read every tick so editing Tank Settings in the
    // dashboard actually changes simulated behavior instead of being
    // silently ignored.
    let cfg = null;
    try {
      cfg = await api(deviceKey, '/api/device/farm/config');
    } catch (err) {
      console.warn(`[farm:${label}] config sync failed:`, err.message);
    }
    const autofillEnabled = cfg ? cfg.autofillEnabled : true;
    const dechlorinateHours = cfg ? cfg.dechlorinateHours : 24;

    // Small passive evaporation/leak — real usage (consumeWater, called from
    // each room's mist cycle) is the dominant drain now, not this.
    if (!filling) waterPct = Math.max(0, waterPct - Math.random() * 0.06);
    fertEarlyPct = Math.max(0, fertEarlyPct - Math.random() * 0.02);
    fertLatePct = Math.max(0, fertLatePct - Math.random() * 0.02);
    fungicidePct = Math.max(0, fungicidePct - Math.random() * 0.01);

    const low = waterPct <= 15;
    const dechlorinateMs = Math.max(5000, dechlorinateHours * DECHLORINATE_MS_PER_HOUR);
    const dechlorinating = Date.now() - tankFilledAt < dechlorinateMs;

    if (low && !filling) {
      // Report the empty tank *immediately*, before attempting anything —
      // this is the state a room polling right now needs to see, and it's
      // what was missing before: the old code refilled first and reported
      // after, so "empty" was never actually observable.
      await postWaterTelemetry(true, waterPct >= 98);

      if (!autofillEnabled) {
        await setTankStatus('idle');
        if (lastEmptyReminderOn !== todayKey(new Date())) {
          lastEmptyReminderOn = todayKey(new Date());
          console.log(`[farm:${label}] water tank empty and autofill is off — staying empty until manually filled`);
          await api(deviceKey, '/api/device/farm/events', {
            method: 'POST',
            body: JSON.stringify({ type: 'tank_empty_no_autofill', meta: { waterPct: Math.round(waterPct) } }),
          }).catch(() => {});
        }
        return { ready: false };
      }

      filling = true;
      await setTankStatus('filling');
      await sleep(DEMO_FILL_MS);
      waterPct = 100;
      tankFilledAt = Date.now();
      filling = false;
      await api(deviceKey, '/api/device/farm/events', {
        method: 'POST',
        body: JSON.stringify({ type: 'autofill', durationSeconds: Math.round(DEMO_FILL_MS / 1000), meta: { simulated: true } }),
      }).catch(() => {});
      await setTankStatus('idle');
      await postWaterTelemetry(false, true);
      return { ready: true };
    }

    if (filling) {
      await setTankStatus('filling');
    } else if (dechlorinating) {
      await setTankStatus('dechlorinating');
    } else {
      await setTankStatus('idle');
    }
    await postWaterTelemetry(low, waterPct >= 98);
    return { ready: !dechlorinating && !low && !filling };
  }

  // Called by a room's loop when it's that room's feed day. Serialized per
  // farm — only one room's dose runs through the shared rig at a time.
  // Draws from whichever stock tank matches the rotation week (weeks 1-2 =
  // early-phase product, weeks 3+ = late-phase) — two different NPK
  // formulas can't share one stock tank, only the shared mixing rig.
  async function requestFeed(room, feedConfig, weekNumber) {
    return withFarmLock(farm.id, async () => {
      const { doseMl, mixRatioMlPerL, batchWaterL } = feedConfig;
      const source = weekNumber <= 2 ? 'fertilizer_early' : 'fertilizer_late';
      const concentrateMl = Math.round((mixRatioMlPerL || 5) * (batchWaterL || 50));
      const neededPct = (concentrateMl / TANK_SIM[source].maxWeightG) * 100;

      // Real check: don't pretend a dose happened if the stock tank can't
      // actually cover it — matches the water-tank-empty fix, just for the
      // fertilizer side.
      if (levelFor(source) < neededPct) {
        console.warn(`[farm:${label}] ${source} stock too low for ${room.name} (need ~${neededPct.toFixed(1)}%, have ${levelFor(source).toFixed(1)}%) — skipping dose`);
        await api(deviceKey, '/api/device/farm/events', {
          method: 'POST',
          body: JSON.stringify({
            type: 'fert_stock_low', roomId: room.id,
            meta: { source, neededPct: Math.round(neededPct * 10) / 10, availablePct: Math.round(levelFor(source) * 10) / 10 },
          }),
        }).catch(() => {});
        return;
      }

      const startedAt = Date.now();
      console.log(`[farm:${label}] fertigation cycle starting for ${room.name} (week ${weekNumber}, ${source})`);

      await setFertStatus('mixing', room.id, source);
      await sleep(MIX_WAIT_MS);
      await setFertStatus('stirring', room.id, source);
      await sleep(STIR_WAIT_MS);
      await setFertStatus('filtering', room.id, source);
      await sleep(FILTER_WAIT_MS);
      await setFertStatus('feeding', room.id, source);
      await sleep(DOSE_WAIT_MS);

      setLevel(source, Math.max(0, levelFor(source) - neededPct));

      await api(deviceKey, '/api/device/farm/events', {
        method: 'POST',
        body: JSON.stringify({
          type: 'feed',
          roomId: room.id,
          durationSeconds: Math.round((Date.now() - startedAt) / 1000),
          volumeMl: doseMl,
          meta: { concentrateMl, batchWaterL, mixRatioMlPerL, source },
        }),
      });
      await setFertStatus('idle', null, null);
    });
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await tickTank();
    } finally {
      ticking = false;
    }
  }

  const interval = POLL_INTERVAL_MS + Math.round(Math.random() * POLL_JITTER_MS);
  const startDelay = Math.round(Math.random() * POLL_INTERVAL_MS);
  setTimeout(() => { tick(); setInterval(tick, interval); }, startDelay);
  console.log(`[farm:${label}] scheduled — tank poll≈${interval}ms, command poll≈${COMMAND_POLL_MS}ms`);

  let commandTicking = false;
  setInterval(() => {
    if (commandTicking) return;
    commandTicking = true;
    handleCommands()
      .catch((err) => console.warn(`[farm:${label}] command poll failed:`, err.message))
      .finally(() => { commandTicking = false; });
  }, COMMAND_POLL_MS);

  farmHandles.set(farm.id, { requestFeed, consumeWater });
}

// ---------- Room controller: shared env sensor + misting ----------
function runRoom(room) {
  const { device_key: deviceKey, name: label, farm_name: farmName, farm_id: farmId } = room;
  let cachedConfig = null;
  let lastMistAt = 0;
  let lastFedOn = null;
  let lastFungicideReminderOn = null;
  let lastSkippedReminderOn = null;
  const MIST_COOLDOWN_MS = 5 * 60 * 1000;

  async function setStatus(activity) {
    try {
      await api(deviceKey, '/api/device/room/status', { method: 'POST', body: JSON.stringify({ activity }) });
    } catch (err) {
      console.warn(`[room:${label}] status push failed:`, err.message);
    }
  }

  async function runMist(now, reading) {
    lastMistAt = now.getTime();
    await setStatus('misting');
    await sleep(MIST_DURATION_SECONDS * 1000);
    const pumpFlowLpm = Number(cachedConfig.pumpFlowLpm) || 4.5;
    const volumeMl = Math.round(pumpFlowLpm * (MIST_DURATION_SECONDS / 60) * 1000);
    await api(deviceKey, '/api/device/room/events', {
      method: 'POST',
      body: JSON.stringify({ type: 'mist', durationSeconds: MIST_DURATION_SECONDS, volumeMl, meta: reading }),
    });
    farmHandles.get(farmId)?.consumeWater(volumeMl);

    // Misting itself is done — always return this room to idle here. If a
    // feed cycle starts next, its progress is tracked separately via the
    // farm's fert_activity (roomActivity() in the UI overlays that on top
    // of this room's own status) — this room's status must not stay
    // "misting" while the farm's shared rig runs, or forever after if that
    // request fails/is skipped for any reason (e.g. low stock).
    await setStatus('idle');

    if (!cachedConfig.skipFeedOnce) {
      const feed = feedPhase(now, cachedConfig.feed);
      // Checked against BOTH the in-memory cache (fast, covers the gap
      // before the next config refresh reflects a feed just posted) and the
      // persisted lastFedDate (survives a simulator restart) — an
      // in-memory-only guard would re-dose every room whose feed day
      // matches today the instant the process restarts, silently draining
      // the fertilizer stock tanks.
      const alreadyFedToday = lastFedOn === todayKey(now) || dateKey(cachedConfig.feed.lastFedDate) === todayKey(now);
      if (feed.isFeedDay && !alreadyFedToday) {
        const farm = farmHandles.get(farmId);
        if (farm) {
          lastFedOn = todayKey(now);
          await farm.requestFeed(room, cachedConfig.feed, feed.weekNumber);
        }
      }
    }
  }

  async function checkFungicide(now) {
    if (!fungicideDue(now, cachedConfig.fungicide)) return;
    if (lastFungicideReminderOn === todayKey(now)) return;
    lastFungicideReminderOn = todayKey(now);
    await api(deviceKey, '/api/device/room/events', {
      method: 'POST',
      body: JSON.stringify({ type: 'fungicide_reminder', meta: { lastSprayedDate: cachedConfig.fungicide.lastSprayedDate } }),
    }).catch(() => {});
  }

  // Polled on its own fast COMMAND_POLL_MS loop (see bottom of runRoom), not
  // the slower config/telemetry tick — "Mist room now" needs to visibly
  // react in a couple of seconds, not wait for the next full sync cycle.
  async function handleCommands() {
    if (!cachedConfig) return; // no config synced yet — nothing to check readiness against
    const tankOk = cachedConfig.tank?.ready === true;
    const commands = await api(deviceKey, '/api/device/room/commands');
    for (const cmd of commands) {
      if (cmd.type !== 'mist_now') continue;
      if (tankOk) {
        const now = new Date();
        await runMist(now, simulateReading(now, farmName));
      } else {
        // A manual "Mist now" was requested but the shared tank isn't
        // ready — the command still gets marked delivered by the backend,
        // so without this the click would silently do nothing.
        console.log(`[room:${label}] manual mist request ignored — farm tank not ready`);
        await api(deviceKey, '/api/device/room/events', {
          method: 'POST',
          body: JSON.stringify({ type: 'mist_skipped', meta: { reason: cachedConfig.tank?.low ? 'tank_low' : 'tank_not_ready', manual: true } }),
        }).catch(() => {});
      }
    }
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = new Date();
      try {
        cachedConfig = await api(deviceKey, '/api/device/room/config');
      } catch (err) {
        console.warn(`[room:${label}] sync failed:`, err.message);
        if (!cachedConfig) return;
      }

      const reading = simulateReading(now, farmName);
      try {
        await api(deviceKey, '/api/device/room/telemetry', {
          method: 'POST',
          body: JSON.stringify({ humidity: reading.humidity, tempC: reading.tempC, raining: reading.raining }),
        });
      } catch (err) {
        console.warn(`[room:${label}] telemetry push failed:`, err.message);
      }

      // Strict: only proceed on an explicit "ready", never on "not
      // explicitly false" — a missing/malformed tank field should fail
      // closed (don't mist), not fail open.
      const tankOk = cachedConfig.tank?.ready === true;
      const cooledDown = now.getTime() - lastMistAt > MIST_COOLDOWN_MS;
      const wantsToMist = cooledDown && shouldMist(now, reading, cachedConfig);
      if (tankOk && wantsToMist) {
        try {
          await runMist(now, reading);
        } catch (err) {
          console.warn(`[room:${label}] mist cycle failed:`, err.message);
        }
      } else if (!tankOk && wantsToMist && lastSkippedReminderOn !== todayKey(now)) {
        // Would have misted, but the shared tank isn't ready — surface this
        // instead of silently doing nothing, throttled to once a day.
        lastSkippedReminderOn = todayKey(now);
        console.log(`[room:${label}] mist skipped — farm tank not ready (${cachedConfig.tank?.low ? 'low' : 'not ready'})`);
        await api(deviceKey, '/api/device/room/events', {
          method: 'POST',
          body: JSON.stringify({ type: 'mist_skipped', meta: { reason: cachedConfig.tank?.low ? 'tank_low' : 'tank_not_ready' } }),
        }).catch(() => {});
      }

      try {
        await checkFungicide(now);
      } catch (err) {
        console.warn(`[room:${label}] fungicide check failed:`, err.message);
      }
    } finally {
      ticking = false;
    }
  }

  const interval = POLL_INTERVAL_MS + Math.round(Math.random() * POLL_JITTER_MS);
  const startDelay = Math.round(Math.random() * POLL_INTERVAL_MS);
  setTimeout(() => { tick(); setInterval(tick, interval); }, startDelay);
  console.log(`[room:${label}] scheduled — poll≈${interval}ms, first run in ${startDelay}ms, command poll≈${COMMAND_POLL_MS}ms`);

  let commandTicking = false;
  setInterval(() => {
    if (commandTicking) return;
    commandTicking = true;
    handleCommands()
      .catch((err) => console.warn(`[room:${label}] command poll failed:`, err.message))
      .finally(() => { commandTicking = false; });
  }, COMMAND_POLL_MS);
}

async function discoverAndStart() {
  const [farms, rooms] = await Promise.all([
    pool.query(
      `SELECT id, device_key, name, tank_filled_at,
              raw_water_counts, raw_fertilizer_early_counts, raw_fertilizer_late_counts, raw_fungicide_counts
       FROM farms`
    ),
    pool.query(
      `SELECT r.id, r.device_key, r.name, r.farm_id, f.name AS farm_name
       FROM rooms r JOIN farms f ON f.id = r.farm_id`
    ),
  ]);

  const farmNames = [...new Set(farms.rows.map((f) => f.name))];
  await weather.refreshAll(farmNames);
  if (!discoverAndStart.weatherTimerStarted) {
    discoverAndStart.weatherTimerStarted = true;
    setInterval(() => weather.refreshAll(farmNames), WEATHER_REFRESH_MS);
  }

  let startedFarms = 0;
  for (const farm of farms.rows) {
    if (runningFarms.has(farm.device_key)) continue;
    runningFarms.add(farm.device_key);
    runFarm(farm);
    startedFarms += 1;
  }

  let startedRooms = 0;
  for (const room of rooms.rows) {
    if (runningRooms.has(room.device_key)) continue;
    if (!farmHandles.has(room.farm_id)) continue; // farm loop not registered yet — pick it up next discovery pass
    runningRooms.add(room.device_key);
    runRoom(room);
    startedRooms += 1;
  }

  console.log(`[simulator] ${startedFarms} farm(s) + ${startedRooms} room(s) newly started (${farms.rows.length} farms, ${rooms.rows.length} rooms total)`);
}

async function main() {
  console.log(`[simulator] starting — backend=${BACKEND_URL}`);
  await discoverAndStart();
  // A farm's loop registers its handle synchronously in runFarm(), but a
  // room whose farm was JUST discovered this same pass still needs one more
  // pass to see it — cheap, and only matters right after a fresh install.
  await discoverAndStart();
  setInterval(discoverAndStart, DISCOVERY_REFRESH_MS);
}

main().catch((err) => {
  console.error('[simulator] fatal error', err);
  process.exit(1);
});
