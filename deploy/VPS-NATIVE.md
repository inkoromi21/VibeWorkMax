# Native VPS deployment (without Docker)

This deployment mode runs the API and worker as dedicated unprivileged
systemd services. Nginx serves the compiled web application and proxies only
the API and MAX webhook to the local API process. PostgreSQL and Redis remain
local system services. Docker, MinIO, and ClamAV are deliberately excluded.

It is intended for the current low-memory VPS and keeps all external
integrations disabled until their production configuration is supplied.

## One-time prerequisites

The host needs Ubuntu/Debian packages `postgresql`, `redis-server`, `nginx`,
`curl`, plus Node.js 22 and pnpm 11. Node.js must be installed before running
the update script. On a 1 GB host, configure at least 2 GB swap before the
first dependency install and build.

The Git deploy key on the VPS must have read-only access to
`inkoromi21/VibeWorkMax`.

Create a dedicated key with a passphrase. Do not pass `-N ""`: SSH will ask
for this passphrase on every deployment.

```sh
install -d -m 0700 /root/.ssh
ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519_vibeworkmax -C "vibeworkmax-vps"
cat /root/.ssh/id_ed25519_vibeworkmax.pub
```

Add the printed public key in the GitHub repository under **Settings → Deploy
keys** with read-only access. The private key remains only on the VPS.

## First installation

Run as root after cloning the repository to `/opt/vibeworkmax`:

```sh
apt-get update
apt-get install -y postgresql redis-server nginx curl
systemctl enable --now postgresql redis-server nginx
useradd --system --home /nonexistent --shell /usr/sbin/nologin vibework 2>/dev/null || true
install -d -o root -g vibework -m 0750 /etc/vibework-max
```

Create `/etc/vibework-max/vibework-max.env`, owned by `root:vibework` with
mode `0640`. Do not commit it. At minimum it must contain:

```dotenv
NODE_ENV=production
LOG_LEVEL=info
API_HOST=127.0.0.1
API_PORT=3000
WORKER_HEALTH_HOST=127.0.0.1
WORKER_HEALTH_PORT=3001
DATABASE_URL=postgresql://vibework:REPLACE_WITH_PASSWORD@127.0.0.1:5432/vibework
REDIS_URL=redis://127.0.0.1:6379
MAX_MODE=disabled
YANDEX_AI_MODE=disabled
ANALYTICS_MODE=disabled
NOTIFICATION_MODE=disabled
```

Create the PostgreSQL role and database using the same password, then install
the service definitions and site configuration:

```sh
install -m 0644 deploy/native/vibework-max-api.service /etc/systemd/system/
install -m 0644 deploy/native/vibework-max-worker.service /etc/systemd/system/
install -m 0644 deploy/native/nginx-vibework-max.conf /etc/nginx/sites-available/vibework-max
ln -sfn /etc/nginx/sites-available/vibework-max /etc/nginx/sites-enabled/vibework-max
systemctl daemon-reload
nginx -t && systemctl reload nginx
systemctl enable vibework-max-api vibework-max-worker
bash deploy/vps-native-update.sh
```

If another site is already using port 80, do not enable this Nginx file until
its `server_name` and routing have been reconciled with that site.

## Routine update

```sh
cd /opt/vibeworkmax && bash deploy/vps-native-pull-and-update.sh
```

The command asks for the deploy-key passphrase, pulls only a fast-forward
update from `main`, then builds and restarts the services. It does not store
the passphrase in `ssh-agent` and refuses non-interactive execution.

## Verification and recovery

```sh
curl -f http://127.0.0.1/health
systemctl status vibework-max-api vibework-max-worker
journalctl -u vibework-max-api -u vibework-max-worker -n 100 --no-pager
```

If a new release fails before migrations are applied, reset the checkout to
the previous Git revision and rerun the update script. Do not roll database
migrations back automatically; review compatibility first.
