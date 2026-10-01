const mqtt = require('mqtt');
const { pool } = require('./db');
const { resolveDeviceByKey } = require('./deviceAuth');
const {
  buildRoomConfigPayload, ingestTelemetry, ingestStatus, ingestEvent, ingestLogs, ingestWater,
} = require('./deviceIngest');

// Real ESP32 hardware talks MQTT instead of polling REST — a router on the
// devices' own WiFi network was blocking them from reaching this backend
// directly (AP/client isolation), and a cloud-hosted broker sidesteps that
// entirely since it's normal outbound internet traffic on both ends, not
// LAN-local device-to-device traffic. Topics:
//
//   plant/device/telemetry   device -> backend  (any room; body carries deviceKey)
//   plant/device/status      device -> backend
//   plant/device/events      device -> backend
//   plant/device/logs        device -> backend
//   plant/device/water       device -> backend  (water rig: valves, pump, levels, weight)
//   plant/device/<key>/config_request   device -> backend, on boot
//   plant/device/<key>/config   backend -> device, retained (latest schedule/plan)
//   plant/device/<key>/commands backend -> device (mist_now / pause / resume / skip_feed)
//
// The four inbound topics are shared across every room (not per-room) so a
// device only ever needs to know its own device_key, never a numeric room
// id — same shape as today's Bearer-key REST auth, just carried in the
// payload instead of a header.

const INBOUND_HANDLERS = {
  'plant/device/telemetry': ingestTelemetry,
  'plant/device/status': ingestStatus,
  'plant/device/events': ingestEvent,
  'plant/device/logs': ingestLogs,
  'plant/device/water': ingestWater,
};

let client = null;
let ioRef = null;

// Every topic that crosses the broker, either direction, lands in
// mqtt_messages and pushes live to anyone with the dashboard's MQTT
// Monitor tab open — see backend/src/routes/mqttMonitor.js and
// frontend's MqttMonitorPage. Distinct from device_logs (curated
// firmware log lines for one room) — this is raw wire traffic, every
// topic, unfiltered.
const MONITOR_ROOM = 'mqtt_monitor';

async function recordMessage(direction, topic, payload, roomId) {
  try {
    const { rows } = await pool.query(
      'INSERT INTO mqtt_messages (direction, topic, payload, room_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [direction, topic, payload, roomId || null]
    );
    if (ioRef) ioRef.to(MONITOR_ROOM).emit('mqtt_message', rows[0]);
  } catch (err) {
    console.error('[mqtt] failed to record message for monitor:', err.message);
  }
}

async function publishConfigForRoom(room, opts) {
  if (!client || !room?.device_key) return;
  const payload = await buildRoomConfigPayload(room, opts);
  if (!payload) return;
  const topic = `plant/device/${room.device_key}/config`;
  const body = JSON.stringify(payload);
  client.publish(topic, body, { qos: 1, retain: true });
  recordMessage('out', topic, body, room.id);
}

// Called from rooms.js whenever a room's schedule/pause state changes, or a
// command is queued — by room id, since callers there work with ids, not
// full device rows.
async function publishConfigForRoomId(roomId, opts) {
  if (!client) return;
  const { rows } = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
  if (rows[0]) await publishConfigForRoom(rows[0], opts);
}

async function publishCommandForRoomId(roomId, command) {
  if (!client) return;
  const { rows } = await pool.query('SELECT device_key FROM rooms WHERE id = $1', [roomId]);
  if (!rows[0]) return;
  const topic = `plant/device/${rows[0].device_key}/commands`;
  const body = JSON.stringify(command);
  client.publish(topic, body, { qos: 1 });
  recordMessage('out', topic, body, roomId);
}

async function handleInboundMessage(topic, payloadBuf) {
  const raw = payloadBuf.toString();
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    console.error('[mqtt] bad JSON on', topic);
    recordMessage('in', topic, raw, null);
    return;
  }

  if (topic.endsWith('/config_request')) {
    const deviceKey = topic.split('/')[2];
    const resolved = await resolveDeviceByKey(deviceKey);
    recordMessage('in', topic, raw, resolved?.kind === 'room' ? resolved.device.id : null);
    if (!resolved || resolved.kind !== 'room') return;
    await publishConfigForRoom(resolved.device, { boot: !!msg.boot });
    return;
  }

  const handler = INBOUND_HANDLERS[topic];
  if (!handler) {
    recordMessage('in', topic, raw, null);
    return;
  }

  const { deviceKey, ...body } = msg;
  const resolved = await resolveDeviceByKey(deviceKey);
  recordMessage('in', topic, raw, resolved?.kind === 'room' ? resolved.device.id : null);
  if (!resolved || resolved.kind !== 'room') {
    console.warn('[mqtt] message on', topic, 'with an unknown or non-room device key');
    return;
  }
  try {
    await handler(ioRef, resolved.device, body);
  } catch (err) {
    console.error('[mqtt] failed to handle', topic, 'for room', resolved.device.id, '-', err.message);
  }
}

function connectMqtt(io) {
  ioRef = io;
  const url = process.env.MQTT_URL;
  if (!url) {
    console.log('[mqtt] MQTT_URL not set — device MQTT bridge disabled (REST device API still works)');
    return;
  }

  client = mqtt.connect(url, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    reconnectPeriod: 3000,
    clientId: `plant-automation-backend-${Math.random().toString(16).slice(2, 10)}`,
  });

  client.on('connect', () => {
    console.log('[mqtt] connected to broker');
    client.subscribe(Object.keys(INBOUND_HANDLERS), { qos: 1 });
    client.subscribe('plant/device/+/config_request', { qos: 1 });
  });
  client.on('reconnect', () => console.log('[mqtt] reconnecting...'));
  client.on('error', (err) => console.error('[mqtt] error:', err.message));
  client.on('message', (topic, payloadBuf) => {
    handleInboundMessage(topic, payloadBuf).catch((err) => console.error('[mqtt] handler crashed:', err.message));
  });
}

module.exports = { connectMqtt, publishConfigForRoomId, publishCommandForRoomId };
