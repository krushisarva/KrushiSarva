# KrushiSarva on one Hostinger VPS: deployment plan

Status: **APPROVED 2026-10-14.** Decision 1 = add Firebase login to the admin SPA (separate PR). Decision 13 = yes: the compose file and Caddyfile live in `deploy/`, and `fastapi/Dockerfile` + `fastapi/.dockerignore` are committed (branch `feat/vps-deploy`).

**Done on the server on 2026-10-14:** §4 steps 1–5 and the swap file in step 7 (updates, key-only SSH, ufw 22/80/443, fail2ban with the sshd jail, unattended-upgrades, 2 GB swap, `vm.swappiness=10`). Docker 29.9 / Compose v5.6 confirmed. **Still owed from §4:** `ufw allow 443/udp`, `vm.overcommit_memory=1`, the auto-reboot time (step 6), the Browser terminal test (step 5) and the `docker ps -a` / `ss -tulpn` check (step 8).
Date: 2026-10-14. Target: Hostinger KVM 1 (1 vCPU / 4 GB RAM / 50 GB NVMe), Ubuntu 26.04 LTS, IP `187.127.149.129`, hostname `srv2061596.hstgr.cloud`.

Citations are `path:line` against `main` at c718c5d.

---

## 1. Summary

The whole backend runs on the one VPS as 6 Docker containers. **Caddy** handles automatic HTTPS for `srv2061596.hstgr.cloud`. Behind it are **backend** (Express API, Socket.IO, the admin SPA, the in-process BullMQ worker and node-cron, built from the existing root `Dockerfile`), **fastapi**, **celery** (both from one new Python image), **postgres:16** and **redis:7**. Only ports 22, 80 and 443 are reachable from the internet. The database is new and empty: it is created once with `prisma db push` plus one manual index. Then the two installed preview APKs are repointed with `eas update`, and the Razorpay webhook moves to the new host. The RAM fits with room to spare (about 1.4–2.0 GB in use out of 4 GB, see §3). **The biggest blocker is login, not infrastructure** (§11, decision 1).

**Total time: about 3.5–4 hours of hands-on work**, which can be split over two sittings. This does not include collecting API keys.

| # | Block | Time |
|---|---|---|
| A | Harden server, add swap, check Docker (§4) | 25 min |
| B | Commit and push the FastAPI Dockerfile to `main` (§5.3) first, then clone the repo with a deploy key and write env files (§6) | 40 min |
| C | Paste the compose file and Caddyfile (outside `app/`); build images (§5) | 35 min (mostly waiting) |
| D | Bootstrap the fresh DB, seeds, first admin (§7) | 15 min |
| E | Start everything, check HTTPS (§8) | 15 min |
| F | Nightly backups (§9) | 25 min |
| G | App cutover: URL commit, 2 OTAs, phone test, Razorpay (§10) | 50 min |

---

## 2. Architecture on the box

```text
 Internet ──► :22  sshd (key only, fail2ban)
          ──► :80/:443 ─► [caddy, host network] ──► 127.0.0.1:3000 ──► [backend :3000]
                          (Let's Encrypt, sees real v4+v6 IPs)  │  API /api/v1, /socket.io, /admin, /legal, /healthz
                                                        │  + in-process BullMQ worker + node-cron
                         ┌──────────────────────────────┼───────────────────────┐
                         ▼                              ▼                       ▼
                   [postgres :5432]              [redis :6379]          [fastapi :8001] ◄── HMAC-signed calls only
                    volume pgdata                 volume redisdata               │
                         ▲                         db0 cache/limits/BullMQ       │ enqueue
                         │                         db1 Celery broker+results     ▼
                         └──────────────────────────────────────────────── [celery worker]
                 ─────── docker network "krushisarva_default" (IPv4 only, not routable from outside; caddy is NOT on it) ───────
```

| Container | Image | Public? | Port binding | Notes |
|---|---|---|---|---|
| caddy | `caddy:2-alpine` | **yes** | `network_mode: host`, binds `80`, `443/tcp`, `443/udp` directly, so ufw governs them | Host networking is required for real client IPs: the hostname has an AAAA record (`2a02:4780:63:444e::1`), and on the IPv4-only compose network Docker's proxy would hand Caddy every IPv6 client as the bridge gateway `172.x.0.1` (one shared rate-limit bucket, §5.2). Proxies WebSockets automatically and sets no body-size or read-timeout cap by default. Scan JSON can be 12 MB (backend/src/app.js:276) and AI scan sockets can stay open 310 s (backend/src/app.js:231). |
| backend | root `Dockerfile` | no | `127.0.0.1:3000` (Caddy's upstream, and curl from the host) | One process: `node src/server.js` (Dockerfile:72), run as user `node`. Listens on 0.0.0.0 before touching any dependency (backend/src/server.js:214). Worker and cron run in-process by default (backend/src/config/env.js:205, 228). |
| fastapi | new `fastapi/Dockerfile` (§5.3) | no | none | Only Express calls it, through `AI_BACKEND_URL` (backend/src/config/env.js:323). |
| celery | same image as fastapi | no | none | Prefork pool; settings fixed in code (fastapi/jobs/queue.py:57-70). |
| postgres | `postgres:16` (matches CI, .github/workflows/ci.yml:39) | no | none | Named volume `pgdata`. |
| redis | `redis:7-alpine` | no | none | `noeviction`: BullMQ and the Celery broker must not lose keys. |

Rules:
1. **Never add a `ports:` entry for postgres, redis or fastapi.** Docker writes its own iptables rules, and **published ports bypass ufw**. Binding to `127.0.0.1:` is the only safe way to publish anything (Docker ≥ 28 is required for that binding to be unreachable from other hosts on the same L2 segment, §4 step 8). Caddy is not published at all: it runs on the host network. Do not move it back to `ports:`.
2. Keep every container on UTC. The cron expressions assume UTC (backend/src/server.js:292-536). Do not set `TZ=Asia/Kolkata`.
3. Caddy blocks `/readyz` from the public, because it exposes cache and shop metrics (backend/src/app.js:322-393). From the host, use `curl -s 127.0.0.1:3000/readyz`.

---

## 3. RAM budget (4 GB, 1 vCPU)

| Component | Expected steady RSS | `mem_limit` | Knobs (set in §5 / §6) |
|---|---|---|---|
| Ubuntu + dockerd + containerd + sshd + fail2ban | 350–450 MB | n/a | — |
| caddy | 20–40 MB | 128m | — |
| postgres | 300–450 MB | 768m | `shared_buffers=256MB`, `max_connections=60`, `work_mem=4MB` |
| redis | 20–60 MB idle, but each queued or running scan holds its images inline as base64 (fastapi/jobs/tasks.py:12, up to 8 MB raw per image at tasks.py:88), plus unacked copies and 24 h results (fastapi/jobs/queue.py:65) | 384m | `maxmemory 256mb`, `noeviction`, AOF on (the extra limit is headroom for the AOF-rewrite fork). When Redis is full, writes fail and BullMQ enqueue falls back to running jobs inline on the request path (backend/src/queue/jobQueue.js:56-64) |
| backend | 200–350 MB, with upload peaks of +100–175 MB | 700m | `NODE_OPTIONS=--max-old-space-size=384`, `UPLOAD_VIDEO_MAX_INFLIGHT=1` (default 4 × 100 MB, backend/src/config/env.js:397), `DB_CONNECTION_LIMIT=8` (default 12, backend/src/config/db.js:33) |
| fastapi | 150–200 MB | 320m | `--workers 1` (the previous host ran 2) |
| celery | 300–450 MB, with image-decode peaks of +150 MB per child (≈ 750 MB with both children decoding at once) | 768m | `--concurrency=2 --max-tasks-per-child=200`. An OOM-killed child fails its scan (WorkerLostError), it is not requeued (fastapi/jobs/queue.py:57-70 has no `task_reject_on_worker_lost`) |
| **Total** | **~1.4–2.0 GB** | **sum of limits ≈ 3.07 GB (128+768+384+700+320+768 MB) + OS ≈ 0.45 GB ≈ 3.5 GB** | |

**Verdict: it fits.** Even if every container hits its limit at once, the total (about 3.5 GB) stays under 4 GB. It **does not fit** with the previous host's process counts (2 uvicorn workers + 2 Celery children + a separate BullMQ worker) **plus** a server-side image build running at the same time. A build adds about 1–1.5 GB at peak, so the 2 GB swap file below is required, not optional.

**Postgres connection budget** (`max_connections=60`):

| Client | Max connections | Source |
|---|---|---|
| backend Prisma | 8 | `DB_CONNECTION_LIMIT=8` (backend/src/config/db.js:33-64) |
| fastapi web, 1 worker | 10 | hard-coded `max_size=10` (fastapi/db_pool.py:68-70) |
| celery, 2 children × 10 | 20 | same pool, one per child |
| psql / seeds / pg_dump | ~5 | — |
| superuser reserve | 3 | Postgres default |
| **Total** | **46 ≤ 60** | |

**Postgres tuning** (passed as `-c` flags in §5.1): `shared_buffers=256MB`, `effective_cache_size=1GB`, `work_mem=4MB`, `maintenance_work_mem=64MB`, `max_connections=60`, `random_page_cost=1.1`, `effective_io_concurrency=200` (NVMe), `max_wal_size=1GB`, `log_min_duration_statement=500` (slow-query log), `log_parameter_max_length=0` (the PG16 default `-1` would write every bind value of a slow Prisma query, phone numbers and addresses included, into `docker compose logs`, outside the app's PII masking), plus `shm_size: 256mb` on the container.

**Swap** (part of §4, step 7): one 2 GB swap file, `vm.swappiness=10`. Also `vm.overcommit_memory=1`, which Redis asks for so its AOF-rewrite fork does not fail.

---

## 4. Server hardening (Ubuntu 26.04), about 25 min

**Lockout warning.** Keep your first SSH session open until step 3 passes in a **second** terminal. The usual way back in is **hPanel → VPS → Browser terminal**, but it may itself connect over SSH, so it can stop working once password login is off or if fail2ban bans Hostinger's gateway IP. **Test it after step 5** (below). If it does not log in, the real out-of-band path is hPanel's **Recovery / Emergency mode** (rescue boot), which works without sshd.

1. **From your PC, prove that key login works** (you should not see a password prompt):
   ```sh
   ssh root@187.127.149.129 'echo key-login-ok'
   ```
   If it asks for a password, **stop**. Add your public key in hPanel (VPS → SSH keys) first.
2. **Update the system:**
   ```sh
   apt update && apt -y full-upgrade
   ```
3. **Key-only SSH.** The file is named `00-` on purpose: sshd uses the *first* value it reads, and cloud-init may drop in a later file that sets `PasswordAuthentication yes`.
   ```sh
   cat >/etc/ssh/sshd_config.d/00-krushisarva.conf <<'EOF'
   PasswordAuthentication no
   KbdInteractiveAuthentication no
   PermitRootLogin prohibit-password
   PubkeyAuthentication yes
   EOF
   sshd -t && systemctl restart ssh
   sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin)'   # expect: no / prohibit-password
   ```
   In a **second terminal on the PC**, check both directions:
   `ssh root@187.127.149.129 'echo ok'` must work, and
   `ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password root@187.127.149.129` must fail with `Permission denied (publickey)`.
4. **Firewall (ufw):**
   ```sh
   apt -y install ufw
   ufw default deny incoming && ufw default allow outgoing
   ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
   ufw --force enable && ufw status verbose
   ```
5. **fail2ban:**
   ```sh
   apt -y install fail2ban python3-systemd
   cat >/etc/fail2ban/jail.local <<'EOF'
   [DEFAULT]
   bantime  = 1h
   findtime = 10m
   maxretry = 5
   backend  = systemd
   # ignoreip = 127.0.0.1/8 ::1 <your-home-IP>    # uncomment only if your home IP is static
   [sshd]
   enabled = true
   EOF
   systemctl enable --now fail2ban && fail2ban-client status sshd
   ```
   **Then, with the first SSH session still open, open hPanel → VPS → Browser terminal and confirm it still logs in.** If it does not, note that the fallback is Recovery / Emergency mode (see the lockout warning).
6. **Automatic security updates.** This includes a reboot at 21:30 UTC, which is 03:00 IST (decision 9):
   ```sh
   apt -y install unattended-upgrades
   echo 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections
   dpkg-reconfigure -f noninteractive unattended-upgrades
   printf 'Unattended-Upgrade::Automatic-Reboot "true";\nUnattended-Upgrade::Automatic-Reboot-Time "21:30";\n' \
     > /etc/apt/apt.conf.d/52krushisarva
   cat /etc/apt/apt.conf.d/20auto-upgrades     # both lines should end in "1"
   ```
7. **Swap and kernel settings:**
   ```sh
   swapon --show                 # if a swap device is already listed, skip the next 3 lines
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   printf 'vm.swappiness=10\nvm.overcommit_memory=1\n' > /etc/sysctl.d/99-krushisarva.conf && sysctl --system
   ```
8. **Check Docker** (Hostinger's Docker manager should have installed it):
   ```sh
   docker version && docker compose version && systemctl is-enabled docker
   which docker        # expect /usr/bin/docker; /snap/bin/docker means the snap build, so tell me
   docker ps -a        # expect no containers; Hostinger's Docker manager may have started some
   ss -tulpn           # expect only sshd listening publicly (0.0.0.0:22 / [::]:22)
   ```
   **Stop and tell me** if `docker ps -a` lists anything, or if anything other than sshd listens on a public address. A container already publishing on `0.0.0.0` bypasses ufw, and anything on 80/443 stops Caddy from binding.
   **`docker version` must report Server ≥ 28.** Older releases let hosts on the same L2 segment reach ports published on `127.0.0.1`, which matters for `127.0.0.1:3000` on a shared hosting network. If it is older, upgrade with `curl -fsSL https://get.docker.com | sh`.
   If Docker is missing: `curl -fsSL https://get.docker.com | sh`.
9. **Optional non-root deploy user.** Recommended default: skip for now (decision 10). Note that membership in the `docker` group is equivalent to root anyway. When a second person gets access: `adduser deploy && usermod -aG docker deploy`, then copy `authorized_keys` across.

---

## 5. Proposed files (copy-paste on approval)

**Server layout:**
```text
/opt/krushisarva/
  app/                  git clone of krushisarva/KrushiSarva (build context)
  env/postgres.env      chmod 600
  env/backend.env       chmod 600
  env/fastapi.env       chmod 600
  docker-compose.yml    §5.1  (copied from app/deploy/docker-compose.yml)
  Caddyfile             §5.2  (copied from app/deploy/Caddyfile)
  .env                  TAG=<git sha> (the image tag currently deployed, §8)
  backups/              §9 (chmod 700)
```
Secrets stay out of git (`.gitignore:3-8`) and out of the image (`.dockerignore:4-10`). The compose file and Caddyfile are committed in `deploy/` and **copied** to `/opt/krushisarva/` (`cp app/deploy/docker-compose.yml app/deploy/Caddyfile /opt/krushisarva/`), so they sit **outside `app/`**. Re-copy them after any pull that changes `deploy/`. **Never create or paste files inside `app/`**: it is a git clone, and an untracked file there makes the next `git pull` abort once the same path is committed (§8).

**Clone with a read-only deploy key** (10 min). **Precondition:** `fastapi/Dockerfile` and `fastapi/.dockerignore` (§5.3) are already committed and pushed to `main`, so the clone contains them.
```sh
ssh-keygen -t ed25519 -N '' -f /root/.ssh/krushisarva_deploy -C vps-deploy
cat /root/.ssh/krushisarva_deploy.pub     # GitHub → krushisarva/KrushiSarva → Settings → Deploy keys → Add (read-only)
printf 'Host github.com\n  IdentityFile /root/.ssh/krushisarva_deploy\n  IdentitiesOnly yes\n' >> /root/.ssh/config
mkdir -p /opt/krushisarva/env /opt/krushisarva/backups && chmod 700 /opt/krushisarva/backups && cd /opt/krushisarva
git clone git@github.com:krushisarva/KrushiSarva.git app
test -f app/fastapi/Dockerfile && echo fastapi-dockerfile-ok      # if missing, STOP: commit §5.3 first, do not paste it here
```

### 5.1 `/opt/krushisarva/docker-compose.yml`

```yaml
name: krushisarva

x-logging: &logging
  driver: json-file
  options: { max-size: "10m", max-file: "3" }

services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    network_mode: host                   # binds 80, 443/tcp, 443/udp on the host; sees real IPv4 AND IPv6 client IPs (§5.2). No ports: entry.
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data          # certificates: keep this volume, or you risk Let's Encrypt rate limits
      - caddy_config:/config
    depends_on: [backend]
    mem_limit: 128m
    logging: *logging

  backend:
    image: krushisarva-backend:${TAG:-latest}
    build: { context: ./app, dockerfile: Dockerfile }
    command: ["node", "src/server.js"]   # replaces the sh -c CMD (Dockerfile:72) so SIGTERM reaches node
    init: true                           # forwards SIGTERM; the app then closes HTTP, BullMQ and Prisma within its own 10 s force-exit timer (backend/src/server.js:563-591)
    stop_grace_period: 20s               # Docker's default is also 10 s, which would SIGKILL at the same moment the app force-exits
    user: "node"                         # uid 1000 in node:20-slim; nothing needs root (uploads are in memory or /tmp, backend/src/config/cloudinary.js:37, backend/src/routes/ai.routes.js:722)
    restart: unless-stopped
    env_file: ./env/backend.env
    ports: ["127.0.0.1:3000:3000"]       # Caddy's upstream (host network) and curl /readyz; never 0.0.0.0
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
    mem_limit: 700m
    healthcheck:                         # node:20-slim has no curl
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    logging: *logging

  fastapi:
    image: krushisarva-ai:${TAG:-latest}
    build: { context: ./app/fastapi }
    command: ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1", "--no-access-log"]
    restart: unless-stopped
    env_file: ./env/fastapi.env
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
    mem_limit: 320m
    healthcheck:                         # /health always returns 200, so read the body (fastapi/main.py:284-299)
      test: ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if b'\"ok\"' in urllib.request.urlopen('http://127.0.0.1:8001/health',timeout=5).read() else 1)"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 30s
    logging: *logging

  celery:
    image: krushisarva-ai:${TAG:-latest}
    pull_policy: never                   # built by the fastapi service
    command: ["celery", "-A", "jobs.queue:celery_app", "worker", "--loglevel=info", "--concurrency=2", "--max-tasks-per-child=200"]
    restart: unless-stopped
    env_file: ./env/fastapi.env
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_healthy }
    mem_limit: 768m                      # 2 children decoding at once peak near 750 MB (§3)
    # Warm shutdown waits for in-flight scans, which may run up to task_time_limit=300 s (fastapi/jobs/queue.py:66).
    # If Docker SIGKILLs mid-scan, task_acks_late=True leaves the message unacked and Redis redelivers it only
    # after Kombu's default visibility_timeout of 3600 s, so the scan hangs for up to 1 h. An OOM-killed child
    # fails the task instead (no task_reject_on_worker_lost). A reboot can still cut the wait short, because
    # systemd stops docker.service on its own timeout. Follow-up code task: visibility_timeout=900 (§12 #16).
    stop_grace_period: 310s
    logging: *logging

  postgres:
    image: postgres:16
    restart: unless-stopped
    env_file: ./env/postgres.env
    command: >
      postgres
      -c max_connections=60
      -c shared_buffers=256MB
      -c effective_cache_size=1GB
      -c work_mem=4MB
      -c maintenance_work_mem=64MB
      -c random_page_cost=1.1
      -c effective_io_concurrency=200
      -c max_wal_size=1GB
      -c log_min_duration_statement=500
      -c log_parameter_max_length=0
    shm_size: 256mb
    volumes: ["pgdata:/var/lib/postgresql/data"]
    mem_limit: 768m
    healthcheck:                         # -h 127.0.0.1: the first-boot init server listens on the socket only, so this passes only on the real server
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 10s
      timeout: 5s
      retries: 10
    logging: *logging

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction", "--appendonly", "yes"]
    volumes: ["redisdata:/data"]
    mem_limit: 384m                      # Celery messages carry scan images inline (§3)
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 10
    logging: *logging

volumes:
  pgdata: {}
  redisdata: {}
  caddy_data: {}
  caddy_config: {}
```

### 5.2 `/opt/krushisarva/Caddyfile`

```caddyfile
srv2061596.hstgr.cloud {
	# Internal metrics stay internal. Use curl 127.0.0.1:3000/readyz on the host.
	@internal path /readyz /readyz/*
	respond @internal 404

	# Everything else goes to Express: /api/v1, /socket.io (WebSocket upgrade is automatic),
	# /admin, /legal, /healthz. No `encode`: Express already compresses (backend/src/app.js:177).
	# Caddy is on the host network, so the upstream is the host-only published port, not `backend:3000`.
	# keepalive 55s stays below Node's 65 s keepAliveTimeout (backend/src/server.js:59-67); Caddy's 2m
	# default would reuse sockets Node is closing and turn some POSTs (checkout, OTP, scan) into 502s.
	reverse_proxy 127.0.0.1:3000 {
		transport http {
			keepalive 55s
		}
	}
}
```
Caddy sends `X-Forwarded-For` and `X-Forwarded-Proto`. `TRUST_PROXY=1`, the production default (backend/src/config/env.js:175-189), is correct for this single hop **only because Caddy runs on the host network**. The hostname has an AAAA record, and the compose network is IPv4-only. If Caddy sat on that network behind `ports:`, Docker's proxy would hand it every IPv6 client (Jio and Airtel mobile data are largely IPv6) as the bridge gateway `172.x.0.1`. Caddy would write that into `X-Forwarded-For`, `req.ip` would be the gateway (backend/src/app.js:97), and every IPv6 user would share one per-IP bucket (backend/src/middleware/rateLimit.js:141-142): 200 requests per 15 min globally and 50 OTP sends per IP (backend/src/config/env.js:418-419, 455). §8 checks this. The alternative, an IPv6-enabled compose network (`networks: { default: { enable_ipv6: true, ipam: { config: [{ subnet: fd00:6b73::/64 }] } } }`, Docker ≥ 27 with ip6tables on), also works but has more moving parts. If Let's Encrypt refuses the shared `hstgr.cloud` domain, Caddy falls back to ZeroSSL automatically (§12). No ACME `email` is set: Caddy issues certificates without one, and it keeps the owner's address out of the repo.

### 5.3 New repo files for the Python image (commit and push to `main` BEFORE Block B)

These two files go into the repo through a normal reviewed commit on the PC, and the server gets them from `git clone`. **Never paste them into `/opt/krushisarva/app/fastapi/` by hand.** An untracked copy there makes the first `git -C app pull --ff-only` in §8 abort with "untracked working tree files would be overwritten by merge".

fastapi/ had no Dockerfile before this plan. The previous host built it with Nixpacks, and the root build excludes the folder (.dockerignore:19). Python 3.12 matches CI (.github/workflows/ci.yml:118). Every pinned dependency ships wheels, and there are no ML runtimes (fastapi/requirements.txt).

`fastapi/Dockerfile`:
```dockerfile
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
RUN useradd --system --uid 10001 app && chown -R app:app /app
USER app
EXPOSE 8001
# The web command is the default; the celery service overrides it in docker-compose.yml.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1", "--no-access-log"]
```

`fastapi/.dockerignore`:
```text
__pycache__/
**/__pycache__/
*.pyc
.venv/
venv/
.env
.env.*
!.env.example
tests/
eval/
.pytest_cache/
```

---

## 6. Environment variables

**Write the env files on the server.** Secrets are generated in place. Every value is hex, so it needs no URL-encoding and contains no `$` for compose to interpolate.
```sh
cd /opt/krushisarva/env && umask 077
PGPASS=$(openssl rand -hex 24); APPPASS=$(openssl rand -hex 24); AIS=$(openssl rand -hex 32)
# ks = the image's superuser (psql, pg_dump, restore drill only). ks_app = the apps' non-superuser DB owner (§7 step 0).
cat > postgres.env <<EOF
POSTGRES_USER=ks
POSTGRES_PASSWORD=$PGPASS
POSTGRES_DB=krushisarva
KS_APP_PASSWORD=$APPPASS
EOF
cat > backend.env <<EOF
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://ks_app:$APPPASS@postgres:5432/krushisarva
DB_CONNECTION_LIMIT=8
REDIS_URL=redis://redis:6379/0
AI_BACKEND_URL=http://fastapi:8001
AI_SHARED_SECRET=$AIS
USE_FASTAPI_FOR_SCAN=false
JWT_SECRET=$(openssl rand -hex 32)
FIELD_ENCRYPTION_KEY=$(openssl rand -hex 32)
ALLOWED_ORIGINS=https://srv2061596.hstgr.cloud
TRUST_PROXY=1
NODE_OPTIONS=--max-old-space-size=384
UPLOAD_VIDEO_MAX_INFLIGHT=1
RAZORPAY_WEBHOOK_SECRET=$(openssl rand -hex 24)
FIREBASE_AUTH_ENABLED=true
GEMINI_API_KEY=
SARVAM_API_KEY=
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
DATA_GOV_API_KEY=
OPENWEATHER_API_KEY=
LEGAL_DOCS_APPROVED=false
EOF
cat > fastapi.env <<EOF
NODE_ENV=production
DATABASE_URL=postgresql://ks_app:$APPPASS@postgres:5432/krushisarva
REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/1
CELERY_RESULT_BACKEND=redis://redis:6379/1
AI_SHARED_SECRET=$AIS
AI_ALLOWED_ORIGINS=https://srv2061596.hstgr.cloud
GEMINI_API_KEY=
SARVAM_API_KEY=
DATA_GOV_API_KEY=
GROQ_API_KEY=
ENABLE_ENSEMBLE=false
PIPELINE_DEFAULT_TIER=fast
EOF
unset PGPASS APPPASS AIS
nano backend.env fastapi.env      # paste the provider keys; GEMINI_API_KEY and SARVAM_API_KEY are needed before §7 step 5
```
**Firebase service account:** copy the JSON to the server, append the three vars, then shred the file. The literal `\n` sequences are turned back into newlines at backend/src/services/firebaseAuth.service.js:89.
```sh
# on the PC:  scp backend/firebase-service-account.json root@187.127.149.129:/root/sa.json
apt -y install jq
{ echo "FIREBASE_PROJECT_ID=$(jq -r .project_id /root/sa.json)"
  echo "FIREBASE_CLIENT_EMAIL=$(jq -r .client_email /root/sa.json)"
  echo "FIREBASE_PRIVATE_KEY='$(jq -r .private_key /root/sa.json | awk '{printf "%s\\n",$0}')'"
} >> /opt/krushisarva/env/backend.env && shred -u /root/sa.json
```
**Right now, copy `FIELD_ENCRYPTION_KEY` and all three env files into your password manager.** If that key is lost, every encrypted Aadhaar, PAN and bank field becomes unreadable (backend/src/config/env.js:18-33).

| Name | Container | Required? | Where the value comes from |
|---|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | postgres | yes | **generate:** `openssl rand -hex 24` for the password. `ks` is the image's **superuser**: use it only for psql, pg_dump and the restore drill, never in an app `DATABASE_URL`. |
| `KS_APP_PASSWORD` | postgres (read only by §7 step 0; the image ignores it) | yes | **generate:** `openssl rand -hex 24`. Password of `ks_app`, the non-superuser owner of the database that both apps connect as. It can still run `CREATE EXTENSION pg_trgm` (backend/prisma/schema.prisma:12), because pg_trgm is a trusted extension since PG13 and the database owner may create it. A superuser app role would turn any SQL injection (6 `$queryRawUnsafe`/`$executeRawUnsafe` calls in backend/src/utils/keyset.js, services/erasure.service.js, services/retention.service.js) into `COPY … TO PROGRAM` shell access. |
| `NODE_ENV=production` | backend, fastapi | yes | Fixed. The Dockerfile sets it for backend (Dockerfile:39). FastAPI checks `NODE_ENV`/`ENV` (fastapi/main.py:143). Without it FastAPI runs in dev mode, with `/docs` exposed and key checks reduced to warnings. |
| `DATABASE_URL` | backend, fastapi | yes, boot fails without it (backend/src/config/env.js:196) | Built from `ks_app` and `KS_APP_PASSWORD`. Use a **plain** DSN: the backend appends the pool params itself (backend/src/config/db.js:54-64), and asyncpg would reject Prisma-only params. |
| `JWT_SECRET` | backend | yes, 32+ characters (backend/src/config/env.js:237-241) | **generate:** `openssl rand -hex 32` |
| `FIELD_ENCRYPTION_KEY` | backend | yes, 64 hex characters (backend/src/config/env.js:18-33) | **generate:** `openssl rand -hex 32`. **Back it up off the box.** |
| `AI_SHARED_SECRET` | backend **and** fastapi, identical value | yes in prod, 16+ characters (backend/src/config/env.js:618-620) | **generate:** `openssl rand -hex 32`, one value used twice |
| `GEMINI_API_KEY` | backend, fastapi | yes in prod (backend/src/config/env.js:621). Also needed by `seed-categories.js` and `seed-admin.js` (§7 steps 5–6) | Google AI Studio |
| `SARVAM_API_KEY` | backend (required in prod, backend/src/config/env.js:622), fastapi (optional) | yes | Sarvam dashboard |
| `REDIS_URL` | backend `…/0`, fastapi `…/0` | effectively yes. The default `localhost` is wrong inside Docker (backend/src/config/env.js:197), and without Redis the AI routes return 503 (backend/src/config/env.js:434-436). | Fixed: `redis://redis:6379/0` (layout from fastapi/.env.example:35-53) |
| `CELERY_BROKER_URL` / `CELERY_RESULT_BACKEND` | fastapi, celery | yes. The default is localhost (fastapi/jobs/queue.py:35-36). | Fixed: `redis://redis:6379/1` |
| `AI_BACKEND_URL` | backend | yes. The default is localhost (backend/src/config/env.js:323). | Fixed: `http://fastapi:8001` |
| `ALLOWED_ORIGINS` | backend | yes. The backend refuses every browser origin not listed here (backend/src/app.js, the CORS block), so without it the admin SPA white-screens. | Fixed: `https://srv2061596.hstgr.cloud` |
| `AI_ALLOWED_ORIGINS` | fastapi | no, but an invalid value crashes boot in prod | Fixed: same origin |
| `FIREBASE_AUTH_ENABLED` / `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | backend | **yes for login on day one**: Firebase is the only production SMS sign-in, for the apps and the admin panel. The apps were built with Firebase login on (frontend/eas.json:33). The backend needs all three key vars (backend/src/services/firebaseAuth.service.js:48). | Firebase console → Project settings → Service accounts |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | backend | strongly recommended. Without them, image uploads are silently dropped. | Cloudinary dashboard |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | backend | no (without them the backend runs COD-only mock mode) | Razorpay dashboard, test or live mode (decision 5) |
| `RAZORPAY_WEBHOOK_SECRET` | backend | yes if Razorpay is used | **generate:** `openssl rand -hex 24`. Paste the same value into the Razorpay webhook (§10). |
| `DATA_GOV_API_KEY` | backend, fastapi | no (mandi prices stay empty without it) | data.gov.in |
| `OPENWEATHER_API_KEY` / `GROQ_API_KEY` / `OPENAI_API_KEY` | backend / fastapi | no | optional providers |
| `DB_CONNECTION_LIMIT=8`, `NODE_OPTIONS`, `UPLOAD_VIDEO_MAX_INFLIGHT=1`, `TRUST_PROXY=1` | backend | no | RAM and connection fit (§3) |
| `USE_FASTAPI_FOR_SCAN` | backend | no (default false, backend/src/config/env.js:333) | Turn it on after the worker smoke test (decision 7) |
| `ENABLE_ENSEMBLE=false`, `PIPELINE_DEFAULT_TIER=fast` | fastapi | no | Keeps AI cost at 1×. The ensemble costs 2–4×. |
| `LEGAL_DOCS_APPROVED` and the `LEGAL_*` details | backend | no | Decision 11 |
| `OTP_DEV_BYPASS_ENABLED` | backend | **must be absent**. Setting it to `true` in prod refuses boot (backend/src/config/env.js:615-617). | — |
| All other `RATE_LIMIT_*`, `OTP_*`, `VELOCITY_*`, `SESSION_*` and similar knobs | backend | no | The defaults are fine (backend/src/config/env.js:234-501) |

---

## 7. Fresh database bootstrap, about 15 min

Why this order: `prisma db push` is safe **only while the FastAPI tables do not exist yet**. schema.prisma does not model `ai_scan_diagnoses` or `ai_scan_feedback`, and FastAPI creates them lazily on the first scan write (fastapi/persistence/diagnosis_repo.py:104-124). After they exist, a push wants to drop them (Dockerfile:50-66). `prisma migrate deploy` cannot build this database: the migration history is incomplete (Dockerfile:67-71).

```sh
cd /opt/krushisarva
echo "TAG=$(git -C app rev-parse --short HEAD)" > .env
docker compose build backend fastapi                       # 20–30 min on 1 vCPU; swap must be on
docker compose up -d --wait postgres redis                 # --wait returns only once both healthchecks pass (first boot runs initdb)
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\dt"'
#   → "Did not find any relations."   (if tables exist, STOP: this is not a fresh DB)
```
0. **Create the app role** (before the push, so every table is owned by `ks_app`). The password is read inside the container from `postgres.env`, so it never appears on the host command line:
   ```sh
   docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v pw="$KS_APP_PASSWORD"' <<'SQL'
   CREATE ROLE ks_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'pw';
   ALTER DATABASE krushisarva OWNER TO ks_app;
   ALTER SCHEMA public OWNER TO ks_app;
   SQL
   ```
   From here on, **every DDL runs as `ks_app`** (steps 1, 2, 10). A table created as `ks` would be owned by the superuser, and the apps would get "permission denied" on it.
1. **Create the schema once.** It creates pg_trgm plus every table, enum and index, and already includes everything the `prisma/manual/*_additive.sql` scripts add. The prisma CLI is in the image because `npm ci` runs before `NODE_ENV=production` (Dockerfile:31, 39). It connects as `ks_app` through `DATABASE_URL`, and runs as the container's `node` user; if the CLI fails on a non-writable cache, rerun only this one-off with `--user root`.
   ```sh
   docker compose run --rm backend npx prisma db push --skip-generate      # NO --accept-data-loss, ever
   ```
2. **Apply the one object Prisma cannot express**, the mandi natural-key index (backend/prisma/manual/mandi_prices_dedup_2_index.sql:31-49). Use psql, not `prisma db execute`, because it is `CONCURRENTLY` (same file, lines 6-13):
   ```sh
   docker compose exec -T postgres sh -c 'psql -U ks_app -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
     < app/backend/prisma/manual/mandi_prices_dedup_2_index.sql
   ```
3. **Verify:**
   ```sh
   docker compose exec postgres psql -U ks -d krushisarva -Atc "SELECT
     (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'),
     (SELECT extname FROM pg_extension WHERE extname='pg_trgm'),
     (SELECT indisvalid FROM pg_index WHERE indexrelid='mandi_prices_natural_key_uidx'::regclass);"
   #   → 91|pg_trgm|t    (91 is the table count from `prisma migrate diff --from-empty` during planning)
   ```
4. **Do not run any other `prisma/manual/*.sql`.** The push covers every `*_additive.sql`. `admin_v2_additive.sql` fails on a pushed DB with "type already exists", and `catalog_split_3_contract.sql` is destructive. The `catalog_split_*` helper tables (`catalog_split_map`, `catalog_split_near_miss`) and the SQL functions `catalog_norm()` / `catalog_key()` from `catalog_split_1_expand.sql` (lines 69, 82, 352, 368) are **intentionally absent**: they are not in schema.prisma, so creating them would make a later diff try to drop them. On this DB the admin Catalog QC duplicates report shows no backfill rows (backend/src/routes/admin/catalogQc.routes.js:268-279) and merge conflicts are only logged as `[CatalogQC] could not record merge conflict` (same file, 452-462). The live trigram scan still works.
5. **Reference data.** **Fill `GEMINI_API_KEY` and `SARVAM_API_KEY` in `backend.env` first.** `seed-categories.js` and `seed-admin.js` both import the full env guard (backend/prisma/seed-categories.js:7 and seed-admin.js:10 → backend/src/config/db.js:2 → backend/src/config/env.js:609-625), which throws at import time in production when either key is empty. If a run fails with `FATAL: production config invalid`, the keys are missing. `seed.js` does not need them (seed-msp.js and seed-schemes.js open their own bare PrismaClient). MSP rates and schemes (upserts, backend/prisma/seed.js:8-15), then the 22 store categories:
   ```sh
   docker compose run --rm backend node prisma/seed.js
   docker compose run --rm backend node prisma/seed-categories.js     # read the output: a DB error inside the run is only printed, and it still exits 0
   ```
   **Do not use** `npm run setup`, `db:seed:all`, `db:seed:crops` or `mandi:seed`. They call files that do not exist (backend/package.json:21, 31, 32, 34).
6. **First admin.** A user with empty `adminScopes` is a super admin (backend/src/middleware/admin.js:48). Same env guard as step 5 (backend/prisma/seed-admin.js:10).
   ```sh
   docker compose run --rm backend node prisma/seed-admin.js <10-digit-mobile>
   ```
7. **Start the app tier in order:**
   ```sh
   docker compose up -d backend          # feature flags are seeded at boot (backend/src/server.js:225)
   docker compose up -d fastapi celery caddy
   ```
8. **Baseline backup** right away: run §9's script once by hand.
9. **Content gaps on a fresh DB.** CropMaster has no seed, so crop calendar and input calculator return errors until crops are added in Admin → CMS. Mandi prices fill on demand when farmers open the Market screen (backend/prisma/manual/mandi_prices_dedup_2_index.sql:15-17), which needs `DATA_GOV_API_KEY`. The startup and cron "sync trigger" calls a FastAPI route that does not exist (backend/src/server.js:313-323 vs fastapi/routes/agripredict.py:12-15), so it fills nothing.
10. **Every future schema change** goes through a reviewed diff, never `db push`:
    ```sh
    docker compose run --rm -T backend sh -c 'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script' > change.sql
    # -T keeps stderr and CRLFs out of change.sql. Delete any DROP of ai_scan_*, mandi_prices_natural_key_uidx
    # or catalog_split_* (if anyone ever created them by hand), review, then apply AS ks_app so new tables get the right owner:
    docker compose exec -T postgres sh -c 'psql -U ks_app -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < change.sql
    ```

---

## 8. Deploy and update procedure

**Recommendation: `git pull` and build on the server.** One box and 4 users means no registry, no CI secrets and one moving part. The build peak is covered by swap. Run builds in the late IST evening. Revisit with option B, GitHub Actions building to GHCR so the server only pulls, once deploys get frequent or builds start to hurt.

**First start check** (15 min):
```sh
curl -fsS https://srv2061596.hstgr.cloud/healthz                      # {"status":"ok"}  (backend/src/app.js:319)
curl -s 127.0.0.1:3000/readyz                                          # checks.db=ok, checks.redis=ok
curl -s -o /dev/null -w '%{http_code}\n' https://srv2061596.hstgr.cloud/readyz   # 404 (blocked by Caddy)
docker compose exec fastapi python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8001/health').read())"
docker compose logs backend | grep -E 'Redis adapter attached|Started 1 queue worker|CORS'   # no CORS errors
docker compose ps                                                      # all running, healthy
# Real client IPs, IPv6 included (§5.2). Run from the VPS itself: it reaches its own public addresses through Caddy.
curl -6 -s -o /dev/null https://srv2061596.hstgr.cloud/api/v1/ ; curl -4 -s -o /dev/null https://srv2061596.hstgr.cloud/api/v1/
docker compose exec redis redis-cli --scan --pattern 'rl:global:ip:*'  # must show 2a02:4780:… and 187.127.149.129, never 172.x
docker compose exec redis redis-cli info memory | grep -E 'used_memory_human|maxmemory_human'
docker compose exec redis redis-cli -n 1 llen celery                   # Celery backlog; should be 0 or near it
ss -tulpn                                                              # public: only sshd :22 and caddy :80/:443. Loopback only: 3000 (backend), 2019 (Caddy admin)
```
Then open `https://srv2061596.hstgr.cloud/admin/` and confirm the page renders.

**From the PC (PowerShell), prove nothing else is reachable.** Every result must be `False`. Repeat with `2a02:4780:63:444e::1` if the PC has IPv6 (without IPv6 on the PC the v6 run is meaningless; use an online IPv6 port checker instead).
```powershell
foreach ($p in 2019,3000,5432,6379,8001) { "$p " + (Test-NetConnection 187.127.149.129 -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue) }
```

**Update, about 30 min including the build:**
```sh
cd /opt/krushisarva
git -C app status --porcelain              # must print nothing. Untracked copies of fastapi/Dockerfile or .dockerignore? rm them first.
git -C app pull --ff-only
# 1. Does this release change schema.prisma? Apply its reviewed SQL FIRST (§7 step 10, expand-only).
# 2. Build and swap:
echo "TAG=$(git -C app rev-parse --short HEAD)" > .env
docker compose build backend fastapi
docker compose up -d                       # recreates only the containers whose image changed; ~10–20 s API blip.
                                           # celery waits up to 310 s for in-flight scans before it is replaced (§5.1)
curl -fsS https://srv2061596.hstgr.cloud/healthz && cat .env >> deployed-tags.log
docker image ls 'krushisarva-*'            # keep the last 3 tags; remove older ones with docker image rm
docker image prune -f && docker builder prune -f --filter until=168h && docker system df && df -h /
```
`docker image rm` does not free BuildKit's build cache, which grows with every lockfile change (two `npm ci` layers, Dockerfile:8-16, 29-31). Run the same prune line weekly from cron, next to the disk alert (§12 #14):
```sh
echo '0 22 * * 0 root { docker image prune -f; docker builder prune -f --filter until=168h; df -h /; } >> /var/log/ks-prune.log 2>&1' > /etc/cron.d/krushisarva-prune
```

**Rollback:**
1. **Code:** `echo TAG=<previous sha from deployed-tags.log> > .env && docker compose up -d backend fastapi celery`. This takes seconds because the old image is still on disk.
2. **Schema:** changes are additive only (expand, then contract later), so old code still runs on the new schema. Never "roll back" with DROP statements.
3. **Data disaster:** restore the latest `pg_dump` (§9). Last resort: restore a Hostinger snapshot, which loses everything written since the snapshot.

---

## 9. Backups, about 25 min

1. **Nightly `pg_dump`** in custom format at 21:00 UTC (02:30 IST). `/opt/krushisarva/backup.sh`:
   ```sh
   #!/bin/sh
   umask 077                                   # cron's umask 022 would make the dumps (plaintext phone numbers) world-readable
   set -eu
   cd /opt/krushisarva
   F=backups/ks-$(date -u +%Y%m%dT%H%MZ).dump
   docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$F"
   test -s "$F"
   docker compose exec -T postgres pg_restore --list < "$F" > /dev/null      # the dump is readable
   sha256sum "$F" > "$F.sha256"                                              # for the off-box drill (step 5)
   rclone copy "$F" ksbackup:                                                # encrypted off-box copy
   find backups -name 'ks-*.dump*' -mtime +7 -delete                         # local: 7 days
   rclone delete --min-age 30d ksbackup:                                     # off-box: 30 days (drop this line on a no-delete B2/R2 key)
   curl -fsS -m 10 --retry 3 https://hc-ping.com/<uuid> > /dev/null          # dead-man ping: a missed night emails you
   ```
   ```sh
   chmod 700 /opt/krushisarva/backup.sh /opt/krushisarva/backups
   echo '0 21 * * * root /opt/krushisarva/backup.sh >> /var/log/ks-backup.log 2>&1' > /etc/cron.d/krushisarva-backup
   ```
   **Alerting:** create a free healthchecks.io check with a 1-day period and a 2-hour grace, and put its UUID in the last line. `set -eu` stops the script on any failure, so the ping is skipped and you get an email. Without it, a failed night only lands in `/var/log/ks-backup.log`.
2. **Off-box target** (decision 8, default Google Drive): `apt -y install rclone && rclone config`. Create remote `gdrive` (Google Drive, use the headless auth flow) **on a dedicated Google account, with scope `drive.file`** (option 3; the default full `drive` scope would let whoever roots the VPS read the owner's whole Drive). Then create a `crypt` remote named `ksbackup` over `gdrive:krushisarva-backups`. The dumps contain plaintext phone numbers, so they must be encrypted at rest. Store the crypt passwords in the password manager. Note that any token that can write can also delete: root on the VPS can still wipe the off-box copies. If that matters, use Backblaze B2 or Cloudflare R2 with an app key that has no delete permission plus a bucket lifecycle rule for the 30-day retention, and drop the `rclone delete` line.
3. **Hostinger snapshots:** take one manually in hPanel after §7 and before every risky change (OS upgrade, schema change). Check in hPanel how many snapshot slots and automatic backups KVM 1 includes; a new manual snapshot usually replaces the old one.
4. **Secrets backup (one time):** the three env files and `FIELD_ENCRYPTION_KEY` go in the password manager, not in the Drive folder.
5. **Monthly restore drill** (20 min). Part A proves the dump restores; part B proves the off-box copy can be decrypted with what is in the password manager, which is the only copy left if the box is gone.
   ```sh
   # A. on the server
   docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" restore_test && pg_restore -U "$POSTGRES_USER" -d restore_test --no-owner' < backups/<latest>.dump
   docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d restore_test -Atc "select count(*) from users" && dropdb -U "$POSTGRES_USER" restore_test'
   cat backups/<latest>.dump.sha256
   ```
   ```powershell
   # B. on the PC: rclone remotes gdrive + ksbackup configured from the password-manager values only (same Google account and client ID)
   rclone copy ksbackup:<latest>.dump .
   Get-FileHash .\<latest>.dump -Algorithm SHA256        # must equal the server's .sha256; then delete the local file
   ```

| What | Where | Kept |
|---|---|---|
| pg_dump nightly | `/opt/krushisarva/backups` | 7 days |
| pg_dump nightly (encrypted) | Google Drive (dedicated account, `drive.file` scope) via rclone crypt | 30 days |
| Compose file and Caddyfile | the repo, `deploy/` (decision 13), committed before the cutover | git history |
| Hostinger snapshot | hPanel | latest manual, plus whatever the plan includes |
| Env files and encryption key | password manager | forever |

Redis is not backed up. AOF survives restarts, and the cache can be rebuilt. Caddy certificates can be re-issued, but keep the volume.

---

## 10. Cutover of the apps, about 50 min

**Precondition:** §8's `/healthz` check over HTTPS passes, and `/admin/` renders. Publishing the OTA earlier sends installed apps to a host that is not ready.

1. **Edit the URLs for future builds** (one commit; `eas update` requires a clean git tree):

   | File:line | New value |
   |---|---|
   | frontend/eas.json:31, 43 | `https://srv2061596.hstgr.cloud/api/v1` |
   | frontend/eas.json:32, 44 | `wss://srv2061596.hstgr.cloud` |
   | seller-app/eas.json:28, 40 | `https://srv2061596.hstgr.cloud/api/v1` |
   | seller-app/eas.json:29, 41 | `wss://srv2061596.hstgr.cloud` |
   | shared/constants/config.js:35 (fallback `PROD_API`) | `'https://srv2061596.hstgr.cloud/api/v1'` |
   | shared/constants/config.js:37 (fallback `PROD_SOCKET`) | `'wss://srv2061596.hstgr.cloud'` |

2. **Choose which JS to ship** (decision 3). The safe default is fb7b4c8 plus only these edits, so the JS exactly matches the native code in the installed APKs:
   ```powershell
   git worktree add -b ota/vps-url ..\ks-ota fb7b4c8
   # make the 6 edits above inside ..\ks-ota, then:
   git -C ..\ks-ota commit -am "chore: point apps at the Hostinger VPS"
   ```
   Make the same edits on `main` too, for future builds.
3. **Publish both OTAs.** `eas update` does **not** read `eas.json` `env`, so set the variables in the shell, and **include `EXPO_PUBLIC_FIREBASE_AUTH=true`, or login silently switches to the dev OTP flow, which returns 503 in prod**. Runtime 1.0.0 matches the installed builds (frontend/app.json:6-9, channel at frontend/eas.json:29 and seller-app/eas.json:26).
   ```powershell
   $env:EXPO_PUBLIC_API_BASE_URL='https://srv2061596.hstgr.cloud/api/v1'
   $env:EXPO_PUBLIC_SOCKET_URL='wss://srv2061596.hstgr.cloud'
   $env:EXPO_PUBLIC_FIREBASE_AUTH='true'
   cd ..\ks-ota\frontend;   npm ci; npx eas update --channel preview --platform android --clear-cache --message "API -> Hostinger VPS"
   cd ..\seller-app;        npm ci; npx eas update --channel preview --platform android --clear-cache --message "API -> Hostinger VPS"
   npx eas update:list --branch preview      # in each app folder: runtime 1.0.0, android
   ```
4. **Phone test:** open each app, swipe it away, and open it again. The update applies on the **second** cold start (`fallbackToCacheTimeout: 0`, frontend/app.json:12). Then check Firebase OTP login, a socket screen such as chat or notifications (the client is websocket-only, shared/services/socket.js:77), and the Terms and Privacy links.
5. **Admin panel:** lives only on Vercel, `https://krushi-sarva.vercel.app`. The VPS does not serve it; `https://srv2061596.hstgr.cloud/admin*` redirects there. Vercel proxies `/api/*` to the VPS (admin/vercel.json), so the SPA keeps the relative `/api/v1`. Login uses Firebase: set the four `VITE_FIREBASE_*` values in the Vercel project and add `krushi-sarva.vercel.app` to Firebase authorized domains (admin/README.md "Hosting on Vercel"); without them the SPA shows the dev OTP flow, which returns 503 in prod (decision 1).
6. **Razorpay:** Dashboard → Settings → Webhooks. Point the URL at `https://srv2061596.hstgr.cloud/api/v1/shop-webhooks/razorpay`, the path the code calls the dashboard's current one (backend/src/app.js:289-304; route at backend/src/routes/paymentWebhooks.routes.js:124). Set the secret to `RAZORPAY_WEBHOOK_SECRET`, keep the existing events, send a test event, and check that `docker compose logs backend` shows no 400.
7. **Play Console:** set the privacy policy URL to `https://srv2061596.hstgr.cloud/legal/privacy`, if a listing exists.
8. **No change needed:** website/ (static), Expo push, Firebase phone auth (it uses SHA fingerprints, not domains), Cloudinary (uploads are signed on the server), FastAPI CORS (server-to-server only).

---

## 11. Owner decisions (each has a recommended default)

1. **Login on day one.** Firebase is the only production SMS sign-in. **Decided:** the apps and the admin SPA both log in through Firebase (service-account env, §6; the admin SPA, hosted only on Vercel at `https://krushi-sarva.vercel.app`, also needs its `VITE_FIREBASE_*` values in the Vercel project). The backend's `/auth/send-otp` is a dev/test login only and returns 503 in prod. **Never** run `NODE_ENV=development` publicly to get `devOtp`, because that is an open sign-in bypass.
2. **Hostname.** **Default:** keep `srv2061596.hstgr.cloud` now, and buy a domain before the first Play Store production build. Changing it later means another OTA, more eas.json edits and another Razorpay update.
3. **OTA JS source.** **Default:** fb7b4c8 plus the URL edits (safe). HEAD adds seller payment status and order tracking, but runs Firebase JS 26.4.0 on native 26.3.3.
4. **Gemini and Sarvam keys.** **Default:** real keys. Prod refuses to boot without them (backend/src/config/env.js:621-622), and so do `seed-categories.js` and `seed-admin.js` (§7 steps 5–6). Placeholders would boot, but AI and voice would then fail.
5. **Razorpay mode.** **Default:** test keys until live KYC is done. Without keys, checkout is COD only.
6. **Cloudinary.** **Default:** reuse the existing account's keys. Without them, images are silently dropped.
7. **FastAPI scans.** **Default:** start with `USE_FASTAPI_FOR_SCAN=false`, do one test scan through Celery, then turn it on (in the env or the admin setting `ai.useFastapiForScan`).
8. **Off-box backup target.** **Default:** Google Drive through an rclone crypt remote, on a dedicated Google account with `drive.file` scope, plus a free healthchecks.io dead-man check (§9). Alternatives: Backblaze B2 or Cloudflare R2 with a no-delete app key and a lifecycle rule, which also stops a VPS intruder from deleting the off-box copies.
9. **Auto-reboot for security updates.** **Default:** yes, at 21:30 UTC (03:00 IST).
10. **Non-root deploy user.** **Default:** skip for now, with root key-only login. Add one when a second person needs access.
11. **Legal pages.** **Default:** `LEGAL_DOCS_APPROVED=false`, which serves a "being finalised" notice, until the texts and grievance-officer details are reviewed.
12. **Re-baseline Prisma migrations on this fresh DB** (a `0_init` from `migrate diff --from-empty` plus `migrate resolve --applied`). **Default:** yes, as a separate task this week. A fresh DB is the cheapest moment, and it ends hand-written SQL for every change.
13. **Compose file and Caddyfile in the repo** (`deploy/`). **Default:** yes, **before the app cutover (§10)**, together with this plan (`docs/deploy/` is untracked today), with env files still on the server only. Until then they exist only on the box, so losing it loses them too. (`fastapi/Dockerfile` and `fastapi/.dockerignore` are not part of this decision: they are committed before Block B, §5.3.)

---

## 12. Risks and known gaps

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Login lockout.** Firebase is the only production SMS sign-in. The backend needs the Firebase env, the admin SPA needs its `VITE_FIREBASE_*` build values, and the OTA must carry `EXPO_PUBLIC_FIREBASE_AUTH=true` (shared/constants/config.js:81-93). | Decision 1. §10 step 3 sets the variable explicitly. |
| 2 | **One small box is a single point of failure.** A Hostinger or VPS outage takes everything down, the DB included. | Nightly encrypted off-box dumps with a dead-man ping, snapshots, and the monthly drill that also decrypts the off-box copy from the PC (§9). Compose file and Caddyfile committed before cutover (decision 13). |
| 3 | **Memory and CPU pressure.** A server-side build (1–1.5 GB) on top of the stack, and Celery image decode (fastapi/jobs/tasks.py:91 allows 50 MP; two children decoding at once peak near 750 MB). | `mem_limit` on every container (Celery 768m, §3), 2 GB swap, builds at quiet hours, option B later. If Celery still hits its limit, drop to `--concurrency=1`. |
| 4 | **Schema trap.** Any later `prisma db push` drops the empty `ai_scan_*` tables or aborts (Dockerfile:50-66). The migration history is incomplete (Dockerfile:67-71). The mandi index lives outside schema.prisma. | Push exactly once (§7). Reviewed diffs after that. Decision 12. |
| 5 | **Docker publishes ports past ufw.** One stray `ports: 5432:5432` exposes the DB. | §2 rule 1. Only `127.0.0.1:3000` is published; Caddy is on the host network. Docker ≥ 28 and the `docker ps -a` / `ss -tulpn` checks (§4 step 8), plus the port scan from the PC (§8). |
| 6 | **Losing `FIELD_ENCRYPTION_KEY`** makes the PII permanently unreadable. | Password manager, §6. |
| 7 | **Redis is one `noeviction` instance for cache and queues.** Celery messages carry scan images inline, so a stalled worker fills it fast. At 256 MB full, cache, rate-limit, denylist **and** queue writes fail, and BullMQ jobs fall back to running inline on the request path (backend/src/queue/jobQueue.js:56-64). | `maxmemory 256mb` / `mem_limit 384m` (§5.1). Watch `redis-cli info memory` and `redis-cli -n 1 llen celery` (§8); raise `maxmemory` before it fills. |
| 8 | **Let's Encrypt and `hstgr.cloud`.** It is a domain shared by all Hostinger customers, so the per-domain rate limits could bite. | Caddy falls back to ZeroSSL automatically. Long term, decision 2. |
| 9 | **Mandi sync is dead code.** The trigger calls a FastAPI route that does not exist (backend/src/server.js:313-323, fastapi/routes/agripredict.py:12-15). | Prices still fill on demand (needs `DATA_GOV_API_KEY`). Fixing it is a separate task. |
| 10 | **The asyncpg pool size is hard-coded** at 2–10 per process (fastapi/db_pool.py:68-70). Adding Celery children costs +10 connections each. | Raise `max_connections` together with any concurrency change (§3 table). |
| 11 | **The FastAPI healthcheck is informational only.** Docker does not restart unhealthy containers, and a stalled Celery worker only shows as `degraded` after 600 s. | Check `docker compose ps` after every deploy. Automated alerting is still missing (a known gap). |
| 12 | **Downtime on deploy.** There is one backend replica, so each update causes a 10–20 s API blip. | Acceptable at 4 users. Clients retry. |
| 13 | **An empty CropMaster and empty mandi prices** on day one make some farmer screens look broken. | §7 step 9. |
| 14 | **No monitoring or alerting** beyond logs and the backup dead-man ping (§9): no uptime check, no disk alert. BuildKit cache also grows with every build. | Next step: a free external uptime check on `/healthz`, plus a cron job that alerts when disk use passes 80%. Weekly image and builder prune (§8). |
| 15 | **IPv6 clients collapsing onto one IP.** The hostname has an AAAA record. If Caddy is ever moved back to `ports:` on the IPv4-only compose network, every IPv6 user shares the bridge gateway's rate-limit bucket (200 req / 15 min, 50 OTP sends per IP) and gets 429s. | Caddy on `network_mode: host` (§5.1, §5.2); the `rl:global:ip:*` check in §8 after any Caddy or network change. |
| 16 | **A SIGKILLed Celery scan hangs for up to 1 h.** Kombu's Redis `visibility_timeout` defaults to 3600 s and fastapi/jobs/queue.py:57-70 does not set it, so an unacked task is redelivered only an hour later. An OOM-killed child fails its scan outright. | `stop_grace_period: 310s` on celery (§5.1). Follow-up code task: `broker_transport_options={'visibility_timeout': 900}` in fastapi/jobs/queue.py (above `task_time_limit=300`). |
| 17 | **Postgres superuser exposure.** `ks` is the image's superuser. | Apps use the non-superuser owner `ks_app` (§6, §7 step 0); `ks` only for psql, pg_dump and drills. Slow-query log drops bind values (`log_parameter_max_length=0`). |

---

## 13. Manual app updates

Users now choose when an update is applied. The apps only **check** for an update by themselves, on launch and when they come back to the foreground, at most once every 30 minutes (2 minutes after a check that failed). They never download one in the background (shared/hooks/useAppUpdate.js). Nothing runs in dev builds (`__DEV__`), in Expo Go or development builds (no EAS channel), or when expo-updates is disabled. A failed automatic check is silent; only a check the user started shows an error.

**What users see**

- **Banner** at the top of any screen (shared/components/AppUpdateBanner.js): "New version available" with **Update now** and **Later**. **Update now** downloads the update, shows "Updating…" and restarts the app. If the update is already downloaded, the button reads "Restart to update". When the download fails, the banner says "Couldn't update. Check your internet." with **Try again**. Every state, the download included, has **Later**, which hides the banner for that update until the app is next opened. Automatic checks continue after **Later**, so a newer update brings the banner back.
- **No surprise restart.** If the user taps **Later** during the download, or leaves the app before it finishes, the app does not restart. The update waits as "Restart to update", and the next cold start applies it anyway.
- **Profile → App version**: shows `1.0.1 · <first 8 characters of the update id>`, or "built-in" when the app runs the bundle inside the APK, with a **Check for updates** button. It answers "You're up to date", "New version available" (with **Update now**), "Couldn't check. Try again." or, after a failed download, "Couldn't update…" with **Try again**. A downloaded update reads **Restart to update**. Both rows take their text from `describeUpdateRow` in the same hook file.
- **Crash screen.** If a published update crashes on launch, the error screen's **Reload** first checks for and downloads a newer update, then restarts (shared/components/RootErrorBoundary.js). That is the path for any error the boundary catches, because expo-updates' own crash recovery does not run for those. A crash the boundary cannot catch (a JS error before React mounts) is covered natively by `checkAutomatically: ON_ERROR_RECOVERY` (below). Test every update on a phone before publishing it to `preview`.

**Native setting, new builds only.** `"checkAutomatically": "ON_ERROR_RECOVERY"` in `expo.updates` (frontend/app.json:10-14, seller-app/app.json:10-14) means the native layer never checks or downloads during normal use. It checks only after an update failed to launch, so it can roll back and fetch a hotfix (`NEVER` would leave such an app stuck until reinstall). The value is written into the Android manifest at build time, so it takes effect only in a **new APK build**. The first builds with it are the **1.0.1** APKs built from `main` on 2026-10-14. The **1.0.0** preview APKs from 2026-10-12 (fb7b4c8) are retired: reinstall the 1.0.1 APKs over them. Their last over-the-air update is the VPS host switch, and the `..\ks-ota` checkout used for it is deleted.

**Publishing an update.** Publish from **this checkout** (`main`). The installed 1.0.1 APKs were built from it, so its JS matches their native code. Never publish JS whose native dependencies differ from the installed build: if a change adds or upgrades a native module, build a new APK instead, and bump `expo.version` so older builds stop receiving updates they cannot run. `eas update` does **not** read `eas.json` `env`, so set the variables in the shell first. **Without `EXPO_PUBLIC_FIREBASE_AUTH=true`, login silently switches to the dev OTP flow, which returns 503 in prod** (shared/constants/config.js:94). As in §10 step 3, run `npm ci` and `--clear-cache`, so stale Metro output or old env values do not get baked into the bundle:

```powershell
$env:EXPO_PUBLIC_API_BASE_URL='https://srv2061596.hstgr.cloud/api/v1'
$env:EXPO_PUBLIC_SOCKET_URL='wss://srv2061596.hstgr.cloud'
$env:EXPO_PUBLIC_FIREBASE_AUTH='true'
cd frontend;      npm ci; npx eas update --channel preview --platform android --clear-cache --message "What changed"
cd ..\seller-app; npm ci; npx eas update --channel preview --platform android --clear-cache --message "What changed"
npx eas update:list --branch preview      # in each app folder: runtime 1.0.1, android
```

The `preview` channel (frontend/eas.json:29, seller-app/eas.json:26) maps to the EAS branch `preview` (the mapping was created on 2026-10-14; the channel had none before). An update reaches only builds with the same runtime version. The policy is `appVersion` (frontend/app.json:7-9), so it is `1.0.1` now. Updates published for 1.0.1 never reach the retired 1.0.0 APKs.
