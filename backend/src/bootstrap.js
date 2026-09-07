const bcrypt = require('bcryptjs');
const { pool } = require('./db');

const VARIETY_TEMPLATES = [
  'Bangkok Peach',
  'Pop Eye',
  'Yellow Stripe',
  'Caesar Pink',
  'Thong Deang',
];

// Every variety starts from the same care-schedule defaults (Kadawatha doc) —
// there's no per-variety threshold data yet, so templates are separate rows
// on purpose: tuning one later shouldn't silently move the others.
const DEFAULTS = {
  humidity_below: 60,
  temp_above: 32,
  window_start: '06:30',
  window_end: '08:00',
  poll_seconds: 60,
  cycle_weeks: 5,
  pre_water_wait_minutes: 15,
  dose_ml: 250,
  fungicide_interval_days: 14,
  feed_product_early: 'Basfoliar P-40 (13-40-13 + MgO + TE)',
  feed_product_late: 'Nitro-tech Mugasole Treble 20 (20-20-20 + TE)',
  fungicide_product: 'Oasis Captan 50% WP',
  fungicide_dose_ml: 250,
  fungicide_automated: false,
  feed_mix_ratio_ml_per_l: 5,
  feed_batch_water_l: 50,
  fungicide_mix_ratio_ml_per_l: 5,
  fungicide_batch_water_l: 50,
  dechlorinate_hours: 24,
  pump_flow_lpm: 4.5,
};

const DEFAULT_MAINTENANCE_TASKS = [
  { title: 'Clean fertilizer feed tank', recurrence_days: 30 },
  { title: 'Rinse & inspect fogging nozzles', recurrence_days: 14 },
  { title: 'Check inline filter for debris', recurrence_days: 14 },
  { title: 'Recalibrate dosing pump flow rate', recurrence_days: 30 },
  { title: 'Clean main water tank', recurrence_days: 60 },
];

async function ensureAdminUser() {
  const { rows } = await pool.query('SELECT id FROM users LIMIT 1');
  if (rows.length > 0) return;

  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'changeme';
  const hash = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2)', [email, hash]);
  console.log(`[bootstrap] created admin user ${email}`);
}

async function ensureTemplates() {
  for (const name of VARIETY_TEMPLATES) {
    await pool.query(
      `INSERT INTO templates
        (name, humidity_below, temp_above, window_start, window_end, poll_seconds,
         cycle_weeks, pre_water_wait_minutes, dose_ml, fungicide_interval_days,
         feed_product_early, feed_product_late, fungicide_product, fungicide_dose_ml, fungicide_automated,
         feed_mix_ratio_ml_per_l, feed_batch_water_l, fungicide_mix_ratio_ml_per_l, fungicide_batch_water_l)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (name) DO NOTHING`,
      [
        name,
        DEFAULTS.humidity_below,
        DEFAULTS.temp_above,
        DEFAULTS.window_start,
        DEFAULTS.window_end,
        DEFAULTS.poll_seconds,
        DEFAULTS.cycle_weeks,
        DEFAULTS.pre_water_wait_minutes,
        DEFAULTS.dose_ml,
        DEFAULTS.fungicide_interval_days,
        DEFAULTS.feed_product_early,
        DEFAULTS.feed_product_late,
        DEFAULTS.fungicide_product,
        DEFAULTS.fungicide_dose_ml,
        DEFAULTS.fungicide_automated,
        DEFAULTS.feed_mix_ratio_ml_per_l,
        DEFAULTS.feed_batch_water_l,
        DEFAULTS.fungicide_mix_ratio_ml_per_l,
        DEFAULTS.fungicide_batch_water_l,
      ]
    );
  }
}

async function ensureDefaultFarm() {
  const farm = await pool.query(
    `INSERT INTO farms (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`,
    ['Kadawatha Farm']
  );
  const farmId = farm.rows[0]
    ? farm.rows[0].id
    : (await pool.query('SELECT id FROM farms WHERE name = $1', ['Kadawatha Farm'])).rows[0].id;

  const room = await pool.query(
    `INSERT INTO rooms (farm_id, name) VALUES ($1,$2) ON CONFLICT (farm_id, name) DO NOTHING RETURNING id`,
    [farmId, 'Greenhouse Room 1']
  );
  return room.rows[0]
    ? room.rows[0].id
    : (await pool.query('SELECT id FROM rooms WHERE farm_id = $1 AND name = $2', [farmId, 'Greenhouse Room 1'])).rows[0].id;
}

async function ensureMaintenanceTasks(unitId) {
  const { rows } = await pool.query('SELECT id FROM maintenance_tasks WHERE unit_id = $1', [unitId]);
  if (rows.length > 0) return;
  for (const task of DEFAULT_MAINTENANCE_TASKS) {
    await pool.query(
      'INSERT INTO maintenance_tasks (unit_id, title, recurrence_days) VALUES ($1,$2,$3)',
      [unitId, task.title, task.recurrence_days]
    );
  }
}

async function ensureDemoUnit() {
  const deviceKey = process.env.DEMO_DEVICE_KEY;
  if (!deviceKey) return;

  const roomId = await ensureDefaultFarm();

  const existing = await pool.query('SELECT id FROM units WHERE device_key = $1', [deviceKey]);
  if (existing.rows.length > 0) {
    await pool.query('UPDATE units SET room_id = COALESCE(room_id, $2) WHERE id = $1', [existing.rows[0].id, roomId]);
    await ensureMaintenanceTasks(existing.rows[0].id);
    return;
  }

  const template = await pool.query('SELECT * FROM templates WHERE name = $1', ['Bangkok Peach']);
  const t = template.rows[0] || DEFAULTS;

  const unit = await pool.query(
    'INSERT INTO units (name, bench, room_id, device_key) VALUES ($1,$2,$3,$4) RETURNING id',
    ['Kadawatha Bench 1', 'Bench A', roomId, deviceKey]
  );
  const unitId = unit.rows[0].id;

  await pool.query(
    `INSERT INTO unit_schedules
      (unit_id, template_id, humidity_below, temp_above, window_start, window_end,
       poll_seconds, cycle_weeks, pre_water_wait_minutes, dose_ml, fungicide_interval_days,
       feed_product_early, feed_product_late, fungicide_product, fungicide_dose_ml, fungicide_automated,
       feed_mix_ratio_ml_per_l, feed_batch_water_l, fungicide_mix_ratio_ml_per_l, fungicide_batch_water_l,
       dechlorinate_hours, pump_flow_lpm)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [
      unitId,
      t.id || null,
      t.humidity_below,
      t.temp_above,
      t.window_start,
      t.window_end,
      t.poll_seconds,
      t.cycle_weeks,
      t.pre_water_wait_minutes,
      t.dose_ml,
      t.fungicide_interval_days,
      t.feed_product_early,
      t.feed_product_late,
      t.fungicide_product,
      t.fungicide_dose_ml,
      t.fungicide_automated,
      t.feed_mix_ratio_ml_per_l ?? DEFAULTS.feed_mix_ratio_ml_per_l,
      t.feed_batch_water_l ?? DEFAULTS.feed_batch_water_l,
      t.fungicide_mix_ratio_ml_per_l ?? DEFAULTS.fungicide_mix_ratio_ml_per_l,
      t.fungicide_batch_water_l ?? DEFAULTS.fungicide_batch_water_l,
      DEFAULTS.dechlorinate_hours,
      DEFAULTS.pump_flow_lpm,
    ]
  );
  await ensureMaintenanceTasks(unitId);
  console.log(`[bootstrap] created demo unit "Kadawatha Bench 1" (id ${unitId})`);
}

async function bootstrap() {
  await ensureAdminUser();
  await ensureTemplates();
  await ensureDemoUnit();
}

module.exports = { bootstrap };
