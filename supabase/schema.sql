CREATE TABLE IF NOT EXISTS athletes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  sex TEXT NOT NULL CHECK (sex IN ('male', 'female')),
  birth_date DATE NOT NULL,
  weight_kg NUMERIC NOT NULL,
  height_cm NUMERIC NOT NULL,
  max_hr INT NOT NULL,
  resting_hr INT NOT NULL,
  hrv_baseline INT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  metric_date DATE NOT NULL,
  sleep_hours NUMERIC,
  sleep_deep_min INT,
  sleep_rem_min INT,
  sleep_light_min INT,
  hrv INT,
  resting_hr INT,
  weight_kg NUMERIC,
  steps INT,
  spo2 NUMERIC,
  ai_daily_brief JSONB, -- แคชบทวิเคราะห์ประจำวัน ลดการยิง API ซ้ำ
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(athlete_id, metric_date)
);

CREATE TABLE IF NOT EXISTS workouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id UUID NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  external_id TEXT UNIQUE,
  workout_date DATE NOT NULL,
  sport_type TEXT NOT NULL,
  title TEXT,
  duration_min NUMERIC NOT NULL,
  distance_km NUMERIC DEFAULT 0,
  avg_hr INT NOT NULL,
  max_hr INT DEFAULT 0,
  min_hr INT DEFAULT 0,
  avg_power INT DEFAULT 0,
  max_power INT DEFAULT 0,
  cadence INT DEFAULT 0,
  elevation_gain NUMERIC DEFAULT 0,
  avg_speed_kmh NUMERIC DEFAULT 0,
  total_calories INT DEFAULT 0,
  aerobic_te NUMERIC DEFAULT 0,
  anaerobic_te NUMERIC DEFAULT 0,
  training_load_peak INT DEFAULT 0,
  rpe INT DEFAULT 5,
  trimp NUMERIC DEFAULT 0,
  source TEXT DEFAULT 'manual',
  ai_coach_report JSONB, -- แคชบทวิเคราะห์หลัง Workout
  created_at TIMESTAMPTZ DEFAULT now()
);

-- สำหรับใช้งานในครอบครัวแบบส่วนตัว (หรือเปิด RLS พร้อม Policy ภายหลัง)
ALTER TABLE athletes DISABLE ROW LEVEL SECURITY;
ALTER TABLE daily_metrics DISABLE ROW LEVEL SECURITY;
ALTER TABLE workouts DISABLE ROW LEVEL SECURITY;
