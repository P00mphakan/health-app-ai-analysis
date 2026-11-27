// api/ingest-zepp.js — Zepp / Amazfit Cloud Bridge API
// Accepts native .FIT binary (base64) or structured JSON from:
// 1. Direct .FIT upload from ATHLETE OS web app (preview or bulk import)
// 2. Local Python Zepp Bridge (zepp-bridge/server.py)
// 3. iPhone Apple Shortcuts (supports per-user isolated token ?u=<slug>&token=<token>)
// Extracts rich Amazfit/Zepp .FIT telemetry (calories, Aerobic/Anaerobic TE, EPOC Load, Power, Cadence, Elevation),
// smart-fuses with Apple Health (zero duplicates), and triggers Gemini AI Coach automatically.
import { calcBanisterTRIMP, normalizeSportType, runAiCoach } from './_lib/coach-engine.js';
import { getSupabaseClient } from './_lib/supabase.js';
import {
  extractFitWorkout,
  parseFitBuffer,
  toThaiIsoDate,
  upsertMergedWorkout,
  verifyUserSyncAuth
} from './_lib/sync-utils.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = req.body || {};
  const slug = String(req.query.u || body.slug || '').trim().toLowerCase();
  const allowSameOrigin = body.mode === 'preview' || body.source === 'web_fit_upload';

  const auth = verifyUserSyncAuth(req, slug, { allowSameOrigin });
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }

  const sb = getSupabaseClient();
  if (!sb) {
    return res.status(503).json({ ok: false, error: 'Supabase is not configured' });
  }

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
    let entriesToSave = [];

    if (body.fit_base64) {
      const cleanB64 = String(body.fit_base64).replace(/\s+/g, '');
      const parsed = await parseFitBuffer(Buffer.from(cleanB64, 'base64'));
      const { base, extended } = extractFitWorkout(parsed, body.filename, athlete);

      if (body.sport_type) base.sport_type = normalizeSportType(body.sport_type);
      if (body.avg_power != null && Number(body.avg_power) > 0) base.avg_power = Math.round(Number(body.avg_power));
      if (body.rpe != null && Number(body.rpe) > 0) base.rpe = Math.round(Number(body.rpe));
      if (body.title) base.title = String(body.title).trim();
      if (body.source) base.source = String(body.source).trim();

      if (body.mode === 'preview') {
        return res.status(200).json({ ok: true, preview: { ...base, ...extended } });
      }
      entriesToSave = [{ base, extended }];
    } else if (Array.isArray(body.workouts)) {
      entriesToSave = body.workouts.map((w) => buildWorkoutEntry(w, athlete));
    } else if (body.duration_min != null || body.avg_hr != null || body.workout) {
      entriesToSave = [buildWorkoutEntry(body.workout || body, athlete)];
    } else {
      return res.status(400).json({ ok: false, error: 'Missing fit_base64 or workout payload' });
    }

    const shouldAnalyze = body.analyze !== false;
    const savedList = [];
    let migrationNeeded = false;

    for (const { base, extended } of entriesToSave) {
      const up = await upsertMergedWorkout(sb, athlete, base, extended);
      if (up.error) {
        return res.status(500).json({ ok: false, error: up.error.message });
      }
      if (up.schemaFallback) migrationNeeded = true;

      let finalRow = up.data;
      let aiProvider = 'skipped';

      if (shouldAnalyze && !finalRow.ai_coach_report) {
        const aiRes = await runAiCoach({
          mode: 'workout',
          athlete,
          workout: { ...finalRow, ...extended },
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
            .eq('id', finalRow.id)
            .select()
            .single();
          if (updated) finalRow = updated;
        }
      }

      savedList.push({ workout: finalRow, ai_provider: aiProvider, merged: Boolean(up.merged) });
    }

    return res.status(200).json({
      ok: true,
      count: savedList.length,
      merged: savedList.some((x) => x.merged),
      migration_needed: migrationNeeded,
      saved: savedList.length === 1 ? savedList[0].workout : savedList.map((x) => x.workout),
      ai_provider: savedList[0]?.ai_provider || 'rule-based-fallback'
    });
  } catch (err) {
    console.error('api/ingest-zepp error:', err);
    return res.status(400).json({ ok: false, error: err?.message || 'Failed to parse Zepp workout data' });
  }
}

function buildWorkoutEntry(w, athlete) {
  const durationMin = Math.max(1, +(Number(w.duration_min) || 1).toFixed(2));
  const avgHr = Math.round(Number(w.avg_hr) || (Number(athlete.resting_hr) || 55) + 70);
  const workoutDate = w.workout_date || toThaiIsoDate(null);
  const sportType = normalizeSportType(w.sport_type || w.sport);
  const trimp = Number(w.trimp) > 0 ? +Number(w.trimp).toFixed(1) : calcBanisterTRIMP(durationMin, avgHr, athlete);

  const base = {
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

  const extended = {
    min_hr: Math.round(Number(w.min_hr) || 0),
    max_power: Math.round(Number(w.max_power) || 0),
    avg_speed_kmh: +(Number(w.avg_speed_kmh) || 0).toFixed(2),
    total_calories: Math.round(Number(w.total_calories) || 0),
    aerobic_te: +(Number(w.aerobic_te) || 0).toFixed(1),
    anaerobic_te: +(Number(w.anaerobic_te) || 0).toFixed(1),
    training_load_peak: Math.round(Number(w.training_load_peak) || 0)
  };

  return { base, extended };
}
