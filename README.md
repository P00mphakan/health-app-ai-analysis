# ATHLETE OS — Family Performance Hub

Production-ready family health & sports performance dashboard integrated with **Amazfit T-Rex 3 / Zepp**, **Apple Health**, **Supabase** (automatic server-side connection via `/api/db`), **Vercel Serverless Functions**, and a **3-Tier AI Coach** (Google Gemini -> Local Ollama via Cloudflare Tunnel -> Built-in Sports Science Rule-Based Engine).

## Project Structure

```text
├── api/
│   ├── db.js                   # Serverless API: Automatic Supabase CRUD + live backend status
│   ├── coach.js                # Serverless API: 3-tier AI Coach (Gemini -> Ollama CF -> Rule-Based)
│   └── ingest-health.js        # Serverless API: Apple Health / Health Auto Export webhook
├── public/
│   └── index.html              # Production single-file web app (Zero mock data, status icons only)
├── scripts/
│   └── zepp_icloud_sync.py     # Python auto-sync for Zepp iCloud .FIT backups (auto-loads .env)
├── supabase/
│   └── schema.sql              # Supabase database schema (athletes, daily_metrics, workouts)
├── .env.example                # Environment variable template for Vercel
├── package.json                # Dependencies for Vercel Serverless Functions
└── vercel.json                 # Vercel static output & API routing config
```

## Quick Setup

1. **Supabase**: Create a Supabase project, open **SQL Editor**, and run [`supabase/schema.sql`](./supabase/schema.sql).
2. **Vercel**: Import this repository into Vercel and configure the environment variables listed in [`.env.example`](./.env.example). The web app connects to Supabase automatically via `/api/db` and displays compact status icons without requiring users to enter backend keys in the UI.
3. **Zepp iCloud Sync (Workouts)**:
   ```bash
   pip install fitparse supabase
   cp .env.example .env  # fill in SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY
   python3 scripts/zepp_icloud_sync.py
   ```
4. **Apple Health Webhook (Daily Vitals)**: Point **Health Auto Export** or **Apple Shortcuts** to `POST https://<your-vercel-domain>/api/ingest-health?u=<slug>` with header `x-webhook-secret`.

For the full Thai architecture blueprint and operational checklist, see [`athlete_os_production_architecture_antigravity_blueprint.md`](./athlete_os_production_architecture_antigravity_blueprint.md).
