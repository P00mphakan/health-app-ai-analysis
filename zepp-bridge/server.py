"""
ATHLETE OS — Zepp App Auto-Sync Bridge Server
Architecture modeled after badme-ai-v2/python-bridge:
- Watches Zepp iCloud Drive backup folder (.FIT / .GPX) automatically in the background
- Pushes new workouts to https://healthmeai.vercel.app/api/ingest-zepp
- Vercel backend parses FIT, computes sex-differentiated TRIMP, saves to Supabase,
  and triggers Gemini AI Coach analysis automatically (zero DB keys needed locally).
"""

import asyncio
import base64
import json
import math
import os
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware


def load_dotenv_files() -> None:
    roots = [Path(__file__).resolve().parent, Path(__file__).resolve().parent.parent]
    for root in roots:
        for fname in (".env.local", ".env"):
            env_path = root / fname
            if not env_path.exists():
                continue
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_dotenv_files()

ATHLETE_OS_URL = os.getenv("ATHLETE_OS_URL", "https://healthmeai.vercel.app").strip().rstrip("/")
ATHLETE_SLUG = os.getenv("ATHLETE_SLUG", "").strip().lower()
WEBHOOK_SECRET = os.getenv("WEBHOOK_SECRET", "").strip()
POLL_SECONDS = max(15, int(os.getenv("ZEPP_POLL_SECONDS", "60")))

DEFAULT_ICLOUD_DIRS = [
    Path.home() / "Library/Mobile Documents/iCloud~com~huami~zepp~data/Documents/FITs",
    Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Zepp/FITs",
    Path.home() / "Library/Mobile Documents/com~apple~CloudDocs/Zepp",
    Path.home() / "iCloudDrive/Zepp/FITs",
    Path(__file__).resolve().parent / "dropzone",
]

CUSTOM_WATCH_DIR = os.getenv("ZEPP_WATCH_DIR", "").strip()
STATE_FILE = Path(__file__).resolve().parent / ".synced_state.json"

app = FastAPI(title="ATHLETE OS — Zepp App Bridge Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

bridge_state: Dict[str, Any] = {
    "synced_files": {},
    "last_scan_at": None,
    "last_error": None,
    "last_synced_workout": None,
}


def load_synced_state() -> None:
    if STATE_FILE.exists():
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                bridge_state["synced_files"] = data.get("synced_files", {})
        except Exception:
            bridge_state["synced_files"] = {}


def save_synced_state() -> None:
    try:
        STATE_FILE.write_text(
            json.dumps({"synced_files": bridge_state["synced_files"]}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception as exc:
        print(f"[ZeppBridge] Failed to save state: {exc}")


def resolve_watch_dirs() -> List[Path]:
    dirs: List[Path] = []
    if CUSTOM_WATCH_DIR:
        dirs.append(Path(CUSTOM_WATCH_DIR).expanduser())
    for d in DEFAULT_ICLOUD_DIRS:
        if d not in dirs:
            dirs.append(d)
    # Ensure local dropzone always exists so user can drop .fit/.gpx files immediately
    dropzone = Path(__file__).resolve().parent / "dropzone"
    dropzone.mkdir(parents=True, exist_ok=True)
    return [d for d in dirs if d.exists()]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def parse_gpx_bytes(raw: bytes, filename: str) -> Dict[str, Any]:
    root = ET.fromstring(raw.decode("utf-8", errors="ignore"))
    pts = [el for el in root.iter() if el.tag.endswith("trkpt")]
    if len(pts) < 2:
        raise ValueError("GPX file has fewer than 2 trackpoints")

    total_dist = 0.0
    ele_gain = 0.0
    hr_sum = 0
    hr_cnt = 0
    max_hr = 0
    cad_sum = 0
    cad_cnt = 0
    start_t: Optional[datetime] = None
    end_t: Optional[datetime] = None
    prev_lat = prev_lon = prev_ele = None

    for pt in pts:
        lat = float(pt.attrib.get("lat", "nan"))
        lon = float(pt.attrib.get("lon", "nan"))
        if prev_lat is not None and not math.isnan(lat) and not math.isnan(lon):
            seg = haversine_km(prev_lat, prev_lon, lat, lon)
            if seg < 0.5:
                total_dist += seg
        prev_lat, prev_lon = lat, lon

        for child in pt.iter():
            tag = child.tag.split("}")[-1].lower()
            text = (child.text or "").strip()
            if not text:
                continue
            if tag == "time":
                try:
                    dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
                    if start_t is None:
                        start_t = dt
                    end_t = dt
                except ValueError:
                    pass
            elif tag == "ele":
                try:
                    ele = float(text)
                    if prev_ele is not None and ele > prev_ele and (ele - prev_ele) < 5:
                        ele_gain += ele - prev_ele
                    prev_ele = ele
                except ValueError:
                    pass
            elif tag == "hr":
                try:
                    hr = int(float(text))
                    if 30 < hr < 230:
                        hr_sum += hr
                        hr_cnt += 1
                        max_hr = max(max_hr, hr)
                except ValueError:
                    pass
            elif tag == "cad":
                try:
                    cad = int(float(text))
                    if cad > 0:
                        cad_sum += cad
                        cad_cnt += 1
                except ValueError:
                    pass

    dur_min = (
        max(1.0, round((end_t - start_t).total_seconds() / 60.0, 2))
        if start_t and end_t
        else round(len(pts) / 60.0, 2)
    )
    avg_hr = round(hr_sum / hr_cnt) if hr_cnt > 0 else 135
    avg_cad = round(cad_sum / cad_cnt) if cad_cnt > 0 else 0
    if 0 < avg_cad < 110:
        avg_cad *= 2
    workout_date = (
        start_t.astimezone(timezone.utc).strftime("%Y-%m-%d")
        if start_t
        else time.strftime("%Y-%m-%d")
    )
    stem = Path(filename).stem
    return {
        "external_id": f"gpx_bridge_{stem}",
        "workout_date": workout_date,
        "sport_type": "running",
        "title": f"Zepp GPX ({stem})",
        "duration_min": dur_min,
        "distance_km": round(total_dist, 2),
        "avg_hr": avg_hr,
        "max_hr": max_hr,
        "cadence": avg_cad,
        "elevation_gain": round(ele_gain, 1),
        "rpe": 7,
        "source": "zepp_bridge_gpx",
    }


async def push_file_to_web(file_path: Path, slug_override: str = "", analyze: bool = True) -> Dict[str, Any]:
    raw = file_path.read_bytes()
    ext = file_path.suffix.lower()
    slug = (slug_override or ATHLETE_SLUG).strip().lower()
    headers = {"Content-Type": "application/json"}
    if WEBHOOK_SECRET:
        headers["x-webhook-secret"] = WEBHOOK_SECRET

    if ext == ".fit":
        payload: Dict[str, Any] = {
            "slug": slug,
            "filename": file_path.name,
            "fit_base64": base64.b64encode(raw).decode("ascii"),
            "source": "zepp_bridge_fit",
            "analyze": analyze,
        }
    elif ext == ".gpx":
        workout = parse_gpx_bytes(raw, file_path.name)
        payload = {"slug": slug, "workout": workout, "analyze": analyze}
    else:
        raise ValueError(f"Unsupported file extension: {ext}")

    endpoint = f"{ATHLETE_OS_URL}/api/ingest-zepp"
    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post(endpoint, json=payload, headers=headers)
        data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {"error": resp.text}
        if resp.status_code >= 400 or not data.get("ok"):
            raise RuntimeError(data.get("error") or f"HTTP {resp.status_code}")
        return data


async def scan_and_sync_once(max_files: int = 50) -> Dict[str, Any]:
    bridge_state["last_scan_at"] = datetime.now(timezone.utc).isoformat()
    watch_dirs = resolve_watch_dirs()
    synced_now: List[str] = []
    errors: List[str] = []

    candidates: List[Path] = []
    seen_paths = set()
    for folder in watch_dirs:
        for pattern in ("*.fit", "*.FIT", "*.gpx", "*.GPX"):
            for file_path in folder.glob(pattern):
                resolved = str(file_path.resolve())
                if resolved in seen_paths:
                    continue
                seen_paths.add(resolved)
                candidates.append(file_path)

    # Sort newest first so latest Zepp workouts appear on the dashboard immediately
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)

    pending: List[Path] = []
    for file_path in candidates:
        resolved = str(file_path.resolve())
        fingerprint = f"{file_path.name}:{file_path.stat().st_size}:{int(file_path.stat().st_mtime)}"
        if bridge_state["synced_files"].get(resolved) != fingerprint:
            pending.append(file_path)

    for idx, file_path in enumerate(pending[:max_files]):
        resolved = str(file_path.resolve())
        fingerprint = f"{file_path.name}:{file_path.stat().st_size}:{int(file_path.stat().st_mtime)}"
        try:
            # Only trigger LLM analysis automatically on the 2 newest workouts per batch
            res = await push_file_to_web(file_path, analyze=(idx < 2))
            bridge_state["synced_files"][resolved] = fingerprint
            bridge_state["last_synced_workout"] = res.get("saved", {}).get("title") or file_path.name
            bridge_state["last_error"] = None
            save_synced_state()
            synced_now.append(file_path.name)
            print(f"[ZeppBridge] Synced {file_path.name} -> {ATHLETE_OS_URL} (AI: {res.get('ai_provider')})")
        except Exception as exc:
            msg = f"{file_path.name}: {exc}"
            errors.append(msg)
            bridge_state["last_error"] = msg
            print(f"[ZeppBridge] Error syncing {msg}")

    return {
        "ok": len(errors) == 0,
        "watched_dirs": [str(d) for d in watch_dirs],
        "synced_now": synced_now,
        "remaining_pending": max(0, len(pending) - len(synced_now)),
        "total_synced": len(bridge_state["synced_files"]),
        "errors": errors,
    }


async def background_watcher() -> None:
    while True:
        try:
            await scan_and_sync_once()
        except Exception as exc:
            bridge_state["last_error"] = str(exc)
            print(f"[ZeppBridge] Watcher error: {exc}")
        await asyncio.sleep(POLL_SECONDS)


@app.on_event("startup")
async def on_startup() -> None:
    load_synced_state()
    print(f"[ZeppBridge] Starting auto-sync -> {ATHLETE_OS_URL}/api/ingest-zepp (every {POLL_SECONDS}s)")
    asyncio.create_task(background_watcher())


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "online",
        "bridge": "ATHLETE-OS-Zepp-Bridge",
        "target_url": ATHLETE_OS_URL,
        "athlete_slug": ATHLETE_SLUG or "(auto-default)",
        "watched_dirs": [str(d) for d in resolve_watch_dirs()],
        "total_synced": len(bridge_state["synced_files"]),
        "last_scan_at": bridge_state["last_scan_at"],
        "last_synced_workout": bridge_state["last_synced_workout"],
        "last_error": bridge_state["last_error"],
    }


@app.post("/sync-now")
async def sync_now() -> Dict[str, Any]:
    return await scan_and_sync_once()


@app.post("/upload")
async def upload_file(file: UploadFile = File(...), slug: str = Form("")) -> Dict[str, Any]:
    dropzone = Path(__file__).resolve().parent / "dropzone"
    dropzone.mkdir(parents=True, exist_ok=True)
    safe_name = Path(file.filename or "zepp_upload.fit").name
    dest = dropzone / safe_name
    dest.write_bytes(await file.read())
    res = await push_file_to_web(dest, slug_override=slug)
    return {"ok": True, "filename": safe_name, "result": res}


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("ZEPP_BRIDGE_PORT", "8010"))
    uvicorn.run(app, host="0.0.0.0", port=port)
