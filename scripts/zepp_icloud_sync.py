# ติดตั้งไลบรารี: pip install fitparse supabase
import os, time, math
from pathlib import Path
from fitparse import FitFile
from supabase import create_client


def load_dotenv_files():
    root = Path(__file__).resolve().parent.parent
    for fname in (".env.local", ".env"):
        env_path = root / fname
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_dotenv_files()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
ATHLETE_SLUG = os.getenv("ATHLETE_SLUG", "pluk").strip()

# พาธโฟลเดอร์ iCloud Drive ของแอป Zepp บน macOS
ICLOUD_FIT_DIR = Path.home() / "Library/Mobile Documents/iCloud~com~huami~zepp~data/Documents/FITs"
if not ICLOUD_FIT_DIR.exists():
    ICLOUD_FIT_DIR = Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Zepp/FITs"


def get_client():
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("กรุณาตั้งค่า SUPABASE_URL และ SUPABASE_SERVICE_ROLE_KEY ใน .env หรือ Environment Variables")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def calc_trimp(dur, avg_hr, sex, rhr, max_hr):
    hrr = max(0.0, min(1.0, (avg_hr - rhr) / max(20, max_hr - rhr)))
    k1, k2 = (0.86, 1.67) if sex == "female" else (0.64, 1.92)
    return round(dur * hrr * k1 * math.exp(k2 * hrr), 1)


def sync_once(sb):
    ath = sb.table("athletes").select("*").eq("slug", ATHLETE_SLUG).single().execute().data
    if not ICLOUD_FIT_DIR.exists():
        print(f"ไม่พบโฟลเดอร์: {ICLOUD_FIT_DIR}")
        return

    for f in sorted(ICLOUD_FIT_DIR.glob("*.fit")):
        ext_id = f"fit_{ath['slug']}_{f.stem}"
        exists = sb.table("workouts").select("id").eq("external_id", ext_id).execute().data
        if exists:
            continue

        fit = FitFile(str(f))
        s = next(fit.get_messages("session"), None)
        if not s:
            continue
        v = {x.name: x.value for x in s}
        dur = round((v.get("total_timer_time") or 0) / 60.0, 2)
        avg_hr = int(v.get("avg_heart_rate") or 0)
        raw_sport = str(v.get("sport") or "running").lower()
        sport = (
            "running" if "run" in raw_sport else
            "badminton" if "badminton" in raw_sport else
            "football" if ("soccer" in raw_sport or "football" in raw_sport) else
            "cycling" if "cycl" in raw_sport else "other"
        )
        sb.table("workouts").upsert({
            "athlete_id": ath["id"],
            "external_id": ext_id,
            "workout_date": v["start_time"].strftime("%Y-%m-%d") if v.get("start_time") else time.strftime("%Y-%m-%d"),
            "sport_type": sport,
            "title": f"Zepp {raw_sport.title()} ({f.stem})",
            "duration_min": dur,
            "distance_km": round((v.get("total_distance") or 0) / 1000.0, 2),
            "avg_hr": avg_hr,
            "max_hr": int(v.get("max_heart_rate") or 0),
            "avg_power": int(v.get("avg_power") or 0),
            "cadence": int((v.get("avg_running_cadence") or 0) * 2),
            "elevation_gain": round(v.get("total_ascent") or 0, 1),
            "trimp": calc_trimp(dur, avg_hr, ath["sex"], ath["resting_hr"], ath["max_hr"]),
            "source": "zepp_icloud_fit"
        }, on_conflict="external_id").execute()
        print(f"Synced: {ext_id}")


if __name__ == "__main__":
    print("Starting Zepp iCloud FIT Auto-Sync...")
    sb = get_client()
    while True:
        try:
            sync_once(sb)
        except Exception as e:
            print("Sync Error:", e)
        time.sleep(300)
