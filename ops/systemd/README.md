# systemd deployment example

These units are examples for a small Linux home server. They intentionally use explicit absolute paths so there is no ambiguity about what must be customized.

The examples assume:

- application checkout/build: `/opt/ai-news-assistant`
- Node.js executable: `/usr/bin/node`
- service account: `ai-news-assistant`
- writable application data: `/var/lib/ai-news-assistant`
- environment file: `/etc/ai-news-assistant.env`

Change those values before installation if your server uses different paths. In particular, run `command -v node` and replace `/usr/bin/node` in both service files when Node is installed elsewhere. Do not put API keys directly in the unit files. Put secrets only in `/etc/ai-news-assistant.env`, owned by root and readable by the service account only when required.

## Prepare the application

Build the application from its checkout and create the runtime directories:

```bash
cd /opt/ai-news-assistant
npm ci
npm run check
npm run build
sudo useradd --system --home /var/lib/ai-news-assistant --shell /usr/sbin/nologin ai-news-assistant
sudo install -d -o ai-news-assistant -g ai-news-assistant /var/lib/ai-news-assistant
sudo install -m 0640 -o root -g ai-news-assistant /dev/null /etc/ai-news-assistant.env
```

Populate `/etc/ai-news-assistant.env` using `.env.example` as the reference. For the sample units, use absolute storage paths such as:

```dotenv
DATA_DIR=/var/lib/ai-news-assistant
OUTPUT_DIR=/var/lib/ai-news-assistant/public/daily
HOST=192.168.1.20
PORT=8787
LLM_BASE_URL=http://127.0.0.1:11434
LLM_MODEL=your-model
```

Add `LLM_API_KEY` only in that protected environment file when a cloud endpoint requires it.

## Install and enable

```bash
sudo install -m 0644 ops/systemd/ai-news-assistant-serve.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/ai-news-assistant-run.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/ai-news-assistant-run.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-news-assistant-serve.service
sudo systemctl enable --now ai-news-assistant-run.timer
```

The timer starts at 06:00 and adds up to 30 minutes of randomized delay, keeping normal generation in the 06:00–06:30 window. To choose a fixed time, create a timer drop-in:

```bash
sudo systemctl edit ai-news-assistant-run.timer
```

For example:

```ini
[Timer]
OnCalendar=
OnCalendar=*-*-* 06:15:00
RandomizedDelaySec=0
```

Then run `sudo systemctl daemon-reload && sudo systemctl restart ai-news-assistant-run.timer`.

## LAN and firewall assumptions

The delivery endpoint has no built-in authentication. Prefer binding `HOST` to a private LAN address and allowing `PORT` only from the trusted LAN in the host firewall. Do not forward the port directly from the public internet. If access is needed outside the LAN, put the service behind a reverse proxy that provides TLS and authentication, or use a private VPN such as WireGuard/Tailscale.

## Operations

Inspect delivery logs and the most recent generation job:

```bash
journalctl -u ai-news-assistant-serve.service -n 100 --no-pager
journalctl -u ai-news-assistant-run.service -n 200 --no-pager
systemctl status ai-news-assistant-run.timer
```

Run the morning job manually with the same service environment:

```bash
sudo systemctl start ai-news-assistant-run.service
journalctl -u ai-news-assistant-run.service -f
```

The application also has its own PID-aware file lock under `DATA_DIR`, so a manual `run` started while the timer job is active exits cleanly instead of duplicating work. A stale lock left by a killed process is removed automatically on the next run.

Check delivery and generation status from the LAN:

```bash
curl -fsS http://192.168.1.20:8787/healthz
curl -fO http://192.168.1.20:8787/daily/latest.epub
```

`/healthz` keeps the delivery server itself healthy even if the last generator attempt failed, but reports `degraded: true`, the last attempt status/failure code, latest edition presence, and the last successful run timestamp. Because EPUB publication is atomic, yesterday's `latest.epub` remains available when today's generation fails.

Dated EPUBs are retained according to `EDITION_RETENTION_DAYS` (default 30) and dated build directories according to `BUILD_RETENTION_DAYS` (default 7). Cleanup runs after successful generation only. `news.sqlite` and its article/analysis history are never removed by retention cleanup.

For an emergency rollback after a bad but successful edition, replace `latest.epub` from a retained dated EPUB using a same-directory temporary file so readers never observe a partial copy:

```bash
cd /var/lib/ai-news-assistant/public/daily
cp 2026-08-28.epub .latest.epub.rollback
mv .latest.epub.rollback latest.epub
```

That restores what `/daily/latest.epub` serves immediately. `latest.json` still describes the most recently generated edition until the next successful run, so treat the EPUB itself as authoritative during this manual rollback window.
