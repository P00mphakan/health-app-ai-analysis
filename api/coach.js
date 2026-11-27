// api/coach.js — Vercel Serverless Function
// 3-Tier AI Coach (Daily Brief, Post-Workout Analysis, and Per-User Follow-Up Chat)
import { runAiCoach, runAiCoachChat } from './_lib/coach-engine.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { mode, athlete, metrics, workout, pmc, recentWorkouts, report, history, message } = req.body || {};
  if (!mode || !athlete) {
    return res.status(400).json({ error: 'Missing mode or athlete payload' });
  }

  if (mode === 'chat') {
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Missing chat message' });
    }
    const result = await runAiCoachChat({
      athlete,
      metrics,
      workout,
      pmc,
      recentWorkouts,
      report,
      history,
      message
    });
    return res.status(200).json(result);
  }

  if (mode !== 'daily' && mode !== 'workout') {
    return res.status(400).json({ error: 'Invalid mode (expected "daily", "workout", or "chat")' });
  }

  const result = await runAiCoach({ mode, athlete, metrics, workout, pmc });
  return res.status(200).json(result);
}
