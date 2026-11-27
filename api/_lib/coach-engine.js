// api/_lib/coach-engine.js — Shared Sports Science + 3-Tier AI Coach Engine
// Tier 1: Google Gemini API (supports same env var aliases used across Vercel projects)
// Tier 2: Local Ollama via Cloudflare Tunnel
// Tier 3: Rule-Based Fallback (handled deterministically on frontend)

export function getGeminiConfig() {
  const apiKey = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.VITE_GEMINI_API_KEY ||
    process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
    ''
  ).trim();
  const model = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  return { apiKey, model };
}

export function getOllamaConfig() {
  const url = (process.env.OLLAMA_CF_URL || '').trim().replace(/\/$/, '');
  const model = (process.env.OLLAMA_MODEL || 'qwen2.5:14b').trim();
  return { url, model };
}

export function calcBanisterTRIMP(durationMin, avgHR, athlete) {
  const dur = Number(durationMin) || 0;
  const hr = Number(avgHR) || 0;
  if (dur <= 0 || hr <= 0) return 0;
  const rhr = Number(athlete?.resting_hr) || 55;
  const maxHR = Number(athlete?.max_hr) || 185;
  const hrr = Math.max(0, Math.min(1, (hr - rhr) / Math.max(20, maxHR - rhr)));
  const isFem = athlete?.sex === 'female';
  const k1 = isFem ? 0.86 : 0.64;
  const k2 = isFem ? 1.67 : 1.92;
  return +(dur * hrr * k1 * Math.exp(k2 * hrr)).toFixed(1);
}

export function normalizeSportType(rawSport) {
  const s = String(rawSport || 'running').toLowerCase();
  if (s.includes('run') || s.includes('jog') || s.includes('trail') || s.includes('treadmill')) return 'running';
  if (s.includes('badminton') || s.includes('racket')) return 'badminton';
  if (s.includes('soccer') || s.includes('football') || s.includes('futsal')) return 'football';
  if (s.includes('cycl') || s.includes('bik') || s.includes('spin')) return 'cycling';
  return 'other';
}

export function parseModelJson(rawText, mode) {
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

export async function runAiCoach({ mode, athlete, metrics, workout, pmc }) {
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
ข้อมูล Workout (รวมค่า .FIT เช่น Calories, Aerobic/Anaerobic TE, EPOC Load หากมี): ${JSON.stringify(workout)}
ACWR หลังซ้อม: ${JSON.stringify(pmc)}

ตอบเป็น JSON ที่มีคีย์ต่อไปนี้เท่านั้น:
{
  "hrSection": "ประเมิน Heart Rate Zone ตรงไปตรงมา 1-2 บรรทัด",
  "perfSection": "สรุป Performance (Pace, Power, W/kg, EF, TRIMP, Calories, Aerobic/Anaerobic TE) 1 บรรทัด",
  "tacticsSection": "วิเคราะห์ Tactics ลักษณะโหลด EPOC/TE และชั่วโมงพักฟื้นที่แนะนำ 1-2 บรรทัด",
  "nextDrill": "แนวทางฝึกฝนและปรับปรุงเซสชันถัดไป 2 ข้อสั้นๆ"
}`;

  // ---- TIER 1: Google Gemini API (Primary) ----
  const { apiKey: geminiKey, model: geminiModel } = getGeminiConfig();
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
          return {
            provider: `google:${geminiModel}`,
            data: parsed
          };
        }
      }
      console.warn('Gemini failed, falling back to Cloudflare Ollama...');
    } catch (err) {
      console.warn('Gemini error:', err.message);
    }
  }

  // ---- TIER 2: Local Ollama via Cloudflare Tunnel (Fallback) ----
  const { url: ollamaUrl, model: ollamaModel } = getOllamaConfig();
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
          return {
            provider: `ollama-cf:${ollamaModel}`,
            data: parsed
          };
        }
      }
      console.warn('Ollama CF failed, falling back to Rule-Based...');
    } catch (err) {
      console.warn('Ollama CF error:', err.message);
    }
  }

  // ---- TIER 3: Deterministic Rule-Based Fallback ----
  return {
    provider: 'rule-based-fallback',
    data: null
  };
}
