// api/sync-iphone.js — Unified Per-User Zero-MacBook iPhone Auto-Sync Endpoint
// Designed for Apple Shortcuts Automations (When Zepp Closes / Wake Up 07:30) & Health Auto Export.
// Strictly isolated per athlete (?u=<slug>&token=<user-token>):
// 1. Parses Apple Health Sleep (hours, Deep/REM/Light, raw Shortcuts duration strings/samples), HRV, RHR, Weight, Steps, SpO2
// 2. Parses native Zepp .FIT file(s) sent from iPhone iCloud Drive (fit_base64 or fit_files[])
// 3. Parses Apple Health workouts (workouts[] or data.workouts[]) and Smart-Fuses them with .FIT (zero duplicates!)
// 4. Immediately refreshes Gemini AI Daily Brief & Post-Workout AI Coach whenever new data arrives.
import { calcBanisterTRIMP, normalizeSportType, runAiCoach } from './_lib/coach-engine.js';
import { getSupabaseClient } from './_lib/supabase.js';
import {
  extractFitWorkout,
  parseFitBuffer,
  parseFlexibleNumber,
  parseFlexibleSleep,
  safeUpsertRow,
  toThaiIsoDate,
  upsertMergedWorkout,
  verifyUserSyncAuth
} from './_lib/sync-utils.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed (use POST)' });
  }

  const body = req.body || {};
  const slug = String(req.query.u || body.slug || '').trim().toLowerCase();
  if (!slug) {
    return res.status(400).json({ ok: false, error: 'Missing athlete slug (?u=<slug>)' });
  }

  const auth = verifyUserSyncAuth(req, slug);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, error: auth.error });
  }

  const sb = getSupabaseClient();
  if (!sb) {
    return res.status(503).json({ ok: false, error: 'Supabase is not configured' });
  }

  const { data: athlete, error: aErr } = await sb
    .from('athletes')
    .select('*')
    .eq('slug', slug)
    .single();

  if (aErr || !athlete) {
    return res.status(404).json({ ok: false, error: `Athlete profile "${slug}" not found` });
  }

  const today = toThaiIsoDate(null);
  let migrationNeeded = false;

  // =========================================================================
  // 1. PROCESS DAILY HEALTH METRICS & SLEEP (Apple Shortcuts / Health Auto Export)
  // =========================================================================
  const metricsByDate = new Map();
  const ensureMetric = (iso) => {
    if (!metricsByDate.has(iso)) {
      metricsByDate.set(iso, {
        base: { athlete_id: athlete.id, metric_date: iso },
        ext: {}
      });
    }
    return metricsByDate.get(iso);
  };

  // Format A: Health Auto Export (body.data.metrics[])
  if (Array.isArray(body?.data?.metrics)) {
    for (const m of body.data.metrics) {
      const name = String(m.name || '').toLowerCase();
      for (const entry of (m.data || [])) {
        const iso = toThaiIsoDate(entry.date);
        const rec = ensureMetric(iso);
        if (name.includes('sleep')) {
          const sl = parseFlexibleSleep(entry);
          if (sl.sleep_hours != null) rec.base.sleep_hours = sl.sleep_hours;
          if (sl.sleep_deep_min != null) rec.ext.sleep_deep_min = sl.sleep_deep_min;
          if (sl.sleep_rem_min != null) rec.ext.sleep_rem_min = sl.sleep_rem_min;
          if (sl.sleep_light_min != null) rec.ext.sleep_light_min = sl.sleep_light_min;
        }
        if (name.includes('heart_rate_variability')) {
          const val = parseFlexibleNumber(entry.qty);
          if (val != null && val > 0) rec.base.hrv = Math.round(val);
        }
        if (name.includes('resting_heart_rate')) {
          const val = parseFlexibleNumber(entry.qty);
          if (val != null && val > 0) rec.base.resting_hr = Math.round(val);
        }
        if (name.includes('weight') || name.includes('body_mass')) {
          const val = parseFlexibleNumber(entry.qty);
          if (val != null && val > 0) rec.base.weight_kg = +val.toFixed(1);
        }
        if (name.includes('step_count')) {
          const val = parseFlexibleNumber(entry.qty);
          if (val != null && val > 0) rec.base.steps = (rec.base.steps || 0) + Math.round(val);
        }
        if (name.includes('oxygen') || name.includes('spo2')) {
          const val = parseFlexibleNumber(entry.qty);
          if (val != null && val > 0) rec.ext.spo2 = +(val <= 1 ? val * 100 : val).toFixed(1);
        }
      }
    }
  }

  // Format B: Direct Apple Shortcuts JSON (supports strings with units, sample arrays, Thai/English durations)
  const sleepInput = body.sleep_samples ?? body.sleep_hours ?? body.sleep_minutes ?? body.sleep ?? null;
  const parsedSleep = parseFlexibleSleep(sleepInput);
  const directHrv = parseFlexibleNumber(body.hrv, { aggregate: 'avg' });
  const directRhr = parseFlexibleNumber(body.resting_hr ?? body.rhr, { aggregate: 'avg' });
  const directWeight = parseFlexibleNumber(body.weight_kg ?? body.weight, { aggregate: 'last' });
  const directSteps = parseFlexibleNumber(body.steps, { aggregate: 'sum' });
  const directSpo2 = parseFlexibleNumber(body.spo2 ?? body.blood_oxygen, { aggregate: 'avg' });
  const directDeep = parseFlexibleNumber(body.sleep_deep_min, { aggregate: 'sum' });
  const directRem = parseFlexibleNumber(body.sleep_rem_min, { aggregate: 'sum' });
  const directLight = parseFlexibleNumber(body.sleep_light_min, { aggregate: 'sum' });

  if (
    parsedSleep.sleep_hours != null ||
    directHrv != null ||
    directRhr != null ||
    directWeight != null ||
    directSteps != null ||
    directSpo2 != null ||
    directDeep != null ||
    directRem != null
  ) {
    const iso = toThaiIsoDate(body.metric_date || today);
    const rec = ensureMetric(iso);
    if (parsedSleep.sleep_hours != null) rec.base.sleep_hours = parsedSleep.sleep_hours;
    if (directHrv != null && directHrv > 0) rec.base.hrv = Math.round(directHrv);
    if (directRhr != null && directRhr > 0) rec.base.resting_hr = Math.round(directRhr);
    if (directWeight != null && directWeight > 0) rec.base.weight_kg = +directWeight.toFixed(1);
    if (directSteps != null && directSteps >= 0) rec.base.steps = Math.round(directSteps);
    if (directDeep != null && directDeep > 0) rec.ext.sleep_deep_min = Math.round(directDeep);
    else if (parsedSleep.sleep_deep_min != null) rec.ext.sleep_deep_min = parsedSleep.sleep_deep_min;
    if (directRem != null && directRem > 0) rec.ext.sleep_rem_min = Math.round(directRem);
    else if (parsedSleep.sleep_rem_min != null) rec.ext.sleep_rem_min = parsedSleep.sleep_rem_min;
    if (directLight != null && directLight > 0) rec.ext.sleep_light_min = Math.round(directLight);
    else if (parsedSleep.sleep_light_min != null) rec.ext.sleep_light_min = parsedSleep.sleep_light_min;
    if (directSpo2 != null && directSpo2 > 0) {
      rec.ext.spo2 = +(directSpo2 <= 1 ? directSpo2 * 100 : directSpo2).toFixed(1);
    }
  }

  const savedMetrics = [];
  let dailyAiProvider = 'skipped';

  for (const { base, ext } of metricsByDate.values()) {
    const { data: existing } = await sb
      .from('daily_metrics')
      .select('*')
      .eq('athlete_id', athlete.id)
      .eq('metric_date', base.metric_date)
      .maybeSingle();

    const coreVitalsChanged =
      (base.sleep_hours != null && Number(base.sleep_hours) !== Number(existing?.sleep_hours)) ||
      (base.hrv != null && Number(base.hrv) !== Number(existing?.hrv)) ||
      (base.resting_hr != null && Number(base.resting_hr) !== Number(existing?.resting_hr));

    const mergedBase = {
      athlete_id: athlete.id,
      metric_date: base.metric_date,
      sleep_hours: base.sleep_hours ?? existing?.sleep_hours ?? null,
      hrv: base.hrv ?? existing?.hrv ?? null,
      resting_hr: base.resting_hr ?? existing?.resting_hr ?? null,
      weight_kg: base.weight_kg ?? existing?.weight_kg ?? athlete.weight_kg,
      steps: base.steps ?? existing?.steps ?? null
    };

    const mergedExt = {
      sleep_deep_min: ext.sleep_deep_min ?? existing?.sleep_deep_min ?? null,
      sleep_rem_min: ext.sleep_rem_min ?? existing?.sleep_rem_min ?? null,
      sleep_light_min: ext.sleep_light_min ?? existing?.sleep_light_min ?? null,
      spo2: ext.spo2 ?? existing?.spo2 ?? null
    };

    const up = await safeUpsertRow(sb, 'daily_metrics', mergedBase, mergedExt, 'athlete_id,metric_date');
    if (up.error) return res.status(500).json({ ok: false, error: up.error.message });
    if (up.schemaFallback) migrationNeeded = true;

    let finalMetric = up.data;
    const hasCoreVitals =
      finalMetric.sleep_hours != null || finalMetric.hrv != null || finalMetric.resting_hr != null;

    // Immediately regenerate AI Daily Brief whenever new Sleep/HRV/RHR arrives or changes
    if (body.analyze !== false && hasCoreVitals && (coreVitalsChanged || !finalMetric.ai_daily_brief || body.analyze === true)) {
      const aiRes = await runAiCoach({
        mode: 'daily',
        athlete,
        metrics: { ...finalMetric, ...mergedExt },
        pmc: body.pmc || null
      });
      dailyAiProvider = aiRes.provider;
      if (aiRes.data) {
        const cachedBrief = {
          ...aiRes.data,
          _provider: aiRes.provider,
          _generatedAt: new Date().toISOString()
        };
        const { data: updated } = await sb
          .from('daily_metrics')
          .update({ ai_daily_brief: cachedBrief })
          .eq('id', finalMetric.id)
          .select()
          .single();
        if (updated) finalMetric = updated;
      }
    }

    savedMetrics.push(finalMetric);
  }

  // =========================================================================
  // 2. PROCESS ZEPP .FIT FILES (FROM IPHONE ICLOUD VIA APPLE SHORTCUTS)
  // =========================================================================
  const fitInputs = [];
  if (body.fit_base64) {
    fitInputs.push({ filename: body.filename || `Zepp_${Date.now()}.fit`, fit_base64: body.fit_base64 });
  }
  if (Array.isArray(body.fit_files)) {
    for (const f of body.fit_files) {
      if (f?.fit_base64) {
        fitInputs.push({ filename: f.filename || `Zepp_${Date.now()}.fit`, fit_base64: f.fit_base64 });
      }
    }
  }

  const savedWorkouts = [];
  let mergedCount = 0;
  let workoutAiProvider = 'skipped';

  for (let i = 0; i < fitInputs.length; i++) {
    const item = fitInputs[i];
    const cleanB64 = String(item.fit_base64).replace(/\s+/g, '');
    const parsed = await parseFitBuffer(Buffer.from(cleanB64, 'base64'));
    const { base, extended } = extractFitWorkout(parsed, item.filename, athlete);
    base.source = 'iphone_shortcut_fit';

    const savedRes = await upsertMergedWorkout(sb, athlete, base, extended);
    if (savedRes.error) return res.status(500).json({ ok: false, error: savedRes.error.message });
    if (savedRes.schemaFallback) migrationNeeded = true;
    if (savedRes.merged) mergedCount++;

    let finalWo = savedRes.data;
    if (body.analyze !== false && i === 0 && !finalWo.ai_coach_report) {
      const aiRes = await runAiCoach({
        mode: 'workout',
        athlete,
        workout: { ...finalWo, ...extended },
        pmc: body.pmc || null
      });
      workoutAiProvider = aiRes.provider;
      if (aiRes.data) {
        const cachedReport = {
          ...aiRes.data,
          _provider: aiRes.provider,
          _generatedAt: new Date().toISOString()
        };
        const { data: updated } = await sb
          .from('workouts')
          .update({ ai_coach_report: cachedReport })
          .eq('id', finalWo.id)
          .select()
          .single();
        if (updated) finalWo = updated;
      }
    }
    savedWorkouts.push(finalWo);
  }

  // =========================================================================
  // 3. PROCESS APPLE HEALTH WORKOUTS (SMART-FUSED WITH .FIT — ZERO DUPLICATES!)
  // =========================================================================
  const ahWorkouts = Array.isArray(body?.data?.workouts)
    ? body.data.workouts
    : (Array.isArray(body.workouts) ? body.workouts : []);

  for (const w of ahWorkouts) {
    const startIso = toThaiIsoDate(w.start || w.workout_date);
    const rawName = String(w.name || w.title || w.workoutActivityType || w.sport_type || 'Workout');
    const sportType = normalizeSportType(w.sport_type || rawName);
    const rawDur = parseFlexibleNumber(w.duration_min ?? w.duration) || 1;
    const durationMin = Math.max(1, +(rawDur > 300 && w.duration_min == null ? rawDur / 60 : rawDur).toFixed(2));
    const distVal = parseFlexibleNumber(w.distance_km ?? w.distance) || 0;
    const distUnit = String(w.distance?.units || 'km').toLowerCase();
    const distanceKm = +(distUnit === 'm' ? distVal / 1000 : distUnit === 'mi' ? distVal * 1.60934 : distVal).toFixed(2);
    const avgHr = Math.round(
      parseFlexibleNumber(w.avg_hr ?? w.avgHeartRate ?? w.heartRateData?.[0]?.Avg) ||
        (Number(athlete.resting_hr) || 55) + 65
    );
    const maxHr = Math.round(parseFlexibleNumber(w.max_hr ?? w.maxHeartRate ?? w.heartRateData?.[0]?.Max) || 0);
    const calories = Math.round(parseFlexibleNumber(w.total_calories ?? w.activeEnergyBurned ?? w.calories) || 0);
    const trimp = calcBanisterTRIMP(durationMin, avgHr, athlete);
    const extKey = w.id || `${startIso}_${rawName}_${Math.round(durationMin)}`;

    const base = {
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
      elevation_gain: +(parseFlexibleNumber(w.elevation_gain ?? w.elevationUp) || 0).toFixed(1),
      rpe: 6,
      trimp,
      source: 'apple_health_auto'
    };
    const ext = { total_calories: calories };

    const savedRes = await upsertMergedWorkout(sb, athlete, base, ext);
    if (!savedRes.error && savedRes.data) {
      if (savedRes.schemaFallback) migrationNeeded = true;
      if (savedRes.merged) mergedCount++;
      savedWorkouts.push(savedRes.data);
    }
  }

  return res.status(200).json({
    ok: true,
    athlete: { id: athlete.id, slug: athlete.slug, name: athlete.name },
    auth_mode: auth.mode,
    metrics_saved: savedMetrics.length,
    workouts_saved: savedWorkouts.length,
    workouts_merged: mergedCount,
    daily_ai_provider: dailyAiProvider,
    workout_ai_provider: workoutAiProvider,
    migration_needed: migrationNeeded,
    saved_metrics: savedMetrics,
    saved_workouts: savedWorkouts
  });
}
