CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Variety defaults, applied to a room's schedule.
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

-- A farm is one physical site with ONE shared water tank + fertilizer
-- mixing rig (mix/stir/filter/dose) feeding every room in it — so the farm
-- itself is an addressable IoT device (its own device_key), reporting tank
-- sensor state and running the fertigation state machine on behalf of
-- whichever room's feed day it is.
CREATE TABLE farms (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  device_key TEXT UNIQUE NOT NULL,
  last_seen_at TIMESTAMPTZ,
  water_low BOOLEAN,
  water_full BOOLEAN,
  water_overflow BOOLEAN,
  tank_activity TEXT NOT NULL DEFAULT 'idle', -- idle | filling | dechlorinating
  tank_filled_at TIMESTAMPTZ,
  autofill_enabled BOOLEAN NOT NULL DEFAULT true,
  dechlorinate_hours INT NOT NULL DEFAULT 24,
  pump_flow_lpm NUMERIC NOT NULL DEFAULT 4.5,
  fert_activity TEXT NOT NULL DEFAULT 'idle', -- idle | mixing | stirring | filtering | feeding
  fert_activity_room_id INT,
  fert_activity_source TEXT, -- which stock tank the current cycle is drawing from: fertilizer_early | fertilizer_late
  fert_activity_started_at TIMESTAMPTZ,
  -- Latest raw ADC counts from each tank's load cell, as last reported by
  -- the farm device — feeds the "capture live reading" button in the tank
  -- calibration UI. Not converted to grams here; that's what tank_calibrations is for.
  -- 3 separate fertilizing tanks (early-phase feed, late-phase feed,
  -- fungicide) since two different NPK formulas can't share one stock tank —
  -- they're only combined at the shared mixing/dosing rig, one at a time.
  raw_water_counts NUMERIC,
  raw_fertilizer_early_counts NUMERIC,
  raw_fertilizer_late_counts NUMERIC,
  raw_fungicide_counts NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A room (greenhouse/"house") has ONE environment sensor (humidity/temp/
-- rain) and runs misting for every bench in it together — so the room is
-- the addressable IoT device for irrigation, separate from the farm's tank.
CREATE TABLE rooms (
  id SERIAL PRIMARY KEY,
  farm_id INT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  device_key TEXT UNIQUE NOT NULL,
  last_seen_at TIMESTAMPTZ,
  mist_activity TEXT NOT NULL DEFAULT 'idle', -- idle | misting
  mist_activity_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(farm_id, name)
);

ALTER TABLE farms ADD CONSTRAINT fk_farms_fert_room
  FOREIGN KEY (fert_activity_room_id) REFERENCES rooms(id) ON DELETE SET NULL;

-- A bench is just a named, positioned spot on the room's floor-plan map —
-- no sensor, tank, or device of its own; it inherits the room's climate and
-- the farm's water/fertilizer supply.
CREATE TABLE benches (
  id SERIAL PRIMARY KEY,
  room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  variety TEXT,
  row_label TEXT,
  pos_x NUMERIC,
  pos_y NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE room_schedules (
  room_id INT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
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
  -- Set the moment a feed event actually posts (see farm /events in
  -- device.js). Read back by the simulator as cachedConfig.feed.lastFedDate
  -- so "already fed today" survives a simulator restart — without this, a
  -- restart on a feed day silently re-dosed every room whose feed day
  -- matched today, draining the fertilizer stock tanks far faster than
  -- intended.
  last_fed_date DATE,
  paused BOOLEAN NOT NULL DEFAULT false,
  skip_feed_once BOOLEAN NOT NULL DEFAULT false,
  feed_product_early TEXT NOT NULL DEFAULT 'Basfoliar P-40 (13-40-13 + MgO + TE)',
  feed_product_late TEXT NOT NULL DEFAULT 'Nitro-tech Mugasole Treble 20 (20-20-20 + TE)',
  fungicide_product TEXT NOT NULL DEFAULT 'Oasis Captan 50% WP',
  fungicide_dose_ml INT NOT NULL DEFAULT 250,
  fungicide_automated BOOLEAN NOT NULL DEFAULT false,
  feed_mix_ratio_ml_per_l NUMERIC NOT NULL DEFAULT 5,
  feed_batch_water_l NUMERIC NOT NULL DEFAULT 50,
  fungicide_mix_ratio_ml_per_l NUMERIC NOT NULL DEFAULT 5,
  fungicide_batch_water_l NUMERIC NOT NULL DEFAULT 50,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE room_telemetry (
  id BIGSERIAL PRIMARY KEY,
  room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  humidity NUMERIC,
  temp_c NUMERIC,
  raining BOOLEAN NOT NULL DEFAULT false,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_room_telemetry_room_time ON room_telemetry(room_id, recorded_at DESC);

CREATE TABLE farm_tank_readings (
  id BIGSERIAL PRIMARY KEY,
  farm_id INT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  water_low BOOLEAN,
  water_full BOOLEAN,
  water_overflow BOOLEAN,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_farm_tank_time ON farm_tank_readings(farm_id, recorded_at DESC);

-- One row per physical vessel per farm: water tank, early-phase fertilizer
-- stock tank, late-phase fertilizer stock tank, fungicide tank. Stores the
-- 2-point load-cell calibration (tare_raw + scale_factor, in raw ADC counts
-- per gram) so a raw HX711 reading can be converted to a weight, and from
-- there to a volume via density.
CREATE TABLE tank_calibrations (
  id SERIAL PRIMARY KEY,
  farm_id INT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  tank_key TEXT NOT NULL CHECK (tank_key IN ('water', 'fertilizer_early', 'fertilizer_late', 'fungicide')),
  tare_raw NUMERIC,
  known_weight_g NUMERIC,
  raw_at_known_weight NUMERIC,
  scale_factor NUMERIC, -- raw counts per gram, derived: (raw_at_known_weight - tare_raw) / known_weight_g
  capacity_l NUMERIC,
  density_g_per_ml NUMERIC NOT NULL DEFAULT 1.0,
  calibrated_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE(farm_id, tank_key)
);

-- Owned by exactly one of room (e.g. "rinse fogging nozzles" — that room's
-- own hardware) or farm (e.g. "clean the fertilizer tank" — the shared rig).
CREATE TABLE maintenance_tasks (
  id SERIAL PRIMARY KEY,
  room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
  farm_id INT REFERENCES farms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  recurrence_days INT NOT NULL,
  last_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((room_id IS NOT NULL) <> (farm_id IS NOT NULL))
);

-- A 'mist' event belongs to a room only. A 'feed' event belongs to both —
-- which farm rig mixed it and which room received the dose. An 'autofill'
-- event (tank refill) belongs to a farm only.
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
  farm_id INT REFERENCES farms(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  duration_seconds INT,
  volume_ml NUMERIC,
  meta JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (room_id IS NOT NULL OR farm_id IS NOT NULL)
);
CREATE INDEX idx_events_room_time ON events(room_id, occurred_at DESC);
CREATE INDEX idx_events_farm_time ON events(farm_id, occurred_at DESC);

CREATE TABLE commands (
  id BIGSERIAL PRIMARY KEY,
  room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
  farm_id INT REFERENCES farms(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  CHECK ((room_id IS NOT NULL) <> (farm_id IS NOT NULL))
);
CREATE INDEX idx_commands_room_status ON commands(room_id, status);
CREATE INDEX idx_commands_farm_status ON commands(farm_id, status);
