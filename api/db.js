// api/db.js — Vercel Serverless Backend for Automatic Supabase Connection
// Uses server-side Environment Variables (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
// so clients never need to enter or expose database credentials.
import { createClient } from '@supabase/supabase-js';

function getBackendStatus(supabaseConnected) {
  return {
    supabase: Boolean(supabaseConnected),
    aiPrimary: Boolean(process.env.GEMINI_API_KEY),
    aiPrimaryModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    aiFallback: Boolean(process.env.OLLAMA_CF_URL),
    aiFallbackModel: process.env.OLLAMA_MODEL || 'qwen2.5:14b',
    webhook: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  };
}

function getSupabaseClient() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function pickFields(obj, allowedKeys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const key of allowedKeys) {
    if (Object.hasOwn(obj, key) && obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
}

const ATHLETE_FIELDS = [
  'slug',
  'name',
  'sex',
  'birth_date',
  'weight_kg',
  'height_cm',
  'max_hr',
  'resting_hr',
  'hrv_baseline'
];

const DAILY_METRIC_FIELDS = [
  'athlete_id',
  'metric_date',
  'sleep_hours',
  'hrv',
  'resting_hr',
  'weight_kg',
  'steps',
  'ai_daily_brief'
];

const WORKOUT_FIELDS = [
  'athlete_id',
  'external_id',
  'workout_date',
  'sport_type',
  'title',
  'duration_min',
  'distance_km',
  'avg_hr',
  'max_hr',
  'avg_power',
  'cadence',
  'elevation_gain',
  'rpe',
  'trimp',
  'source',
  'ai_coach_report'
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const sb = getSupabaseClient();
  if (!sb) {
    return res.status(503).json({
      ok: false,
      error: 'Supabase environment variables are not configured on the server',
      status: getBackendStatus(false)
    });
  }

  try {
    // GET /api/db — Bootstrap all family data + backend status in one call
    if (req.method === 'GET') {
      const [
        { data: athletes, error: aErr },
        { data: dailyMetrics, error: mErr },
        { data: workouts, error: wErr }
      ] = await Promise.all([
        sb.from('athletes').select('*').order('created_at', { ascending: true }),
        sb.from('daily_metrics').select('*').order('metric_date', { ascending: false }),
        sb.from('workouts').select('*').order('workout_date', { ascending: false })
      ]);

      const err = aErr || mErr || wErr;
      if (err) {
        return res.status(500).json({
          ok: false,
          error: err.message,
          status: getBackendStatus(false)
        });
      }

      return res.status(200).json({
        ok: true,
        athletes: athletes || [],
        daily_metrics: dailyMetrics || [],
        workouts: workouts || [],
        status: getBackendStatus(true)
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const { action, id, payload } = req.body || {};
    if (!action) {
      return res.status(400).json({ ok: false, error: 'Missing action' });
    }

    switch (action) {
      case 'create_athlete': {
        const record = pickFields(payload, ATHLETE_FIELDS);
        const { data, error } = await sb.from('athletes').insert(record).select().single();
        if (error) return res.status(400).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, data });
      }

      case 'update_athlete': {
        if (!id) return res.status(400).json({ ok: false, error: 'Missing athlete id' });
        const record = pickFields(payload, ATHLETE_FIELDS);
        const { data, error } = await sb.from('athletes').update(record).eq('id', id).select().single();
        if (error) return res.status(400).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, data });
      }

      case 'delete_athlete': {
        if (!id) return res.status(400).json({ ok: false, error: 'Missing athlete id' });
        const { error } = await sb.from('athletes').delete().eq('id', id);
        if (error) return res.status(400).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      case 'upsert_daily_metric': {
        const record = pickFields(payload, DAILY_METRIC_FIELDS);
        const { data, error } = await sb
          .from('daily_metrics')
          .upsert(record, { onConflict: 'athlete_id,metric_date' })
          .select()
          .single();
        if (error) return res.status(400).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, data });
      }

      case 'cache_daily_brief': {
        if (!id) return res.status(400).json({ ok: false, error: 'Missing daily_metric id' });
        const { data, error } = await sb
          .from('daily_metrics')
          .update({ ai_daily_brief: payload?.ai_daily_brief ?? null })
          .eq('id', id)
          .select()
          .single();
        if (error) return res.status(400).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, data });
      }

      case 'create_workout': {
        const record = pickFields(payload, WORKOUT_FIELDS);
        const { data, error } = await sb.from('workouts').insert(record).select().single();
        if (error) return res.status(400).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, data });
      }

      case 'upsert_workout': {
        const record = pickFields(payload, WORKOUT_FIELDS);
        const { data, error } = await sb
          .from('workouts')
          .upsert(record, { onConflict: 'external_id' })
          .select()
          .single();
        if (error) return res.status(400).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, data });
      }

      case 'cache_workout_report': {
        if (!id) return res.status(400).json({ ok: false, error: 'Missing workout id' });
        const { data, error } = await sb
          .from('workouts')
          .update({ ai_coach_report: payload?.ai_coach_report ?? null })
          .eq('id', id)
          .select()
          .single();
        if (error) return res.status(400).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true, data });
      }

      case 'delete_workout': {
        if (!id) return res.status(400).json({ ok: false, error: 'Missing workout id' });
        const { error } = await sb.from('workouts').delete().eq('id', id);
        if (error) return res.status(400).json({ ok: false, error: error.message });
        return res.status(200).json({ ok: true });
      }

      default:
        return res.status(400).json({ ok: false, error: `Unsupported action "${action}"` });
    }
  } catch (err) {
    console.error('api/db error:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'Internal server error',
      status: getBackendStatus(false)
    });
  }
}
