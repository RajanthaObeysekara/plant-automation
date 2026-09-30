const express = require('express');
const { pool } = require('../db');
const { requireUser } = require('../auth');

// History for the dashboard's MQTT Monitor tab — live updates arrive
// separately over the 'mqtt_monitor' Socket.IO room (see backend/src/mqtt.js
// and index.js's subscribe_mqtt_monitor handler); this is just what to show
// on first load, before any new messages have come in.
function buildMqttMonitorRouter() {
  const router = express.Router();

  router.get('/messages', requireUser, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const { rows } = await pool.query(
      `SELECT m.id, m.direction, m.topic, m.payload, m.room_id, m.created_at, r.name AS room_name
       FROM mqtt_messages m
       LEFT JOIN rooms r ON r.id = m.room_id
       ORDER BY m.created_at DESC, m.id DESC LIMIT $1`,
      [limit]
    );
    res.json(rows.reverse());
  });

  return router;
}

module.exports = buildMqttMonitorRouter;
