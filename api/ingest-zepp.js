// api/ingest-zepp.js — Zepp / Amazfit Cloud Bridge API
// Accepts native .FIT binary (base64), .GPX XML, or structured JSON from:
// 1. Local Python Zepp Bridge (zepp-bridge/server.py watching Zepp iCloud FITs)
// 2. Direct .FIT upload from the ATHLETE OS web app (preview or save)
// 3. Apple Shortcuts / Health Auto Export / n8n webhooks
// Automatically computes sex-differentiated Banister TRIMP, saves to Supabase,
// and runs Gemini AI Coach analysis so ai_coach_report is ready immediately.
import { createClient } from '@supabase/supabase-js';
import FitParser from 'fit-file-parser';
import { calcBanisterTRIMP, normalizeSportType, runAiCoach } from './_lib/coach-engine.js';

function parseFitBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({
      force: true,
      speedUnit: 'km/h',
      lengthUnit: 'km',
      temperatureUnit: 'celsius',
      elapsedRecordField: true,
      mode: 'list'
    });
    parser.parse(buffer, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function toIsoDate(dt) {
  if (!dt) return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const d = dt instanceof Date ? dt : new Date(dt);
  if (Number.isNaN(d.getTime())) {
    return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  }
  return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function extractFitWorkout(parsed, filename, athlete) {
  const session = parsed?.sessions?.[0] || null;
  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  const stem = String(filename || 'zepp_workout').replace(/\.fit$/i, '');

  let durationMin = 0;
  let distanceKm = 0;
  let avgHr = 0;
  let maxHr = 0;
  let avgPower = 0;
  let cadence = 0;
  let elevationGain = 0;
  let rawSport = 'running';
  let startTime = null;

  if (session) {
    startTime = session.start_time || session.timestamp || null;
    durationMin = +(((session.total_timer_time || session.total_elapsed_time || 0)) / 60).toFixed(2);
    distanceKm = +(Number(session.total_distance || 0)).toFixed(2);
    avgHr = Math.round(Number(session.avg_heart_rate || 0));
    maxHr = Math.round(Number(session.max_heart_rate || 0));
    avgPower = Math.round(Number(session.avg_power || 0));
    const rawCad = Number(session.avg_running_cadence || session.avg_cadence || 0);
    cadence = rawCad > 0 && rawCad < 110 ? Math.round(rawCad * 2) : Math.round(rawCad);
    elevationGain = +(Number(session.total_ascent || 0)).toFixed(1);
    rawSport = String(session.sport || session.sub_sport || 'running');
  } else if (records.length > 0) {
    startTime = records[0].timestamp || null;
    const endTime = records[records.length - 1].timestamp || null;
    if (startTime && endTime) {
      durationMin = Math.max(1, +((new Date(endTime) - new Date(startTime)) / 60000).toFixed(2));
    } else {
      durationMin = +(records.length / 60).toFixed(2);
    }
    const lastDist = [...records].reverse().find((r) => typeof r.distance === 'number')?.distance || 0;
    distanceKm = +Number(lastDist).toFixed(2);
    const hrs = records.map((r) => Number(r.heart_rate)).filter((v) => v > 30 && v < 230);
    if (hrs.length) {
      avgHr = Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length);
      maxHr = Math.max(...hrs);
    }
  }

  if (avgHr <= 0) avgHr = (Number(athlete?.resting_hr) || 55) + 70;
  if (durationMin <= 0) durationMin = 1;

  const sportType = normalizeSportType(rawSport);
  const workoutDate = toIsoDate(startTime);
  const niceSport = rawSport.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const trimp = calcBanisterTRIMP(durationMin, avgHr, athlete);

  return {
    athlete_id: athlete.id,
    external_id: `fit_${athlete.slug}_${stem}`,
    workout_date: workoutDate,
    sport_type: sportType,
    title: `Zepp ${niceSport} (${stem})`,
    duration_min: durationMin,
    distance_km: distanceKm,
    avg_hr: avgHr,
    max_hr: maxHr,
    avg_power: avgPower,
    cadence,
    elevation_gain: elevationGain,
    rpe: 7,
    trimp,
    source: 'zepp_fit_bridge'
  };
}

function isSameOriginWebRequest(req) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const origin = (req.headers.origin || '').toLowerCase();
  const referer = (req.headers.referer || '').toLowerCase();
  if (!host) return false;
  return origin.includes(host) || referer.includes(host);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = req.body || {};
  const secret = req.headers['x-webhook-secret'] || req.query.secret || '';
  const allowWebPreviewOrUpload =
    (body.mode === 'preview' || body.source === 'web_fit_upload') && isSameOriginWebRequest(req);

  if (process.env.WEBHOOK_SECRET && !allowWebPreviewOrUpload && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized (invalid x-webhook-secret)' });
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (!supabaseUrl || !supabaseKey) {
    return res.status(503).json({ ok: false, error: 'Supabase environment variables are not configured' });
  }

  const sb = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  // Resolve target athlete (by slug, athlete_id, or first athlete if only one exists)
  const slug = String(req.query.u || body.slug || '').trim().toLowerCase();
  const athleteId = body.athlete_id ? String(body.athlete_id).trim() : '';

  let athlete = null;
  if (athleteId) {
    const { data } = await sb.from('athletes').select('*').eq('id', athleteId).single();
    athlete = data;
  } else if (slug) {
    const { data } = await sb.from('athletes').select('*').eq('slug', slug).single();
    athlete = data;
  } else {
    const { data } = await sb.from('athletes').select('*').order('created_at', { ascending: true }).limit(1);
    athlete = data?.[0] || null;
  }

  if (!athlete) {
    return res.status(404).json({ ok: false, error: `Athlete "${slug || athleteId || 'default'}" not found` });
  }

  try {
    // 1. Parse .FIT binary if provided
    let workoutsToSave = [];
    if (body.fit_base64) {
      const buf = Buffer.from(String(body.fit_base64), 'base64');
      const parsed = await parseFitBuffer(buf);
      const extracted = extractFitWorkout(parsed, body.filename, athlete);

      // Apply optional user overrides from preview/web upload
      if (body.sport_type) extracted.sport_type = normalizeSportType(body.sport_type);
      if (body.avg_power != null && Number(body.avg_power) > 0) extracted.avg_power = Math.round(Number(body.avg_power));
      if (body.rpe != null && Number(body.rpe) > 0) extracted.rpe = Math.round(Number(body.rpe));
      if (body.title) extracted.title = String(body.title).trim();
      if (body.source) extracted.source = String(body.source).trim();

      if (body.mode === 'preview') {
        return res.status(200).json({ ok: true, preview: extracted });
      }
      workoutsToSave = [extracted];
    } else if (Array.isArray(body.workouts)) {
      workoutsToSave = body.workouts.map((w) => buildWorkoutRecord(w, athlete));
    } else if (body.duration_min != null || body.avg_hr != null || body.workout) {
      workoutsToSave = [buildWorkoutRecord(body.workout || body, athlete)];
    } else {
      return res.status(400).json({ ok: false, error: 'Missing fit_base64 or workout payload' });
    }

    const shouldAnalyze = body.analyze !== false;
    const savedList = [];

    for (const record of workoutsToSave) {
      const { data: saved, error: upErr } = await sb
        .from('workouts')
        .upsert(record, { onConflict: 'external_id' })
        .select()
        .single();

      if (upErr) {
        return res.status(500).json({ ok: false, error: upErr.message });
      }

      let finalRow = saved;
      let aiProvider = 'skipped';

      // Auto-run Gemini AI Coach immediately if report is not yet cached
      if (shouldAnalyze && !saved.ai_coach_report) {
        const aiRes = await runAiCoach({
          mode: 'workout',
          athlete,
          workout: saved,
          pmc: body.pmc || null
        });
        aiProvider = aiRes.provider;
        if (aiRes.data) {
          const cachedReport = {
            ...aiRes.data,
            _provider: aiRes.provider,
            _generatedAt: new Date().toISOString()
          };
          const { data: updated } = await sb
            .from('workouts')
            .update({ ai_coach_report: cachedReport })
            .eq('id', saved.id)
            .select()
            .single();
          if (updated) finalRow = updated;
        }
      }

      savedList.push({ workout: finalRow, ai_provider: aiProvider });
    }

    return res.status(200).json({
      ok: true,
      count: savedList.length,
      saved: savedList.length === 1 ? savedList[0].workout : savedList.map((x) => x.workout),
      ai_provider: savedList[0]?.ai_provider || 'rule-based-fallback'
    });
  } catch (err) {
    console.error('api/ingest-zepp error:', err);
    return res.status(400).json({ ok: false, error: err?.message || 'Failed to parse Zepp workout data' });
  }
}

function buildWorkoutRecord(w, athlete) {
  const durationMin = Math.max(1, +(Number(w.duration_min) || 1).toFixed(2));
  const avgHr = Math.round(Number(w.avg_hr) || (Number(athlete.resting_hr) || 55) + 70);
  const workoutDate = w.workout_date || toIsoDate(null);
  const sportType = normalizeSportType(w.sport_type || w.sport);
  const trimp = Number(w.trimp) > 0 ? +Number(w.trimp).toFixed(1) : calcBanisterTRIMP(durationMin, avgHr, athlete);

  return {
    athlete_id: athlete.id,
    external_id: w.external_id || `zepp_${athlete.slug}_${workoutDate}_${Date.now()}`,
    workout_date: workoutDate,
    sport_type: sportType,
    title: String(w.title || `Zepp ${sportType}`).trim(),
    duration_min: durationMin,
    distance_km: +(Number(w.distance_km) || 0).toFixed(2),
    avg_hr: avgHr,
    max_hr: Math.round(Number(w.max_hr) || 0),
    avg_power: Math.round(Number(w.avg_power) || 0),
    cadence: Math.round(Number(w.cadence) || 0),
    elevation_gain: +(Number(w.elevation_gain) || 0).toFixed(1),
    rpe: Math.round(Number(w.rpe) || 6),
    trimp,
    source: String(w.source || 'zepp_bridge')
  };
}
