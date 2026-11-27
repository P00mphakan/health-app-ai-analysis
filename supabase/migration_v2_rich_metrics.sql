-- Migration v2: Add rich Amazfit/Zepp .FIT telemetry and Apple Health Sleep stages / SpO2
-- Safe to run multiple times (IF NOT EXISTS)

ALTER TABLE daily_metrics
  ADD COLUMN IF NOT EXISTS sleep_deep_min INT,
  ADD COLUMN IF NOT EXISTS sleep_rem_min INT,
  ADD COLUMN IF NOT EXISTS sleep_light_min INT,
  ADD COLUMN IF NOT EXISTS spo2 NUMERIC;

ALTER TABLE workouts
  ADD COLUMN IF NOT EXISTS total_calories INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_hr INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_power INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS avg_speed_kmh NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aerobic_te NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS anaerobic_te NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS training_load_peak INT DEFAULT 0;
