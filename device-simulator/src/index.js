const fs = require('fs');
const path = require('path');
const { shouldMist, feedPhase, fungicideDue } = require('./rules');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
const DEVICE_KEY = process.env.DEVICE_KEY;
const UNIT_LABEL = process.env.UNIT_LABEL || 'unit';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 15000;
const MIST_DURATION_SECONDS = Number(process.env.MIST_DURATION_SECONDS) || 20;
const PUMP_FLOW_LPM = Number(process.env.PUMP_FLOW_LPM) || 4.5;
// Real firmware waits the full preWaterWaitMinutes between the water and feed
// steps; that's too slow to watch locally, so the simulator uses a short,
// explicitly-labelled stand-in instead.
const FEED_WAIT_MS = Number(process.env.FEED_WAIT_MS) || 5000;

const CACHE_PATH = path.join(__dirname, '..', 'data', 'config.json');

if (!DEVICE_KEY) {
  console.error(`[${UNIT_LABEL}] DEVICE_KEY is required`);
  process.exit(1);
}

let cachedConfig = loadCache();
let lastMistAt = 0;
let lastFedOn = null;
let lastFungicideReminderOn = null;
const MIST_COOLDOWN_MS = 5 * 60 * 1000;

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveCache(config) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(config, null, 2));
  } catch (err) {
    console.warn(`[${UNIT_LABEL}] could not persist local cache:`, err.message);
  }
}

async function api(pathname, options = {}) {
  const res = await fetch(`${BACKEND_URL}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${DEVICE_KEY}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function simulateReading(now) {
  const hour = now.getHours() + now.getMinutes() / 60;
  // Rough day cycle for a Kadawatha veranda: humid + cool before dawn,
  // driest and warmest mid-afternoon.
  const dayPhase = Math.sin(((hour - 6) / 24) * 2 * Math.PI);
  const humidity = clamp(75 - dayPhase * 18 + jitter(4), 30, 95);
  const tempC = clamp(28 + dayPhase * 5 + jitter(1), 22, 38);
  const raining = Math.random() < 0.03;
  return { humidity: round1(humidity), tempC: round1(tempC), raining };
}

function jitter(spread) {
  return (Math.random() - 0.5) * 2 * spread;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function round1(v) {
  return Math.round(v * 10) / 10;
}
function todayKey(now) {
  return now.toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setStatus(activity) {
  try {
    await api('/api/device/status', { method: 'POST', body: JSON.stringify({ activity }) });
  } catch (err) {
    console.warn(`[${UNIT_LABEL}] status push failed:`, err.message);
  }
}

async function runMist(now, reading, forced) {
  const durationSeconds = MIST_DURATION_SECONDS;
  const volumeMl = Math.round(PUMP_FLOW_LPM * (durationSeconds / 60) * 1000);
  console.log(
    `[${UNIT_LABEL}] misting ${durationSeconds}s (~${volumeMl} mL)${forced ? ' [manual override]' : ''} — humidity=${reading.humidity}% temp=${reading.tempC}C`
  );
  lastMistAt = now.getTime();

  await setStatus('misting');
  await sleep(durationSeconds * 1000); // the pump is actually running for this long
  await api('/api/device/events', {
    method: 'POST',
    body: JSON.stringify({ type: 'mist', durationSeconds, volumeMl, meta: { forced: !!forced, ...reading } }),
  });

  let fedThisRun = false;
  if (!cachedConfig.skipFeedOnce) {
    const feed = feedPhase(now, cachedConfig.feed);
    if (feed.isFeedDay && lastFedOn !== todayKey(now)) {
      console.log(`[${UNIT_LABEL}] feed day (week ${feed.weekNumber}/${cachedConfig.feed.cycleWeeks}) — waiting before dosing`);
      await setStatus('feeding');
      await sleep(FEED_WAIT_MS);
      await runFeed(new Date());
      lastFedOn = todayKey(now);
      fedThisRun = true;
    }
  }
  if (!fedThisRun) await setStatus('idle');
}

async function runFeed(now) {
  const doseMl = cachedConfig.feed.doseMl;
  console.log(`[${UNIT_LABEL}] feeding — dosing ${doseMl} mL`);
  await api('/api/device/events', {
    method: 'POST',
    body: JSON.stringify({ type: 'feed', durationSeconds: 10, volumeMl: doseMl, meta: { at: now.toISOString() } }),
  });
  await setStatus('idle');
}

async function checkFungicide(now) {
  if (!fungicideDue(now, cachedConfig.fungicide)) return;
  if (lastFungicideReminderOn === todayKey(now)) return;
  lastFungicideReminderOn = todayKey(now);
  console.log(`[${UNIT_LABEL}] fungicide spray is due — reminder raised`);
  await api('/api/device/events', {
    method: 'POST',
    body: JSON.stringify({ type: 'fungicide_reminder', meta: { lastSprayedDate: cachedConfig.fungicide.lastSprayedDate } }),
  });
}

async function handleCommands() {
  const commands = await api('/api/device/commands');
  for (const cmd of commands) {
    console.log(`[${UNIT_LABEL}] command received: ${cmd.type}`);
    if (cmd.type === 'mist_now') {
      const now = new Date();
      await runMist(now, simulateReading(now), true);
    }
  }
}

async function tick() {
  const now = new Date();

  try {
    cachedConfig = await api('/api/device/config');
    saveCache(cachedConfig);
  } catch (err) {
    console.warn(`[${UNIT_LABEL}] sync failed, running on last cached config:`, err.message);
    if (!cachedConfig) return; // never synced successfully — nothing to act on yet
  }

  const reading = simulateReading(now);
  try {
    await api('/api/device/telemetry', {
      method: 'POST',
      body: JSON.stringify({ humidity: reading.humidity, tempC: reading.tempC, raining: reading.raining }),
    });
  } catch (err) {
    console.warn(`[${UNIT_LABEL}] telemetry push failed:`, err.message);
  }

  try {
    await handleCommands();
  } catch (err) {
    console.warn(`[${UNIT_LABEL}] command poll failed:`, err.message);
  }

  const cooledDown = now.getTime() - lastMistAt > MIST_COOLDOWN_MS;
  if (cooledDown && shouldMist(now, reading, cachedConfig)) {
    try {
      await runMist(now, reading, false);
    } catch (err) {
      console.warn(`[${UNIT_LABEL}] mist cycle failed:`, err.message);
    }
  }

  try {
    await checkFungicide(now);
  } catch (err) {
    console.warn(`[${UNIT_LABEL}] fungicide check failed:`, err.message);
  }
}

let ticking = false;
async function safeTick() {
  if (ticking) return; // a mist/feed cycle from the last tick is still running
  ticking = true;
  try {
    await tick();
  } finally {
    ticking = false;
  }
}

console.log(`[${UNIT_LABEL}] starting — backend=${BACKEND_URL} poll=${POLL_INTERVAL_MS}ms`);
safeTick();
setInterval(safeTick, POLL_INTERVAL_MS);
