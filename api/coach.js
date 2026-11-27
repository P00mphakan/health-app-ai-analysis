// api/coach.js — Vercel Serverless Function
// 3-Tier AI Coach: Google Gemini -> Local Ollama (Cloudflare Tunnel) -> Rule-Based Fallback
import { runAiCoach } from './_lib/coach-engine.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { mode, athlete, metrics, workout, pmc } = req.body || {};
  if (!mode || !athlete) {
    return res.status(400).json({ error: 'Missing mode or athlete payload' });
  }

  if (mode !== 'daily' && mode !== 'workout') {
    return res.status(400).json({ error: 'Invalid mode (expected "daily" or "workout")' });
  }

  const result = await runAiCoach({ mode, athlete, metrics, workout, pmc });
  return res.status(200).json(result);
}
