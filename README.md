# ai-brief-site

A tiny **zero-dependency** (Node stdlib only — no `npm install`, respects the NPM lockdown) web app
that renders Jarvis's daily AI briefs as a clean RTL reading site.

- Reads briefs from `~/.openclaw/workspace/insights/briefs/` (written by the `ai-morning-report` loop).
- 7-day rolling history (sidebar). Older briefs pruned by `prune-briefs.sh`.
- Each item has a **"＋ משימה"** button → appended to `~/.openclaw/workspace/tasks.md` under
  `## Saved from AI Brief` (so it shows in the 09:00/15:00/20:00 reminders). Persists until removed.
- `/saved` page lists saved tasks with remove buttons.
- Basic auth via `AUTH_USER` / `AUTH_PASS` env.

## Run locally
```
PORT=8088 AUTH_USER=yossef AUTH_PASS=... node server.mjs
```

## Go-live (brief.byclick.co.il)
1. **DNS:** add `A  brief → 72.60.181.232` at box.co.il (manual).
2. Pick one:
   - **Path A (Docker, like quartz):** build with `Dockerfile`, run on the `coolify` network with
     Traefik labels for `Host(\`brief.byclick.co.il\`)` + letsencrypt, port 8088. Mount the workspace
     dir so it can read briefs and write tasks.md.
   - **Path B (host service):** `ai-brief-site.service` (systemd --user) + `~/.ai-brief-site.env`,
     routed by a Traefik dynamic config to `host.docker.internal:8088` (needs the firewall to allow
     the docker bridge → host:8088).
