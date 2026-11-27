// api/ingest-health.js — Unified Zero-MacBook iPhone Auto-Sync Webhook
// Accepts BOTH Daily Health Metrics (Sleep, HRV, RHR, Weight, Steps) AND Workouts
// from iOS Health Auto Export or Apple Shortcuts -> Supabase + Gemini AI Coach
import { calcBanisterTRIMP, normalizeSportType, runAiCoach } from './_lib/coach-engine.js';
import { getSupabaseClient } from './_lib/supabase.js';

function toThaiIsoDate(val) {
  if (val) {
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    }
  }
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function parseHealthAutoExportSleep(entry) {
  const hrs =
    Number(entry?.asleep ?? 0) ||
    (Number(entry?.core ?? 0) + Number(entry?.deep ?? 0) + Number(entry?.rem ?? 0)) ||
    Number(entry?.qty ?? 0);
  if (!hrs || hrs <= 0) return null;
  // Some Health Auto Export configs send minutes (> 24) instead of hours
  return +(hrs > 24 ? hrs / 60 : hrs).toFixed(2);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const sb = getSupabaseClient();
  if (!sb) {
    return res.status(503).json({ ok: false, error: 'Supabase is not configured' });
  }

  const slug = (req.query.u || req.body?.slug || '').trim().toLowerCase();
  let athlete = null;
  if (slug) {
    const { data } = await sb.from('athletes').select('*').eq('slug', slug).single();
    athlete = data;
  } else {
    const { data } = await sb.from('athletes').select('*').order('created_at', { ascending: true }).limit(1);
    athlete = data?.[0] || null;
  }
  if (!athlete) return res.status(404).json({ ok: false, error: `Athlete slug "${slug || 'default'}" not found` });

  const body = req.body || {};
  const today = toThaiIsoDate(null);

  // ---- 1. COLLECT DAILY METRICS (supports single JSON or multi-day Health Auto Export) ----
  const metricsByDate = new Map();
  const ensureMetric = (iso) => {
    if (!metricsByDate.has(iso)) {
      metricsByDate.set(iso, {
        athlete_id: athlete.id,
        metric_date: iso
      });
    }
    return metricsByDate.get(iso);
  };

  if (Array.isArray(body?.data?.metrics)) {
    for (const m of body.data.metrics) {
      const name = String(m.name || '').toLowerCase();
      for (const entry of (m.data || [])) {
        const iso = toThaiIsoDate(entry.date);
        const rec = ensureMetric(iso);
        if (name.includes('sleep')) {
          const sleepH = parseHealthAutoExportSleep(entry);
          if (sleepH != null) rec.sleep_hours = sleepH;
        }
        if (name.includes('heart_rate_variability')) {
          const val = Math.round(Number(entry.qty || 0));
          if (val > 0) rec.hrv = val;
        }
        if (name.includes('resting_heart_rate')) {
          const val = Math.round(Number(entry.qty || 0));
          if (val > 0) rec.resting_hr = val;
        }
        if (name.includes('weight') || name.includes('body_mass')) {
          const val = +(Number(entry.qty || 0)).toFixed(1);
          if (val > 0) rec.weight_kg = val;
        }
        if (name.includes('step_count')) {
          const val = Math.round(Number(entry.qty || 0));
          if (val > 0) rec.steps = (rec.steps || 0) + val;
        }
      }
    }
  } else if (
    body.sleep_hours != null ||
    body.hrv != null ||
    body.resting_hr != null ||
    body.weight_kg != null ||
    body.steps != null
  ) {
    const iso = toThaiIsoDate(body.metric_date || today);
    const rec = ensureMetric(iso);
    if (body.sleep_hours != null) rec.sleep_hours = +Number(body.sleep_hours).toFixed(2);
    if (body.hrv != null) rec.hrv = Math.round(Number(body.hrv));
    if (body.resting_hr != null) rec.resting_hr = Math.round(Number(body.resting_hr));
    if (body.weight_kg != null) rec.weight_kg = +Number(body.weight_kg).toFixed(1);
    if (body.steps != null) rec.steps = Math.round(Number(body.steps));
  }

  const savedMetrics = [];
  for (const rec of metricsByDate.values()) {
    const hasAnyField =
      rec.sleep_hours != null ||
      rec.hrv != null ||
      rec.resting_hr != null ||
      rec.weight_kg != null ||
      rec.steps != null;
    if (!hasAnyField) continue;

    // Preserve existing fields on the same day when partial Apple Health updates arrive
    const { data: existing } = await sb
      .from('daily_metrics')
      .select('*')
      .eq('athlete_id', athlete.id)
      .eq('metric_date', rec.metric_date)
      .maybeSingle();

    const merged = {
      athlete_id: athlete.id,
      metric_date: rec.metric_date,
      sleep_hours: rec.sleep_hours ?? existing?.sleep_hours ?? null,
      hrv: rec.hrv ?? existing?.hrv ?? null,
      resting_hr: rec.resting_hr ?? existing?.resting_hr ?? null,
      weight_kg: rec.weight_kg ?? existing?.weight_kg ?? athlete.weight_kg,
      steps: rec.steps ?? existing?.steps ?? null
    };

    const { data, error } = await sb
      .from('daily_metrics')
      .upsert(merged, { onConflict: 'athlete_id,metric_date' })
      .select()
      .single();

    if (error) return res.status(500).json({ ok: false, error: error.message });
    savedMetrics.push(data);
  }

  // ---- 2. COLLECT WORKOUTS FROM HEALTH AUTO EXPORT (data.workouts array) ----
  const savedWorkouts = [];
  if (Array.isArray(body?.data?.workouts)) {
    for (const w of body.data.workouts) {
      const startIso = toThaiIsoDate(w.start);
      const rawName = String(w.name || w.workoutActivityType || 'Workout');
      const sportType = normalizeSportType(rawName);
      const durationSec = Number(w.duration || 0);
      const durationMin = Math.max(1, +(durationSec > 300 ? durationSec / 60 : durationSec).toFixed(2));
      const distVal = Number(w.distance?.qty ?? w.distance ?? 0);
      const distUnit = String(w.distance?.units || 'km').toLowerCase();
      const distanceKm = +(distUnit === 'm' ? distVal / 1000 : distUnit === 'mi' ? distVal * 1.60934 : distVal).toFixed(2);
      const avgHr = Math.round(
        Number(w.avgHeartRate?.qty ?? w.heartRateData?.[0]?.Avg ?? w.avg_hr ?? 0) ||
          (Number(athlete.resting_hr) || 55) + 65
      );
      const maxHr = Math.round(Number(w.maxHeartRate?.qty ?? w.heartRateData?.[0]?.Max ?? w.max_hr ?? 0));
      const trimp = calcBanisterTRIMP(durationMin, avgHr, athlete);
      const extKey = w.id || `${startIso}_${rawName}_${Math.round(durationMin)}`;

      const record = {
        athlete_id: athlete.id,
        external_id: `applehealth_${athlete.slug}_${extKey}`.replace(/[^a-zA-Z0-9_-]/g, '_'),
        workout_date: startIso,
        sport_type: sportType,
        title: `Apple Health ${rawName}`,
        duration_min: durationMin,
        distance_km: distanceKm,
        avg_hr: avgHr,
        max_hr: maxHr,
        avg_power: 0,
        cadence: 0,
        elevation_gain: +(Number(w.elevationUp?.qty ?? 0)).toFixed(1),
        rpe: 6,
        trimp,
        source: 'apple_health_auto'
      };

      const { data: savedW, error: wErr } = await sb
        .from('workouts')
        .upsert(record, { onConflict: 'external_id' })
        .select()
        .single();
      if (!wErr && savedW) savedWorkouts.push(savedW);
    }
  }

  // ---- 3. AUTO-GENERATE DAILY AI BRIEF ON LATEST METRIC ----
  let aiProvider = 'skipped';
  const latestMetric = savedMetrics.toSorted((a, b) => b.metric_date.localeCompare(a.metric_date))[0] || null;
  if (latestMetric) {
    const hasCoreVitals =
      latestMetric.sleep_hours != null || latestMetric.hrv != null || latestMetric.resting_hr != null;
    if (body.analyze === true || (!latestMetric.ai_daily_brief && hasCoreVitals)) {
      const aiRes = await runAiCoach({
        mode: 'daily',
        athlete,
        metrics: latestMetric,
        pmc: body.pmc || null
      });
      aiProvider = aiRes.provider;
      if (aiRes.data) {
        const cachedBrief = {
          ...aiRes.data,
          _provider: aiRes.provider,
          _generatedAt: new Date().toISOString()
        };
        await sb.from('daily_metrics').update({ ai_daily_brief: cachedBrief }).eq('id', latestMetric.id);
      }
    }
  }

  return res.status(200).json({
    ok: true,
    metrics_saved: savedMetrics.length,
    workouts_saved: savedWorkouts.length,
    saved: latestMetric || savedWorkouts[0] || null,
    ai_provider: aiProvider
  });
}
