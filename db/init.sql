CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE templates (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  humidity_below INT NOT NULL,
  temp_above NUMERIC NOT NULL,
  window_start TIME NOT NULL,
  window_end TIME NOT NULL,
  poll_seconds INT NOT NULL DEFAULT 60,
  cycle_weeks INT NOT NULL DEFAULT 5,
  pre_water_wait_minutes INT NOT NULL DEFAULT 15,
  dose_ml INT NOT NULL DEFAULT 250,
  fungicide_interval_days INT NOT NULL DEFAULT 14,
  feed_product_early TEXT NOT NULL DEFAULT 'Basfoliar P-40 (13-40-13 + MgO + TE)',
  feed_product_late TEXT NOT NULL DEFAULT 'Nitro-tech Mugasole Treble 20 (20-20-20 + TE)',
  fungicide_product TEXT NOT NULL DEFAULT 'Oasis Captan 50% WP',
  fungicide_dose_ml INT NOT NULL DEFAULT 250,
  fungicide_automated BOOLEAN NOT NULL DEFAULT false,
  feed_mix_ratio_ml_per_l NUMERIC NOT NULL DEFAULT 5,
  feed_batch_water_l NUMERIC NOT NULL DEFAULT 50,
  fungicide_mix_ratio_ml_per_l NUMERIC NOT NULL DEFAULT 5,
  fungicide_batch_water_l NUMERIC NOT NULL DEFAULT 50
);

CREATE TABLE farms (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  id SERIAL PRIMARY KEY,
  farm_id INT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(farm_id, name)
);

CREATE TABLE units (
  id SERIAL PRIMARY KEY,
  room_id INT REFERENCES rooms(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  bench TEXT,
  device_key TEXT UNIQUE NOT NULL,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE unit_schedules (
  unit_id INT PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  template_id INT REFERENCES templates(id),
  humidity_below INT NOT NULL,
  temp_above NUMERIC NOT NULL,
  window_start TIME NOT NULL,
  window_end TIME NOT NULL,
  poll_seconds INT NOT NULL DEFAULT 60,
  cycle_weeks INT NOT NULL DEFAULT 5,
  feed_start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  pre_water_wait_minutes INT NOT NULL DEFAULT 15,
  dose_ml INT NOT NULL DEFAULT 250,
  fungicide_interval_days INT NOT NULL DEFAULT 14,
  fungicide_last_sprayed_date DATE NOT NULL DEFAULT CURRENT_DATE,
  paused BOOLEAN NOT NULL DEFAULT false,
  skip_feed_once BOOLEAN NOT NULL DEFAULT false,
  feed_product_early TEXT NOT NULL DEFAULT 'Basfoliar P-40 (13-40-13 + MgO + TE)',
  feed_product_late TEXT NOT NULL DEFAULT 'Nitro-tech Mugasole Treble 20 (20-20-20 + TE)',
  fungicide_product TEXT NOT NULL DEFAULT 'Oasis Captan 50% WP',
  fungicide_dose_ml INT NOT NULL DEFAULT 250,
  fungicide_automated BOOLEAN NOT NULL DEFAULT false,
  autofill_enabled BOOLEAN NOT NULL DEFAULT false,
  dechlorinate_hours INT NOT NULL DEFAULT 24,
  pump_flow_lpm NUMERIC NOT NULL DEFAULT 4.5,
  feed_mix_ratio_ml_per_l NUMERIC NOT NULL DEFAULT 5,
  feed_batch_water_l NUMERIC NOT NULL DEFAULT 50,
  fungicide_mix_ratio_ml_per_l NUMERIC NOT NULL DEFAULT 5,
  fungicide_batch_water_l NUMERIC NOT NULL DEFAULT 50,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE unit_status (
  unit_id INT PRIMARY KEY REFERENCES units(id) ON DELETE CASCADE,
  activity TEXT NOT NULL DEFAULT 'idle',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE maintenance_tasks (
  id SERIAL PRIMARY KEY,
  unit_id INT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  recurrence_days INT NOT NULL,
  last_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE telemetry (
  id BIGSERIAL PRIMARY KEY,
  unit_id INT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  humidity NUMERIC,
  temp_c NUMERIC,
  raining BOOLEAN NOT NULL DEFAULT false,
  water_low BOOLEAN,
  water_full BOOLEAN,
  water_overflow BOOLEAN,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_telemetry_unit_time ON telemetry(unit_id, recorded_at DESC);

CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  unit_id INT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  duration_seconds INT,
  volume_ml NUMERIC,
  meta JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_unit_time ON events(unit_id, occurred_at DESC);

CREATE TABLE commands (
  id BIGSERIAL PRIMARY KEY,
  unit_id INT NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX idx_commands_unit_status ON commands(unit_id, status);
