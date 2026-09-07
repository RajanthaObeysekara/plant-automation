const express = require('express');
const { pool } = require('../db');
const { requireUser } = require('../auth');

const router = express.Router();

router.get('/', requireUser, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM templates ORDER BY name');
  res.json(rows);
});

router.patch('/:id', requireUser, async (req, res) => {
  const b = req.body || {};
  const { rows } = await pool.query(
    `UPDATE templates SET
      humidity_below = COALESCE($2, humidity_below),
      temp_above = COALESCE($3, temp_above),
      window_start = COALESCE($4, window_start),
      window_end = COALESCE($5, window_end),
      cycle_weeks = COALESCE($6, cycle_weeks),
      pre_water_wait_minutes = COALESCE($7, pre_water_wait_minutes),
      dose_ml = COALESCE($8, dose_ml),
      fungicide_interval_days = COALESCE($9, fungicide_interval_days),
      feed_product_early = COALESCE($10, feed_product_early),
      feed_product_late = COALESCE($11, feed_product_late),
      fungicide_product = COALESCE($12, fungicide_product),
      fungicide_dose_ml = COALESCE($13, fungicide_dose_ml),
      fungicide_automated = COALESCE($14, fungicide_automated),
      feed_mix_ratio_ml_per_l = COALESCE($15, feed_mix_ratio_ml_per_l),
      feed_batch_water_l = COALESCE($16, feed_batch_water_l),
      fungicide_mix_ratio_ml_per_l = COALESCE($17, fungicide_mix_ratio_ml_per_l),
      fungicide_batch_water_l = COALESCE($18, fungicide_batch_water_l)
     WHERE id = $1 RETURNING *`,
    [
      req.params.id, b.humidity_below, b.temp_above, b.window_start, b.window_end,
      b.cycle_weeks, b.pre_water_wait_minutes, b.dose_ml, b.fungicide_interval_days,
      b.feed_product_early, b.feed_product_late, b.fungicide_product, b.fungicide_dose_ml,
      b.fungicide_automated, b.feed_mix_ratio_ml_per_l, b.feed_batch_water_l,
      b.fungicide_mix_ratio_ml_per_l, b.fungicide_batch_water_l,
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'template not found' });
  res.json(rows[0]);
});

module.exports = router;
