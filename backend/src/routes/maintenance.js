const express = require('express');
const { pool } = require('../db');
const { requireUser } = require('../auth');

const router = express.Router({ mergeParams: true });

function withDueInfo(task) {
  const last = task.last_completed_at ? new Date(task.last_completed_at) : null;
  const dueDate = last ? new Date(last.getTime() + task.recurrence_days * 86400000) : new Date();
  const daysLeft = Math.floor((dueDate - new Date()) / 86400000);
  return { ...task, dueDate, daysLeft, overdue: daysLeft < 0 };
}

router.get('/', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM maintenance_tasks WHERE unit_id = $1 ORDER BY recurrence_days',
    [req.params.unitId]
  );
  res.json(rows.map(withDueInfo));
});

router.post('/:taskId/complete', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE maintenance_tasks SET last_completed_at = now() WHERE id = $1 AND unit_id = $2 RETURNING *',
    [req.params.taskId, req.params.unitId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'task not found' });

  await pool.query(
    'INSERT INTO events (unit_id, type, meta) VALUES ($1,$2,$3)',
    [req.params.unitId, 'maintenance_done', JSON.stringify({ task: rows[0].title })]
  );

  res.json(withDueInfo(rows[0]));
});

module.exports = router;
