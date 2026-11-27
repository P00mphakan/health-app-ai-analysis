// api/_lib/sync-utils.js — Shared Per-User Auth, Apple Shortcuts Parsers, FIT Extractor & Smart Fusion
import crypto from 'node:crypto';
import FitParser from 'fit-file-parser';
import { calcBanisterTRIMP, normalizeSportType } from './coach-engine.js';

export function getWebhookSecret() {
  return (process.env.WEBHOOK_SECRET || '').trim();
}

export function createUserSyncToken(slug) {
  const secret = getWebhookSecret();
  const cleanSlug = String(slug || '').trim().toLowerCase();
  if (!secret || !cleanSlug) return '';
  return crypto.createHmac('sha256', secret).update(`athlete-os:${cleanSlug}`).digest('hex').slice(0, 24);
}

export function isSameOriginWebRequest(req) {
  const host = (req.headers?.['x-forwarded-host'] || req.headers?.host || '').toLowerCase();
  const origin = (req.headers?.origin || '').toLowerCase();
  const referer = (req.headers?.referer || '').toLowerCase();
  if (!host) return false;
  return origin.includes(host) || referer.includes(host);
}

/**
 * Verify per-user isolated sync authentication:
 * - If WEBHOOK_SECRET is not set on server -> open (development/initial setup)
 * - Accepts per-user HMAC token (?token=... or x-sync-token) bound strictly to `slug`
 * - Also accepts master x-webhook-secret / ?secret= (for admin scripts / Health Auto Export)
 */
export function verifyUserSyncAuth(req, slug, { allowSameOrigin = false } = {}) {
  const secret = getWebhookSecret();
  if (!secret) return { ok: true, mode: 'open' };
  if (allowSameOrigin && isSameOriginWebRequest(req)) return { ok: true, mode: 'same_origin' };

  const headerSecret = String(req.headers?.['x-webhook-secret'] || req.query?.secret || '').trim();
  if (headerSecret && headerSecret.length === secret.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(headerSecret), Buffer.from(secret))) {
        return { ok: true, mode: 'master_secret' };
      }
    } catch {}
  }

  const userToken = String(
    req.headers?.['x-sync-token'] || req.query?.token || req.body?.token || ''
  ).trim();
  const expected = createUserSyncToken(slug);
  if (userToken && expected && userToken.length === expected.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(userToken), Buffer.from(expected))) {
        return { ok: true, mode: 'user_token' };
      }
    } catch {}
  }

  return { ok: false, error: 'Unauthorized: invalid sync token or x-webhook-secret for this athlete' };
}

export function toThaiIsoDate(val) {
  if (val) {
    if (val instanceof Date && !Number.isNaN(val.getTime())) {
      return new Date(val.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    }
    const s = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      return new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    }
  }
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Parse numbers that may arrive from Apple Shortcuts with units/commas (e.g. "64 ms", "55.2 kg", "8,420", [62, 66])
 */
export function parseFlexibleNumber(val, { aggregate = 'last' } = {}) {
  if (val == null || val === '') return null;
  if (Array.isArray(val)) {
    const nums = val.map((v) => parseFlexibleNumber(v)).filter((n) => n !== null && !Number.isNaN(n));
    if (nums.length === 0) return null;
    if (aggregate === 'sum') return nums.reduce((a, b) => a + b, 0);
    if (aggregate === 'avg') return nums.reduce((a, b) => a + b, 0) / nums.length;
    return nums[nums.length - 1];
  }
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (typeof val === 'object') {
    const candidate = val.qty ?? val.value ?? val.Avg ?? val.avg ?? val.asleep ?? null;
    return parseFlexibleNumber(candidate, { aggregate });
  }
  const str = String(val).replace(/,/g, '').trim();
  const match = str.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parse Sleep duration from Apple Shortcuts / Apple Health in ANY format:
 * - Number: hours (<=24), minutes (24..1440), seconds (>1440)
 * - Text: "7 hr 32 min", "7h 32m", "7 ชม. 32 นาที", "07:32"
 * - Array of Apple Health sleep samples: sums Asleep/Core/Deep/REM & extracts stage minutes
 */
export function parseFlexibleSleep(input) {
  const result = {
    sleep_hours: null,
    sleep_deep_min: null,
    sleep_rem_min: null,
    sleep_light_min: null
  };
  if (input == null || input === '') return result;

  // Array of Apple Health sleep samples (from Shortcuts or Health Auto Export)
  if (Array.isArray(input)) {
    let totalMin = 0;
    let deepMin = 0;
    let remMin = 0;
    let lightMin = 0;

    for (const item of input) {
      if (typeof item === 'number' || typeof item === 'string') {
        const sub = parseFlexibleSleep(item);
        if (sub.sleep_hours != null) totalMin += sub.sleep_hours * 60;
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const stage = String(item.stage || item.value || item.type || item.category || '').toLowerCase();
      // Skip non-sleep intervals (In Bed / Awake)
      if (stage.includes('awake') || stage.includes('in bed') || stage.includes('inbed')) continue;

      let mins = 0;
      if (item.start && item.end) {
        const s = new Date(item.start).getTime();
        const e = new Date(item.end).getTime();
        if (!Number.isNaN(s) && !Number.isNaN(e) && e > s) mins = (e - s) / 60000;
      } else if (item.duration_min != null) {
        mins = Number(item.duration_min) || 0;
      } else if (item.duration != null) {
        const d = Number(item.duration) || 0;
        mins = d > 1440 ? d / 60 : d;
      } else if (item.asleep != null) {
        const a = Number(item.asleep) || 0;
        mins = a <= 24 ? a * 60 : a;
      } else if (item.qty != null) {
        const q = Number(item.qty) || 0;
        mins = q <= 24 ? q * 60 : q;
      }
      if (mins <= 0) continue;
      totalMin += mins;
      if (stage.includes('deep')) deepMin += mins;
      else if (stage.includes('rem')) remMin += mins;
      else if (stage.includes('core') || stage.includes('light')) lightMin += mins;
    }

    if (totalMin > 0) result.sleep_hours = +(totalMin / 60).toFixed(2);
    if (deepMin > 0) result.sleep_deep_min = Math.round(deepMin);
    if (remMin > 0) result.sleep_rem_min = Math.round(remMin);
    if (lightMin > 0) result.sleep_light_min = Math.round(lightMin);
    return result;
  }

  if (typeof input === 'object') {
    const deep = parseFlexibleNumber(input.deep);
    const rem = parseFlexibleNumber(input.rem);
    const core = parseFlexibleNumber(input.core ?? input.light);
    if (deep != null && deep > 0) result.sleep_deep_min = Math.round(deep <= 12 ? deep * 60 : deep);
    if (rem != null && rem > 0) result.sleep_rem_min = Math.round(rem <= 12 ? rem * 60 : rem);
    if (core != null && core > 0) result.sleep_light_min = Math.round(core <= 12 ? core * 60 : core);

    const direct =
      parseFlexibleNumber(input.asleep) ??
      ((deep || 0) + (rem || 0) + (core || 0) || null) ??
      parseFlexibleNumber(input.qty);
    if (direct != null && direct > 0) {
      result.sleep_hours = +(direct > 1440 ? direct / 3600 : direct > 24 ? direct / 60 : direct).toFixed(2);
    }
    return result;
  }

  if (typeof input === 'number') {
    if (input <= 0 || !Number.isFinite(input)) return result;
    result.sleep_hours = +(input > 1440 ? input / 3600 : input > 24 ? input / 60 : input).toFixed(2);
    return result;
  }

  const str = String(input).trim();
  // Match "7:32"
  const colonMatch = str.match(/^(\d{1,2}):(\d{2})$/);
  if (colonMatch) {
    result.sleep_hours = +(Number(colonMatch[1]) + Number(colonMatch[2]) / 60).toFixed(2);
    return result;
  }
  // Match "7 hr 32 min", "7h 32m", "7 ชม. 32 นาที"
  const hrMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:hr|hrs|hour|hours|h|ชม\.?|ชั่วโมง)/i);
  const minMatch = str.match(/(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes|m|น\.|นาที)/i);
  if (hrMatch || minMatch) {
    const hrs = (hrMatch ? Number(hrMatch[1]) : 0) + (minMatch ? Number(minMatch[1]) / 60 : 0);
    if (hrs > 0) result.sleep_hours = +hrs.toFixed(2);
    return result;
  }

  const num = parseFlexibleNumber(str);
  if (num != null && num > 0) {
    result.sleep_hours = +(num > 1440 ? num / 3600 : num > 24 ? num / 60 : num).toFixed(2);
  }
  return result;
}

/**
 * Parse a binary .FIT file buffer and extract both core and rich Amazfit/Zepp telemetry
 */
export function parseFitBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new FitParser({
      force: true,
      speedUnit: 'km/h',
      lengthUnit: 'm',
      temperatureUnit: 'celsius',
      elapsedRecordField: true,
      mode: 'list'
    });
    parser.parse(buffer, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

export function extractFitWorkout(parsed, filename, athlete) {
  const session = parsed?.sessions?.[0] || null;
  const records = Array.isArray(parsed?.records) ? parsed.records : [];
  const stem = String(filename || 'zepp_workout').replace(/\.fit$/i, '');

  let durationMin = 0;
  let distanceKm = 0;
  let avgHr = 0;
  let maxHr = 0;
  let minHr = 0;
  let avgPower = 0;
  let maxPower = 0;
  let cadence = 0;
  let elevationGain = 0;
  let avgSpeedKmh = 0;
  let totalCalories = 0;
  let aerobicTe = 0;
  let anaerobicTe = 0;
  let trainingLoadPeak = 0;
  let rawSport = 'running';
  let displaySport = 'running';
  let startTime = null;

  if (session) {
    startTime = session.start_time || session.timestamp || null;
    durationMin = +(((session.total_timer_time || session.total_elapsed_time || 0)) / 60).toFixed(2);
    distanceKm = +(Number(session.total_distance || 0) / 1000).toFixed(2);
    avgHr = Math.round(Number(session.avg_heart_rate || 0));
    maxHr = Math.round(Number(session.max_heart_rate || 0));
    minHr = Math.round(Number(session.min_heart_rate || 0));
    avgPower = Math.round(Number(session.avg_power || 0));
    maxPower = Math.round(Number(session.max_power || 0));
    const rawCad = Number(session.avg_running_cadence || session.avg_cadence || 0);
    cadence = rawCad > 0 && rawCad < 110 ? Math.round(rawCad * 2) : Math.round(rawCad);
    elevationGain = +(Number(session.total_ascent || 0)).toFixed(1);
    avgSpeedKmh = +(Number(session.avg_speed || 0)).toFixed(2);
    totalCalories = Math.round(Number(session.total_calories || 0));
    aerobicTe = +(Number(session.total_training_effect || 0)).toFixed(1);
    anaerobicTe = +(Number(session.total_anaerobic_training_effect || 0)).toFixed(1);
    trainingLoadPeak = Math.round(Number(session.training_load_peak || 0));

    const sp = String(session.sport || '').trim();
    const sub = String(session.sub_sport || '').trim();
    rawSport = `${sp} ${sub}`.trim() || 'running';
    displaySport = sub && !['generic', 'street'].includes(sub.toLowerCase()) ? sub : (sp || 'running');
  } else if (records.length > 0) {
    startTime = records[0].timestamp || null;
    const endTime = records[records.length - 1].timestamp || null;
    durationMin =
      startTime && endTime
        ? Math.max(1, +((new Date(endTime) - new Date(startTime)) / 60000).toFixed(2))
        : +(records.length / 60).toFixed(2);
    const lastDist = [...records].reverse().find((r) => typeof r.distance === 'number')?.distance || 0;
    distanceKm = +(Number(lastDist) / 1000).toFixed(2);
    const hrs = records.map((r) => Number(r.heart_rate)).filter((v) => v > 30 && v < 230);
    if (hrs.length) {
      avgHr = Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length);
      maxHr = Math.max(...hrs);
      minHr = Math.min(...hrs);
    }
  }

  if (avgHr <= 0) avgHr = (Number(athlete?.resting_hr) || 55) + 70;
  if (durationMin <= 0) durationMin = 1;

  const sportType = normalizeSportType(rawSport);
  const workoutDate = toThaiIsoDate(startTime);
  const niceSport = displaySport.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const trimp = calcBanisterTRIMP(durationMin, avgHr, athlete);

  const base = {
    athlete_id: athlete.id,
    external_id: `fit_${athlete.slug}_${stem}`,
    workout_date: workoutDate,
    sport_type: sportType,
    title: `Zepp ${niceSport} (${stem})`,
    duration_min: durationMin,
    distance_km: distanceKm,
    avg_hr: avgHr,
    max_hr: maxHr,
    avg_power: avgPower,
    cadence,
    elevation_gain: elevationGain,
    rpe: 7,
    trimp,
    source: 'zepp_fit_bridge'
  };

  const extended = {
    min_hr: minHr,
    max_power: maxPower,
    avg_speed_kmh: avgSpeedKmh,
    total_calories: totalCalories,
    aerobic_te: aerobicTe,
    anaerobic_te: anaerobicTe,
    training_load_peak: trainingLoadPeak
  };

  return { base, extended };
}

/**
 * Safely upsert a row with optional v2 extended columns.
 * Falls back cleanly to base columns if migration_v2_rich_metrics.sql has not been applied yet.
 */
export async function safeUpsertRow(sb, table, baseRecord, extendedFields, onConflict) {
  const fullRecord = { ...baseRecord, ...extendedFields };
  let { data, error } = await sb.from(table).upsert(fullRecord, { onConflict }).select().single();
  let schemaFallback = false;

  if (error && (error.code === 'PGRST204' || /column .* does not exist|schema cache/i.test(error.message || ''))) {
    schemaFallback = true;
    const retry = await sb.from(table).upsert(baseRecord, { onConflict }).select().single();
    data = retry.data;
    error = retry.error;
  }

  return { data, error, schemaFallback };
}

export async function safeUpdateRowById(sb, table, id, baseRecord, extendedFields) {
  const fullRecord = { ...baseRecord, ...extendedFields };
  let { data, error } = await sb.from(table).update(fullRecord).eq('id', id).select().single();
  let schemaFallback = false;

  if (error && (error.code === 'PGRST204' || /column .* does not exist|schema cache/i.test(error.message || ''))) {
    schemaFallback = true;
    const retry = await sb.from(table).update(baseRecord).eq('id', id).select().single();
    data = retry.data;
    error = retry.error;
  }

  return { data, error, schemaFallback };
}

/**
 * Smart Fusion: Deduplicate & merge workouts between Zepp .FIT and Apple Health
 * - If a workout already exists on the same athlete_id + workout_date with similar duration (±15% or ±3 min)
 *   and compatible sport, fuse them so .FIT keeps rich Power/Cadence/TE/EPOC/HR while Apple Health enriches calories/distance.
 * - Never creates duplicate workouts when both iPhone Apple Health and Zepp .FIT sync the same session!
 */
export async function upsertMergedWorkout(sb, athlete, baseRecord, extendedFields = {}) {
  const incomingIsFit = String(baseRecord.source || '').includes('fit');

  // 1. Check same external_id first
  if (baseRecord.external_id) {
    const { data: exact } = await sb
      .from('workouts')
      .select('*')
      .eq('external_id', baseRecord.external_id)
      .maybeSingle();
    if (exact) {
      return safeUpsertRow(sb, 'workouts', baseRecord, extendedFields, 'external_id');
    }
  }

  // 2. Check existing workouts on the same day for cross-source fusion (FIT <-> Apple Health)
  const { data: sameDay } = await sb
    .from('workouts')
    .select('*')
    .eq('athlete_id', athlete.id)
    .eq('workout_date', baseRecord.workout_date);

  const match = (sameDay || []).find((ex) => {
    const durA = Number(ex.duration_min) || 0;
    const durB = Number(baseRecord.duration_min) || 0;
    const durDiff = Math.abs(durA - durB);
    const durTol = Math.max(3, Math.max(durA, durB) * 0.15);
    if (durDiff > durTol) return false;
    // Same sport OR one side is 'other' (e.g. Generic/Walking)
    return ex.sport_type === baseRecord.sport_type || ex.sport_type === 'other' || baseRecord.sport_type === 'other';
  });

  if (match) {
    const existingIsFit = String(match.source || '').includes('fit');
    const mergedSource =
      (incomingIsFit && !existingIsFit) || (!incomingIsFit && existingIsFit)
        ? 'zepp_fit+apple_health'
        : (incomingIsFit ? baseRecord.source : match.source);

    // Prefer FIT for rich telemetry (HR, Power, Cadence, Elevation, TRIMP, TE, EPOC)
    const primary = incomingIsFit ? baseRecord : match;
    const secondary = incomingIsFit ? match : baseRecord;

    const mergedBase = {
      athlete_id: athlete.id,
      external_id: incomingIsFit ? baseRecord.external_id : match.external_id,
      workout_date: primary.workout_date,
      sport_type: primary.sport_type !== 'other' ? primary.sport_type : secondary.sport_type,
      title: incomingIsFit ? baseRecord.title : match.title,
      duration_min: Number(primary.duration_min) || Number(secondary.duration_min),
      distance_km: Math.max(Number(primary.distance_km) || 0, Number(secondary.distance_km) || 0),
      avg_hr: Number(primary.avg_hr) || Number(secondary.avg_hr),
      max_hr: Math.max(Number(primary.max_hr) || 0, Number(secondary.max_hr) || 0),
      avg_power: Math.max(Number(primary.avg_power) || 0, Number(secondary.avg_power) || 0),
      cadence: Math.max(Number(primary.cadence) || 0, Number(secondary.cadence) || 0),
      elevation_gain: Math.max(Number(primary.elevation_gain) || 0, Number(secondary.elevation_gain) || 0),
      rpe: Number(match.rpe) || Number(baseRecord.rpe) || 7,
      trimp: Number(primary.trimp) || Number(secondary.trimp),
      source: mergedSource
    };

    const mergedExt = {
      min_hr: Math.min(...[extendedFields.min_hr, match.min_hr].filter((v) => Number(v) > 0)) || 0,
      max_power: Math.max(Number(extendedFields.max_power) || 0, Number(match.max_power) || 0),
      avg_speed_kmh: Math.max(Number(extendedFields.avg_speed_kmh) || 0, Number(match.avg_speed_kmh) || 0),
      total_calories: Math.max(Number(extendedFields.total_calories) || 0, Number(match.total_calories) || 0),
      aerobic_te: Math.max(Number(extendedFields.aerobic_te) || 0, Number(match.aerobic_te) || 0),
      anaerobic_te: Math.max(Number(extendedFields.anaerobic_te) || 0, Number(match.anaerobic_te) || 0),
      training_load_peak: Math.max(Number(extendedFields.training_load_peak) || 0, Number(match.training_load_peak) || 0)
    };
    if (!Number.isFinite(mergedExt.min_hr)) mergedExt.min_hr = 0;

    const updated = await safeUpdateRowById(sb, 'workouts', match.id, mergedBase, mergedExt);
    return { ...updated, merged: true };
  }

  return safeUpsertRow(sb, 'workouts', baseRecord, extendedFields, 'external_id');
}
