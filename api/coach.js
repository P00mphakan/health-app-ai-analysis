// api/coach.js — Vercel Serverless Function
// 3-Tier AI Coach: Google Gemini -> Local Ollama (Cloudflare Tunnel) -> Rule-Based Fallback

function parseModelJson(rawText, mode) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const requiredKeys =
    mode === 'daily'
      ? ['verdict', 'status', 'load', 'plan', 'warning']
      : ['hrSection', 'perfSection', 'tacticsSection', 'nextDrill'];

  for (const key of requiredKeys) {
    if (typeof parsed[key] !== 'string' || !parsed[key].trim()) {
      return null;
    }
  }

  return Object.fromEntries(requiredKeys.map((k) => [k, parsed[k].trim()]));
}

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

  const systemPrompt = `คุณคือโค้ชวิทยาศาสตร์การกีฬาและเวชศาสตร์การกีฬาระดับอาชีพ
ตอบเป็นภาษาไทยแบบตรงไปตรงมา กระชับ ไม่อ้อมค้อม ไม่เวิ่นเว้อ อิงตัวเลขจริงเท่านั้น
ห้ามใช้คำปลอบใจหรือคำเกริ่นนำยาวๆ ให้ตอบกลับเป็น JSON เท่านั้นตามโครงสร้างที่กำหนด`;

  const userPrompt =
    mode === 'daily'
      ? `วิเคราะห์ความพร้อมประจำวันของนักกีฬา:
ข้อมูลนักกีฬา: ${JSON.stringify({
          name: athlete.name,
          sex: athlete.sex,
          weight_kg: athlete.weight_kg,
          max_hr: athlete.max_hr,
          resting_hr: athlete.resting_hr,
          hrv_baseline: athlete.hrv_baseline
        })}
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
ข้อมูลนักกีฬา: ${JSON.stringify({
          name: athlete.name,
          sex: athlete.sex,
          weight_kg: athlete.weight_kg,
          max_hr: athlete.max_hr,
          resting_hr: athlete.resting_hr
        })}
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
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
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
        const parsed = parseModelJson(rawText, mode);
        if (parsed) {
          return res.status(200).json({
            provider: `google:${geminiModel}`,
            data: parsed
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
        const parsed = parseModelJson(rawText, mode);
        if (parsed) {
          return res.status(200).json({
            provider: `ollama-cf:${ollamaModel}`,
            data: parsed
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
