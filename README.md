# ATHLETE OS — Family Performance Hub

Production-ready family health & sports performance dashboard integrated with **Amazfit T-Rex 3 / Zepp**, **Apple Health**, **Supabase** (automatic server-side connection via `/api/db`), **Vercel Serverless Functions**, and a **3-Tier AI Coach** (Google Gemini -> Local Ollama via Cloudflare Tunnel -> Built-in Sports Science Rule-Based Engine).

## Project Structure

```text
├── api/
│   ├── _lib/coach-engine.js    # Shared Gemini/Ollama AI Coach + Banister TRIMP engine
│   ├── db.js                   # Serverless API: Automatic Supabase CRUD + live status
│   ├── coach.js                # Serverless API: 3-tier AI Coach
│   ├── ingest-zepp.js          # Serverless Bridge API: .FIT / .GPX / JSON -> Supabase + AI Coach
│   └── ingest-health.js        # Serverless Bridge API: Apple Health vitals -> Supabase + AI Brief
├── public/
│   └── index.html              # Production web app (Zero mock data, direct .FIT/.GPX upload)
├── zepp-bridge/                # Local Python Auto-Sync Bridge (modeled after badme-ai-v2/python-bridge)
│   ├── server.py               # FastAPI server + background Zepp iCloud/dropzone auto-watcher
│   ├── requirements.txt        # Python dependencies
│   └── start_bridge.sh         # One-command macOS launcher
├── scripts/
│   └── zepp_icloud_sync.py     # Lightweight standalone Python FIT sync script
├── supabase/
│   └── schema.sql              # Supabase database schema (athletes, daily_metrics, workouts)
├── .env.example                # Environment variable template for Vercel
├── package.json                # Dependencies for Vercel Serverless Functions
└── vercel.json                 # Vercel static output & API routing config
```

## Quick Setup

1. **Supabase**: Create a Supabase project, open **SQL Editor**, and run [`supabase/schema.sql`](./supabase/schema.sql).
2. **Vercel**: Import this repository into Vercel and configure the environment variables listed in [`.env.example`](./.env.example).
   - **Shared Gemini API Key**: Supports `GEMINI_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `GOOGLE_API_KEY`, `NEXT_PUBLIC_GEMINI_API_KEY`, or `VITE_GEMINI_API_KEY` — you can share/reuse the exact same Gemini API Key variable from another Vercel project (such as `badme-ai-v2`) via Vercel Team Shared Environment Variables or Project Settings.
3. **Zepp App Bridge (3 ways to sync)**:
   - **Direct on Web (Zero Install)**: Open the Workout tab and drag & drop `.FIT` or `.GPX` exported from Zepp directly into the browser.
   - **Local Python Auto-Bridge (`zepp-bridge/`)**:
     ```bash
     cd zepp-bridge
     ./start_bridge.sh
     ```
     Watches iCloud Drive `Zepp/FITs` and `zepp-bridge/dropzone/` automatically and pushes new workouts to `https://healthmeai.vercel.app/api/ingest-zepp` (where Supabase saves and Gemini analyzes them immediately).
   - **Apple Health Daily Vitals Webhook**: Point **Health Auto Export** or **Apple Shortcuts** to `POST https://healthmeai.vercel.app/api/ingest-health?u=<slug>` with header `x-webhook-secret`.
