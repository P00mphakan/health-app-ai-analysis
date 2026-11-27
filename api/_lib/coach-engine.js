// api/_lib/coach-engine.js — Shared Sports Science + 3-Tier AI Coach Engine (Daily, Post-Workout & Multi-Turn Chat)
// Tier 1: Google Gemini API (supports same env var aliases used across Vercel projects)
// Tier 2: Local Ollama via Cloudflare Tunnel
// Tier 3: Deterministic Sports Science Rule-Based Fallback (works immediately with zero API keys)

export function getGeminiConfig() {
  const apiKey = (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.VITE_GEMINI_API_KEY ||
    process.env.NEXT_PUBLIC_GEMINI_API_KEY ||
    ''
  ).trim();
  const model = (process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite').trim();
  return { apiKey, model };
}

function extractGeminiText(gData) {
  const parts = gData?.candidates?.[0]?.content?.parts || [];
  const answerPart = parts.find((p) => typeof p?.text === 'string' && !p.thought) || parts.find((p) => typeof p?.text === 'string');
  return answerPart?.text || null;
}

async function callGeminiGenerate({ apiKey, model, payload, timeoutMs = 8000 }) {
  // Prioritize fast low-latency gemini-3.1-flash-lite so serverless calls finish in ~1-2s,
  // falling back cleanly across models on 404/429/503/timeout.
  const candidates = Array.from(
    new Set(['gemini-3.1-flash-lite', model, 'gemini-3-flash-preview', 'gemini-3.8-flash'].filter(Boolean))
  );
  let lastError = 'gemini_failed';

  for (const m of candidates) {
    try {
      const bodyPayload =
        m.includes('3.8')
          ? {
              ...payload,
              generationConfig: {
                ...(payload.generationConfig || {}),
                thinkingConfig: { thinkingLevel: 'low' }
              }
            }
          : payload;

      const gRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify(bodyPayload)
        }
      );

      if (gRes.ok) {
        const gData = await gRes.json();
        const text = extractGeminiText(gData);
        if (text) return { ok: true, model: m, text };
        lastError = `${m}_empty_text`;
      } else {
        lastError = `${m}_http_${gRes.status}`;
        if (gRes.status === 401 || gRes.status === 403) break;
      }
    } catch (err) {
      lastError = `${m}:${err.message}`;
    }
  }
  return { ok: false, error: lastError };
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

  const { apiKey: geminiKey, model: geminiModel } = getGeminiConfig();
  const { url: ollamaUrl, model: ollamaModel } = getOllamaConfig();
  let lastError = null;

  // ---- TIER 1: Google Gemini API (Primary) ----
  if (geminiKey) {
    const gOut = await callGeminiGenerate({
      apiKey: geminiKey,
      model: geminiModel,
      timeoutMs: 15000,
      payload: {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json'
        }
      }
    });

    if (gOut.ok) {
      try {
        const parsed = parseModelJson(gOut.text, mode);
        if (parsed) {
          return {
            provider: `google:${gOut.model}`,
            data: parsed
          };
        }
        lastError = 'gemini_invalid_json';
      } catch (err) {
        lastError = `gemini_json_parse:${err.message}`;
      }
    } else {
      lastError = gOut.error;
    }
    console.warn('Gemini failed:', lastError);
  }

  // ---- TIER 2: Local Ollama via Cloudflare Tunnel (Fallback) ----
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
        lastError = 'ollama_invalid_json';
      } else {
        lastError = `ollama_http_${oRes.status}`;
      }
      console.warn('Ollama CF failed:', lastError);
    } catch (err) {
      lastError = err.message;
      console.warn('Ollama CF error:', err.message);
    }
  }

  // ---- TIER 3: Deterministic Rule-Based Fallback ----
  return {
    provider: 'rule-based-fallback',
    reason: !geminiKey && !ollamaUrl ? 'missing_api_key' : (lastError || 'provider_unavailable'),
    data: null
  };
}

function calcKarvonenSimple(athlete) {
  const rhr = Number(athlete?.resting_hr) || 55;
  const maxHr = Number(athlete?.max_hr) || 185;
  const hrr = Math.max(20, maxHr - rhr);
  return {
    z1: [Math.round(rhr + 0.5 * hrr), Math.round(rhr + 0.6 * hrr)],
    z2: [Math.round(rhr + 0.6 * hrr), Math.round(rhr + 0.7 * hrr)],
    z3: [Math.round(rhr + 0.7 * hrr), Math.round(rhr + 0.8 * hrr)],
    z4: [Math.round(rhr + 0.8 * hrr), Math.round(rhr + 0.9 * hrr)],
    z5: [Math.round(rhr + 0.9 * hrr), maxHr]
  };
}

/**
 * Smart Rule-Based Conversational Fallback (answers follow-up questions using the user's real telemetry)
 */
export function generateRuleBasedChatReply({ athlete, metrics, workout, pmc, recentWorkouts, message }) {
  const q = String(message || '').toLowerCase();
  const z = calcKarvonenSimple(athlete);
  const name = athlete?.name || 'นักกีฬา';
  const acwr = pmc?.acwr != null ? Number(pmc.acwr) : null;
  const tsb = pmc?.tsb != null ? Number(pmc.tsb) : 0;
  const ctl = pmc?.ctl != null ? Number(pmc.ctl) : 0;
  const atl = pmc?.atl != null ? Number(pmc.atl) : 0;
  const weight = Number(metrics?.weight_kg || athlete?.weight_kg || 60);

  if (/กิน|อาหาร|โปรตีน|คาร์บ|น้ำ|เกลือแร่|โภชนาการ|ฟื้นตัว|ฟื้นฟู|recovery/.test(q)) {
    const trimp = Number(workout?.trimp || 0);
    const proteinG = Math.round(weight * 1.6);
    const postCarbG = Math.round(weight * (trimp >= 120 ? 1.2 : 0.8));
    const postProtG = Math.round(weight * 0.35);
    return [
      `แผนฟื้นฟูและโภชนาการเฉพาะตัวของ ${name} (น้ำหนัก ${weight} กก.):`,
      `• หลังซ้อมภายใน 45 นาที: เติมคาร์บ ~${postCarbG} กรัม + โปรตีน ~${postProtG} กรัม และน้ำพร้อมเกลือแร่ 500–750 มล.`,
      `• เป้าโปรตีนทั้งวัน: ~${proteinG} กรัม/วัน เพื่อซ่อมแซมกล้ามเนื้อ`,
      `• การพักฟื้น: ${trimp >= 140 || (acwr && acwr > 1.5) ? 'งดซ้อมหนัก 48 ชม. ยืดน่อง/แฮมสตริง 10 นาที และนอนให้ได้ ≥ 7.5–8 ชม.' : 'ยืดเหยียดคูลดาวน์ 10 นาที วันถัดไปเน้น Zone 2 เบาๆ เพื่อช่วยระบายกรดแลคติก'}`
    ].join('\n');
  }

  if (/แบด|บอล|กีฬา|คอร์ท|ตี|เตะ|ไหวไหม/.test(q)) {
    if (acwr !== null && acwr > 1.5) {
      return `จากข้อมูลล่าสุดของ ${name}: ACWR อยู่ที่ ${acwr.toFixed(2)} (CTL ${ctl} / ATL ${atl}, TSB ${tsb}) ซึ่งเกินโซนปลอดภัย 1.30 — แนะนำ "งดเกมหนัก/สปรินต์" วันนี้ก่อนครับ ถ้าจำเป็นต้องลงคอร์ทให้เล่นแค่คุมจังหวะแบบไม่กระชากสุดตัว คุม HR เฉลี่ยไม่เกิน Z2–Z3 (${z.z2[1]}–${z.z3[0]} bpm) ไม่เกิน 45 นาที`;
    }
    if (acwr !== null && acwr > 1.3) {
      return `${name} มี ACWR ${acwr.toFixed(2)} (เริ่มตึง) — ลงตี/เล่นได้แต่ลดความหนักลง 30% เน้นเกมคู่ คุม HR ไม่แช่ Z4 (${z.z4[0]}+ bpm) และคูลดาวน์ยืดขาอย่างน้อย 10 นาทีหลังจบครับ`;
    }
    return `${name} โหลดสะสมอยู่ในเกณฑ์พร้อม (${acwr !== null ? `ACWR ${acwr.toFixed(2)}` : 'กำลังเก็บฐาน'}, TSB ${tsb}) — สามารถลงคอร์ทได้ครับ วอร์มอัพให้ HR แตะ Z2 (${z.z2[0]}–${z.z2[1]} bpm) 10 นาทีก่อนเล่นจริง`;
  }

  if (/acwr|โหลด|บาดเจ็บ|เสี่ยง|ctl|atl|tsb/.test(q)) {
    const status =
      acwr === null ? 'ยังอยู่ในช่วงเก็บฐานข้อมูล' :
      acwr > 1.5 ? 'โซนเสี่ยงสูง (>1.50)' :
      acwr > 1.3 ? 'โซนเฝ้าระวัง (1.30–1.50)' :
      acwr >= 0.8 ? 'Sweet Spot (0.80–1.30)' : 'Underload (<0.80)';
    return [
      `สถานะโหลดของ ${name}: ACWR ${acwr !== null ? acwr.toFixed(2) : '-'} (${status}) | CTL ${ctl} | ATL ${atl} | TSB ${tsb > 0 ? '+' : ''}${tsb}`,
      acwr !== null && acwr > 1.3
        ? `• วิธีลด ACWR ให้ปลอดภัย: ลด TRIMP รายวันลง 40–50% เป็นเวลา 2–3 วัน (พักเต็มวัน 1 วัน + เดินหรือ Easy Z1–Z2 < ${z.z2[1]} bpm) เพื่อกด ATL ลงโดยไม่เสียฐาน CTL`
        : `• โหลดอยู่ในกรอบดี สามารถเพิ่มปริมาณซ้อมได้ไม่เกิน 10% ต่อสัปดาห์`
    ].join('\n');
  }

  if (/hr|หัวใจ|โซน|zone|สูง|ต่ำ|เหนื่อย/.test(q)) {
    const woLine = workout
      ? `• เซสชัน "${workout.title || workout.sport_type}": Avg HR ${workout.avg_hr} bpm${workout.max_hr ? ` / Max ${workout.max_hr} bpm` : ''} (TRIMP ${workout.trimp})`
      : '';
    return [
      `โซนหัวใจ Karvonen เฉพาะตัวของ ${name} (RHR ${athlete?.resting_hr || 55} / Max ${athlete?.max_hr || 185}):`,
      `• Z1 Recovery: ${z.z1[0]}–${z.z1[1]} | Z2 Aerobic: ${z.z2[0]}–${z.z2[1]} | Z3 Tempo: ${z.z3[0]}–${z.z3[1]} | Z4 Anaerobic: ${z.z4[0]}–${z.z4[1]} | Z5 VO2Max: ${z.z5[0]}–${z.z5[1]} bpm`,
      woLine,
      `• แนะนำ: สัดส่วนซ้อม 80% ควรคุมให้อยู่ใน Z2 (${z.z2[0]}–${z.z2[1]} bpm) เพื่อขยายความอึดและลด HR ที่ความเร็วเดิม`
    ].filter(Boolean).join('\n');
  }

  if (/สรุป|7 วัน|สัปดาห์|ฟอร์ม|แนวโน้ม/.test(q)) {
    const list = Array.isArray(recentWorkouts) ? recentWorkouts.slice(0, 7) : [];
    const totalTrimp = list.reduce((a, w) => a + (Number(w.trimp) || 0), 0).toFixed(1);
    const totalDist = list.reduce((a, w) => a + (Number(w.distance_km) || 0), 0).toFixed(1);
    return [
      `สรุปล่าสุดของ ${name} (${list.length} เซสชันล่าสุด):`,
      `• TRIMP รวม ${totalTrimp} | ระยะทางรวม ${totalDist} กม.`,
      `• ภาระสะสม: CTL ${ctl} / ATL ${atl} / TSB ${tsb > 0 ? '+' : ''}${tsb} / ACWR ${acwr !== null ? acwr.toFixed(2) : '-'}`,
      `• สุขภาพล่าสุด: ${metrics?.sleep_hours != null ? `นอน ${metrics.sleep_hours} ชม.` : 'ยังไม่มีข้อมูลการนอน'} | ${metrics?.hrv != null ? `HRV ${metrics.hrv} ms` : 'รอ HRV'} | ${metrics?.resting_hr != null ? `RHR ${metrics.resting_hr} bpm` : 'รอ RHR'}`
    ].join('\n');
  }

  // Default: next-session / tomorrow training plan tailored to this athlete
  const advice =
    (acwr !== null && acwr > 1.5) || tsb < -20
      ? `พักฟื้น 100% หรือเดิน/ยืดเหยียดเบาๆ ไม่เกิน 20 นาที (คุม HR < ${z.z1[1]} bpm) เพราะ ACWR (${acwr?.toFixed(2) ?? '-'}) / TSB (${tsb}) ล้าสะสมสูง`
      : (acwr !== null && acwr > 1.3) || tsb < -10
      ? `ซ้อมเบา Easy Run / ปั่นคุมโซน Z2 (${z.z2[0]}–${z.z2[1]} bpm) 30–40 นาที ห้ามแช่ Z4`
      : `ร่างกายรับโหลดได้ แนะนำ Easy Z2 (${z.z2[0]}–${z.z2[1]} bpm) 40–50 นาที หรือ Tempo Z3 (${z.z3[0]}–${z.z3[1]} bpm) 20–30 นาที`;

  return [
    `คำแนะนำเฉพาะตัวสำหรับ ${name}:`,
    `• แผนซ้อมถัดไป: ${advice}`,
    workout ? `• อ้างอิงจากเซสชัน "${workout.title || workout.sport_type}" (Avg HR ${workout.avg_hr} bpm, TRIMP ${workout.trimp})` : '',
    `• ข้อมูลปัจจุบัน: CTL ${ctl} / ATL ${atl} / TSB ${tsb} / ACWR ${acwr !== null ? acwr.toFixed(2) : '-'}`
  ].filter(Boolean).join('\n');
}

export async function runAiCoachChat({ athlete, metrics, workout, pmc, recentWorkouts, report, history, message }) {
  const z = calcKarvonenSimple(athlete);
  const systemPrompt = `คุณคือโค้ชวิทยาศาสตร์การกีฬาส่วนตัวของ "${athlete?.name || 'นักกีฬา'}"
ตอบเป็นภาษาไทยแบบตรงไปตรงมา กระชับ ใช้ตัวเลขจริงของนักกีฬาคนนี้เท่านั้น (ห้ามเวิ่นเว้อ ห้ามเดาตัวเลขที่ไม่มี)
ข้อมูลโปรไฟล์: ${JSON.stringify({
    name: athlete?.name,
    sex: athlete?.sex,
    weight_kg: athlete?.weight_kg,
    max_hr: athlete?.max_hr,
    resting_hr: athlete?.resting_hr,
    hrv_baseline: athlete?.hrv_baseline,
    karvonen_zones_bpm: z
  })}
ค่าสุขภาพล่าสุด: ${JSON.stringify(metrics || null)}
ภาระสะสม (PMC/ACWR): ${JSON.stringify(pmc || null)}
${workout ? `Workout ที่กำลังวิเคราะห์อยู่: ${JSON.stringify(workout)}` : ''}
${report ? `บทวิเคราะห์ก่อนหน้า: ${JSON.stringify(report)}` : ''}
${Array.isArray(recentWorkouts) && recentWorkouts.length ? `ประวัติซ้อมล่าสุด (${recentWorkouts.length} รายการ): ${JSON.stringify(recentWorkouts.slice(0, 7).map((w) => ({ date: w.workout_date, sport: w.sport_type, title: w.title, dur: w.duration_min, dist: w.distance_km, avg_hr: w.avg_hr, trimp: w.trimp })))}` : ''}`;

  const safeHistory = Array.isArray(history)
    ? history
        .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
        .slice(-8)
    : [];

  const { apiKey: geminiKey, model: geminiModel } = getGeminiConfig();
  const { url: ollamaUrl, model: ollamaModel } = getOllamaConfig();
  let lastError = null;

  // ---- TIER 1: Google Gemini Multi-Turn Chat ----
  if (geminiKey) {
    const contents = [
      ...safeHistory.map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content.trim() }]
      })),
      { role: 'user', parts: [{ text: String(message || '').trim() }] }
    ];

    const gOut = await callGeminiGenerate({
      apiKey: geminiKey,
      model: geminiModel,
      timeoutMs: 18000,
      payload: {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 900 }
      }
    });

    if (gOut.ok && gOut.text.trim()) {
      return { provider: `google:${gOut.model}`, reply: gOut.text.trim() };
    }
    lastError = gOut.error || 'gemini_empty_reply';
  }

  // ---- TIER 2: Local Ollama via Cloudflare Tunnel ----
  if (ollamaUrl) {
    try {
      const oRes = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(22000),
        body: JSON.stringify({
          model: ollamaModel,
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            ...safeHistory.map((h) => ({ role: h.role, content: h.content.trim() })),
            { role: 'user', content: String(message || '').trim() }
          ]
        })
      });

      if (oRes.ok) {
        const oData = await oRes.json();
        const reply = oData?.message?.content?.trim();
        if (reply) {
          return { provider: `ollama-cf:${ollamaModel}`, reply };
        }
        lastError = 'ollama_empty_reply';
      } else {
        lastError = `ollama_http_${oRes.status}`;
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  // ---- TIER 3: Smart Rule-Based Sports Coach Reply (Always works!) ----
  return {
    provider: 'rule-based-coach',
    reason: !geminiKey && !ollamaUrl ? 'missing_api_key' : (lastError || 'provider_unavailable'),
    reply: generateRuleBasedChatReply({ athlete, metrics, workout, pmc, recentWorkouts, message })
  };
}
