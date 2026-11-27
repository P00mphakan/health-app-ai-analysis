# ATHLETE OS — Family Performance Hub (Production Blueprint)

เอกสารพิมพ์เขียวสำหรับส่งต่อให้ **Antigravity** สร้าง Repository บน **GitHub** และ Deploy ขึ้น **Vercel** โดยเชื่อมต่อกับ **Supabase**, **Amazfit T-Rex 3 / Zepp**, **Apple Health** และระบบ **AI Coach (Google Gemini + Fallback ไปยัง Local Ollama ผ่าน Cloudflare Tunnel)**

---

## 1. ภาพรวมสถาปัตยกรรมระบบ (System Architecture)

```text
[Amazfit T-Rex 3]
       │
       ▼
  [Zepp App (iPhone)]
       ├──(1) iCloud Automatic Backup (.FIT) ──► [scripts/zepp_icloud_sync.py] ──► Supabase (workouts)
       └──(2) Apple Health Sync ──► [Health Auto Export / Shortcuts] ──► Vercel (/api/ingest-health) ──► Supabase (daily_metrics)
                                                                                                               │
[Family Web App (Vercel: /index.html)] ◄─────────────────────── Read/Write via Supabase JS ────────────────────┘
       │
       └── POST /api/coach (Daily Brief & Post-Workout Analysis)
                 ├── Tier 1 (Primary): Google Gemini API (gemini-2.5-flash)
                 ├── Tier 2 (Fallback): Local Ollama via Cloudflare Tunnel (trycloudflare / Named Tunnel)
                 └── Tier 3 (Zero-Downtime): Built-in Sports Science Rule-Based Engine
```

### ข้อกำหนดหลักของระบบ (Core Requirements)
- **Zero Mock Data:** ตัดข้อมูลจำลองและแผงจำลอง (Simulator) ออก 100%
- **Multi-User Family Support (2–10 คน):** แยกข้อมูลและ URL ประจำตัวด้วย `?u=<slug>` (เช่น `?u=pluk`, `?u=fan`, `?u=kid`)
- **Auto-Detect Physiology:** ตรวจจับโครงร่าง Body Energy SVG (`ชาย` / `หญิง` / `เด็ก <14 ปี`) และสูตรคำนวณจากฐานข้อมูลโปรไฟล์อัตโนมัติ
- **Sports Science Formulas:**
  - **Banister TRIMP:** ชายใช้ $0.64 \times e^{1.92 \cdot \Delta HR}$, หญิงใช้ $0.86 \times e^{1.67 \cdot \Delta HR}$
  - **Max HR:** ชายใช้ Tanaka ($208 - 0.7 \times \text{Age}$), หญิงใช้ Gulati ($206 - 0.88 \times \text{Age}$), เด็ก (<14 ปี) ใช้ $202$
  - **PMC & Injury Prevention:** $CTL_{42d}$, $ATL_{7d}$, $TSB = CTL - ATL$, และ Gabbett $ACWR = ATL / CTL$ (Safe Zone $0.80 - 1.30$)
  - **Dashboard Charts:** กราฟเส้นเลือกดูได้ `1D`, `1W` (Default), `1M`, `1Y`, `2Y`, `3Y`, `ALL`

---

## 2. โครงสร้างไฟล์ใน GitHub Repository (Directory Structure)

ให้ Antigravity จัดโครงสร้างโปรเจกต์ตามนี้เพื่อให้ Deploy ขึ้น Vercel ได้ทันทีโดยไม่ต้อง Build ซับซ้อน:

```text
athlete-os/
├── api/
│   ├── coach.js                # Serverless API: AI Coach (Gemini -> Cloudflare Ollama -> Rule-Based)
│   └── ingest-health.js        # Serverless API: รับ Webhook จาก Apple Health (Health Auto Export)
├── public/
│   └── index.html              # หน้าเว็บ Production Single-File (จากไฟล์ index.html ที่ออกแบบไว้)
├── scripts/
│   └── zepp_icloud_sync.py     # สคริปต์ Python ดึงไฟล์ .FIT จาก iCloud Drive/Zepp/FITs ขึ้น Supabase
├── supabase/
│   └── schema.sql              # คำสั่งสร้างตารางทั้งหมดใน Supabase
├── .env.example                # ตัวอย่าง Environment Variables สำหรับตั้งค่าใน Vercel
├── package.json                # Dependencies สำหรับ Vercel Serverless Functions
└── vercel.json                 # Routing config สำหรับ Vercel
```

---

## 3. โค้ดสำหรับแต่ละไฟล์ (Ready for Antigravity)

### 3.1 `package.json`
```json
{
  "name": "athlete-os-family-hub",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0"
  }
}
```

### 3.2 `vercel.json`
```json
{
  "cleanUrls": true,
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/public/index.html" }
  ]
}
```

### 3.3 `.env.example` (ตั้งค่าใน Vercel → Settings → Environment Variables)
```env
# Supabase
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY
WEBHOOK_SECRET=ตั้งรหัสผ่านลับสำหรับ-Apple-Health-Webhook

# AI Tier 1: Google AI Studio (Primary)
GEMINI_API_KEY=YOUR_GOOGLE_GEMINI_API_KEY
GEMINI_MODEL=gemini-2.5-flash

# AI Tier 2: Local Ollama via Cloudflare Tunnel (Fallback)
OLLAMA_CF_URL=https://your-tunnel-url.trycloudflare.com
OLLAMA_MODEL=qwen2.5:14b
```

### 3.4 `supabase/schema.sql`
```sql
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
  hrv INT,
  resting_hr INT,
  weight_kg NUMERIC,
  steps INT,
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
  avg_power INT DEFAULT 0,
  cadence INT DEFAULT 0,
  elevation_gain NUMERIC DEFAULT 0,
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
```

---

### 3.5 `api/coach.js` (AI Coach พร้อมระบบ 3-Tier Fallback: Gemini → Cloudflare Ollama → Rule-Based)

**คำตอบเรื่อง AI API:**
- **จำเป็นต้องใช้ API ไหม?** หากใช้เฉพาะสูตรคำนวณ Rule-Based ในหน้าเว็บจะไม่เสียค่าใช้จ่ายและทำงานได้ทันที แต่ถ้าต้องการ **บทวิเคราะห์เชิงลึกสไตล์โค้ชที่เชื่อมโยงบริบทหลายวัน** (เช่น วิเคราะห์ว่าเมื่อวานเตะบอลหนัก + นอนน้อย + พรุ่งนี้มีคิววิ่งยาว ควรปรับแผนยังไง) การใช้ **LLM API ผ่าน `/api/coach.js`** จะฉลาดกว่ามาก และเราเก็บผลลัพธ์แคชลง Supabase ทำให้ยิง API แค่วันละ 1–2 ครั้ง ประหยัดโควต้ามากครับ
- **โมเดลที่แนะนำ:**
  1. **Primary (Google AI):** `gemini-2.5-flash` (ภาษาไทยคม กระชับ ตอบไว มี Free Tier สูง และราคาถูกมาก)
  2. **Fallback (Local Ollama ผ่าน Cloudflare Tunnel):** แนะนำโมเดลที่เก่งภาษาไทยบนเครื่อง Local เช่น `qwen2.5:14b`, `gemma3:12b` หรือ `llama3.1:8b`

```javascript
// api/coach.js — Vercel Serverless Function
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { mode, athlete, metrics, workout, pmc } = req.body || {};
  if (!mode || !athlete) {
    return res.status(400).json({ error: 'Missing mode or athlete payload' });
  }

  const systemPrompt = `คุณคือโค้ชวิทยาศาสตร์การกีฬาและเวชศาสตร์การกีฬาระดับอาชีพ
ตอบเป็นภาษาไทยแบบตรงไปตรงมา กระชับ ไม่อ้อมค้อม ไม่เวิ่นเว้อ อิงตัวเลขจริงเท่านั้น
ห้ามใช้คำปลอบใจหรือคำเกริ่นนำยาวๆ ให้ตอบกลับเป็น JSON เท่านั้นตามโครงสร้างที่กำหนด`;

  const userPrompt = mode === 'daily'
    ? `วิเคราะห์ความพร้อมประจำวันของนักกีฬา:
ข้อมูลนักกีฬา: ${JSON.stringify({ name: athlete.name, sex: athlete.sex, weight_kg: athlete.weight_kg, max_hr: athlete.max_hr, resting_hr: athlete.resting_hr, hrv_baseline: athlete.hrv_baseline })}
ค่าสุขภาพล่าสุด: ${JSON.stringify(metrics)}
ภาระสะสม (PMC/ACWR): ${JSON.stringify(pmc)}

ตอบเป็น JSON ที่มีคีย์ต่อไปนี้เท่านั้น:
{
  "verdict": "ใส่เต็มที่ได้ | ซ้อมเบาคุมโซน | พักฟื้น 100%",
  "status": "สรุป HRV/RHR/การนอน เทียบฐาน 1 บรรทัด",
  "load": "สรุป ACWR/CTL/ATL/TSB 1 บรรทัด",
  "plan": "แผนซ้อมวันนี้พร้อมช่วง HR เป้าหมาย 1-2 บรรทัด",
  "warning": "จุดเสี่ยงบาดเจ็บหรือข้อควรระวัง 1 บรรทัด"
}`
    : `วิเคราะห์หลังการซ้อม (Post-Workout Coach Report):
ข้อมูลนักกีฬา: ${JSON.stringify({ name: athlete.name, sex: athlete.sex, weight_kg: athlete.weight_kg, max_hr: athlete.max_hr, resting_hr: athlete.resting_hr })}
ข้อมูล Workout: ${JSON.stringify(workout)}
ACWR หลังซ้อม: ${JSON.stringify(pmc)}

ตอบเป็น JSON ที่มีคีย์ต่อไปนี้เท่านั้น:
{
  "hrSection": "ประเมิน Heart Rate Zone ตรงไปตรงมา 1-2 บรรทัด",
  "perfSection": "สรุป Performance (Pace, Power, W/kg, EF, TRIMP) 1 บรรทัด",
  "tacticsSection": "วิเคราะห์ Tactics ลักษณะโหลด และชั่วโมงพักฟื้นที่แนะนำ 1-2 บรรทัด",
  "nextDrill": "แนวทางฝึกฝนและปรับปรุงเซสชันถัดไป 2 ข้อสั้นๆ"
}`;

  // ---- TIER 1: Google Gemini API (Primary) ----
  const geminiKey = process.env.GEMINI_API_KEY;
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  if (geminiKey) {
    try {
      const gRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(12000),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: {
              temperature: 0.3,
              responseMimeType: 'application/json'
            }
          })
        }
      );

      if (gRes.ok) {
        const gData = await gRes.json();
        const rawText = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          return res.status(200).json({
            provider: `google:${geminiModel}`,
            data: JSON.parse(rawText)
          });
        }
      }
      console.warn('Gemini failed, falling back to Cloudflare Ollama...');
    } catch (err) {
      console.warn('Gemini error:', err.message);
    }
  }

  // ---- TIER 2: Local Ollama via Cloudflare Tunnel (Fallback) ----
  const ollamaUrl = (process.env.OLLAMA_CF_URL || '').replace(/\/$/, '');
  const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:14b';

  if (ollamaUrl) {
    try {
      const oRes = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          model: ollamaModel,
          stream: false,
          format: 'json',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        })
      });

      if (oRes.ok) {
        const oData = await oRes.json();
        const rawText = oData?.message?.content;
        if (rawText) {
          return res.status(200).json({
            provider: `ollama-cf:${ollamaModel}`,
            data: JSON.parse(rawText)
          });
        }
      }
      console.warn('Ollama CF failed, falling back to Rule-Based...');
    } catch (err) {
      console.warn('Ollama CF error:', err.message);
    }
  }

  // ---- TIER 3: Tell Frontend to use Built-in Deterministic Rule-Based Engine ----
  return res.status(200).json({
    provider: 'rule-based-fallback',
    data: null
  });
}
```

---

### 3.6 `api/ingest-health.js` (Webhook รับข้อมูลจาก Apple Health / Health Auto Export)
```javascript
// api/ingest-health.js — รับข้อมูลสุขภาพจาก iPhone ส่งเข้า Supabase
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const slug = (req.query.u || req.body?.slug || '').toLowerCase();
  if (!slug) return res.status(400).json({ error: 'Missing athlete slug (?u=pluk)' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: athlete, error: aErr } = await sb
    .from('athletes')
    .select('id, weight_kg')
    .eq('slug', slug)
    .single();

  if (aErr || !athlete) return res.status(404).json({ error: `Athlete slug "${slug}" not found` });

  // รองรับทั้งรูปแบบ JSON ตรงๆ และรูปแบบของแอป Health Auto Export
  const body = req.body || {};
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

  let sleep_hours = body.sleep_hours ?? null;
  let hrv = body.hrv ?? null;
  let resting_hr = body.resting_hr ?? null;
  let weight_kg = body.weight_kg ?? null;
  let steps = body.steps ?? null;

  // แปลงกรณีส่งมาจากแอป Health Auto Export (data.metrics array)
  if (Array.isArray(body?.data?.metrics)) {
    for (const m of body.data.metrics) {
      const name = (m.name || '').toLowerCase();
      const latest = m.data?.[m.data.length - 1];
      if (!latest) continue;
      if (name.includes('sleep')) sleep_hours = +(latest.asleep || latest.qty || 0).toFixed(2);
      if (name.includes('heart_rate_variability')) hrv = Math.round(latest.qty || 0);
      if (name.includes('resting_heart_rate')) resting_hr = Math.round(latest.qty || 0);
      if (name.includes('weight') || name.includes('body_mass')) weight_kg = +(latest.qty || 0).toFixed(1);
      if (name.includes('step_count')) steps = Math.round(latest.qty || 0);
    }
  }

  const payload = {
    athlete_id: athlete.id,
    metric_date: body.metric_date || today,
    sleep_hours,
    hrv,
    resting_hr,
    weight_kg: weight_kg || athlete.weight_kg,
    steps
  };

  const { data, error } = await sb
    .from('daily_metrics')
    .upsert(payload, { onConflict: 'athlete_id,metric_date' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, saved: data });
}
```

---

### 3.7 `scripts/zepp_icloud_sync.py` (สคริปต์ดึงไฟล์ `.FIT` จาก Zepp iCloud)
```python
# ติดตั้งไลบรารี: pip install fitparse supabase
import os, time, math
from pathlib import Path
from fitparse import FitFile
from supabase import create_client

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://YOUR_PROJECT.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "YOUR_KEY")
ATHLETE_SLUG = os.getenv("ATHLETE_SLUG", "pluk")

# พาธโฟลเดอร์ iCloud Drive บน macOS (สำหรับ Windows ปรับเป็น Path.home() / "iCloudDrive/Zepp/FITs")
ICLOUD_FIT_DIR = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Zepp/FITs"

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

def calc_trimp(dur, avg_hr, sex, rhr, max_hr):
    hrr = max(0.0, min(1.0, (avg_hr - rhr) / max(20, max_hr - rhr)))
    k1, k2 = (0.86, 1.67) if sex == "female" else (0.64, 1.92)
    return round(dur * hrr * k1 * math.exp(k2 * hrr), 1)

def sync_once():
    ath = sb.table("athletes").select("*").eq("slug", ATHLETE_SLUG).single().execute().data
    if not ICLOUD_FIT_DIR.exists():
        print(f"ไม่พบโฟลเดอร์: {ICLOUD_FIT_DIR}")
        return

    for f in sorted(ICLOUD_FIT_DIR.glob("*.fit")):
        ext_id = f"fit_{ath['slug']}_{f.stem}"
        exists = sb.table("workouts").select("id").eq("external_id", ext_id).execute().data
        if exists:
            continue

        fit = FitFile(str(f))
        s = next(fit.get_messages("session"), None)
        if not s:
            continue
        v = {x.name: x.value for x in s}
        dur = round((v.get("total_timer_time") or 0) / 60.0, 2)
        avg_hr = int(v.get("avg_heart_rate") or 0)
        raw_sport = str(v.get("sport") or "running").lower()
        sport = (
            "running" if "run" in raw_sport else
            "badminton" if "badminton" in raw_sport else
            "football" if ("soccer" in raw_sport or "football" in raw_sport) else
            "cycling" if "cycl" in raw_sport else "other"
        )
        sb.table("workouts").upsert({
            "athlete_id": ath["id"],
            "external_id": ext_id,
            "workout_date": v["start_time"].strftime("%Y-%m-%d") if v.get("start_time") else time.strftime("%Y-%m-%d"),
            "sport_type": sport,
            "title": f"Zepp {raw_sport.title()} ({f.stem})",
            "duration_min": dur,
            "distance_km": round((v.get("total_distance") or 0) / 1000.0, 2),
            "avg_hr": avg_hr,
            "max_hr": int(v.get("max_heart_rate") or 0),
            "avg_power": int(v.get("avg_power") or 0),
            "cadence": int((v.get("avg_running_cadence") or 0) * 2),
            "elevation_gain": round(v.get("total_ascent") or 0, 1),
            "trimp": calc_trimp(dur, avg_hr, ath["sex"], ath["resting_hr"], ath["max_hr"]),
            "source": "zepp_icloud_fit"
        }, on_conflict="external_id").execute()
        print(f"Synced: {ext_id}")

if __name__ == "__main__":
    print("Starting Zepp iCloud FIT Auto-Sync...")
    while True:
        try:
            sync_once()
        except Exception as e:
            print("Sync Error:", e)
        time.sleep(300)
```

---

## 4. รายการสิ่งที่พี่ชายต้องทำเพิ่ม (Action Checklist)

### ส่วนที่ 1: เตรียมฐานข้อมูลและคีย์ (ทำครั้งเดียว)
1. **Supabase:** สร้างโปรเจกต์ใหม่ → เข้า `SQL Editor` → วางโค้ด `supabase/schema.sql` แล้วกด Run → คัดลอก `Project URL`, `anon key`, และ `service_role key`
2. **Google AI Studio:** เข้า `aistudio.google.com` → สร้าง API Key (`GEMINI_API_KEY`) สำหรับใช้งาน `gemini-2.5-flash`
3. **Cloudflare Tunnel + Ollama (Local Fallback):**
   - รัน Ollama บนเครื่อง Local (เช่น `ollama run qwen2.5:14b`)
   - เปิด Tunnel ด้วยคำสั่ง `cloudflared tunnel --url http://localhost:11434` (หรือสร้าง Named Tunnel ถาวรใน Cloudflare Zero Trust เพื่อให้ URL ไม่เปลี่ยนเวลาเปิดเครื่องใหม่)
   - นำ URL ไปใส่ใน `OLLAMA_CF_URL` บน Vercel
4. **Vercel Deploy:** Push โค้ดขึ้น GitHub → Import เข้า Vercel → ใส่ Environment Variables ทั้งหมดจาก `.env.example` แล้วกด Deploy

### ส่วนที่ 2: เชื่อมต่อข้อมูลจากนาฬิกา Amazfit T-Rex 3 / Zepp
1. **ฝั่ง Workout ละเอียด (Zepp → iCloud → Supabase):**
   - บนแอป Zepp (พี่ชายเปิดไว้แล้ว ✅): `Profile → Settings → Workout Data Storage and Backup → Cloud Storage Backup → iCloud Automatic Backup (ON)`
   - บนเครื่อง Mac / PC ที่ล็อกอิน iCloud เดียวกัน: รันสคริปต์ `scripts/zepp_icloud_sync.py` (ตั้งเป็น Background Service / LaunchAgent ให้ทำงานอัตโนมัติทุก 5 นาที)
   - *กรณีสมาชิกคนอื่นในครอบครัวใช้ Amazfit ด้วย:* แชร์โฟลเดอร์ `Zepp/FITs` หรือรันสคริปต์แยกตาม `ATHLETE_SLUG`
2. **ฝั่งสุขภาพรายวัน (Zepp → Apple Health → Supabase):**
   - บนแอป Zepp (พี่ชายเปิดไว้แล้ว ✅): `3rd-party account linking → Apple Health (Connected)` และเปิดสิทธิ์ให้ Zepp เขียนค่า Sleep, Heart Rate, HRV, Weight, Steps ลง Apple Health
   - บน iPhone ของสมาชิกแต่ละคน: ติดตั้งแอป **Health Auto Export** (หรือใช้ **Apple Shortcuts Automation** ตั้งเวลา 07:30 น. ทุกเช้า)
   - ตั้งค่าปลายทาง Webhook เป็น:
     - **URL:** `https://<your-vercel-domain>/api/ingest-health?u=pluk` (เปลี่ยน `pluk` เป็น slug ของแต่ละคน)
     - **Header:** `x-webhook-secret: <รหัสลับที่ตั้งใน Vercel>`
     - **Metrics ที่เลือกส่ง:** `Sleep Analysis`, `Heart Rate Variability`, `Resting Heart Rate`, `Weight / Body Mass`, `Step Count`

---

## 5. Prompt สำหรับส่งให้ Antigravity ทำงานต่อทันที

> **Copy ข้อความนี้ส่งให้ Antigravity:**
> "ใช้เอกสาร `ATHLETE_OS_BLUEPRINT.md` นี้สร้างโครงสร้างโปรเจกต์ `athlete-os` ให้ครบทุกไฟล์ (`package.json`, `vercel.json`, `.env.example`, `supabase/schema.sql`, `api/coach.js`, `api/ingest-health.js`, `scripts/zepp_icloud_sync.py`) และนำไฟล์ `index.html` วางไว้ที่ `public/index.html` จากนั้นอัปเดต `public/index.html` ให้เรียก `POST /api/coach` เมื่อต้องการสร้างบทวิเคราะห์ประจำวันและบทวิเคราะห์หลัง Workout (พร้อมแคชผลลัพธ์ลงตาราง `daily_metrics.ai_daily_brief` และ `workouts.ai_coach_report` ใน Supabase และให้ Fallback กลับมาใช้ฟังก์ชัน Rule-Based เดิมทันทีหาก `/api/coach` คืนค่า `data: null`) เสร็จแล้วเตรียม Git repo ให้พร้อม Push ขึ้น GitHub และ Deploy บน Vercel"