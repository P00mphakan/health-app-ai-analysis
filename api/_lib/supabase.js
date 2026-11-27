// api/_lib/supabase.js — Shared automatic Supabase client for all Vercel Serverless APIs
// Prefers Vercel Environment Variables when set; falls back to the project's public publishable key.
import { createClient } from '@supabase/supabase-js';

const DEFAULT_SUPABASE_URL = 'https://apczswmxojcvexxeuuoi.supabase.co';
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_pNynQzDaPkEjcsuiB1RlYA_CQ24z4zT';

export function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim();
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    DEFAULT_SUPABASE_PUBLISHABLE_KEY
  ).trim();
  return { url, key };
}

export function getSupabaseClient() {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
