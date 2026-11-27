// api/ingest-health.js — รับข้อมูลสุขภาพจาก iPhone ส่งเข้า Supabase
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase environment variables are not configured' });
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
