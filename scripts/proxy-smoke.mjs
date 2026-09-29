import { createHmac } from 'node:crypto';

const baseUrl = process.env.PROXY_SMOKE_URL ?? 'http://127.0.0.1:8080';
const token = process.env.MAX_BOT_TOKEN;
if (!token) throw new Error('MAX_BOT_TOKEN is required for proxy smoke');

const authDate = String(Math.floor(Date.now() / 1_000));
const user = JSON.stringify({ id: 424242 });
const check = `auth_date=${authDate}\nuser=${user}`;
const secret = createHmac('sha256', 'WebAppData').update(token).digest();
const hash = createHmac('sha256', secret).update(check).digest('hex');
const initData = `auth_date=${encodeURIComponent(authDate)}&user=${encodeURIComponent(user)}&hash=${hash}`;

const created = await fetch(`${baseUrl}/api/mini-app/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ initData }),
});
if (created.status !== 201) throw new Error(`proxy session smoke failed: ${created.status}`);
const cookie = created.headers.get('set-cookie')?.split(';', 1)[0];
if (!cookie) throw new Error('proxy session smoke did not return a cookie');
const session = await created.json();
if (typeof session.csrfToken !== 'string') throw new Error('proxy session smoke has no CSRF token');

const bootstrap = await fetch(`${baseUrl}/api/mini-app/bootstrap`, {
  headers: { cookie },
});
if (!bootstrap.ok) throw new Error(`proxy bootstrap smoke failed: ${bootstrap.status}`);
const payload = await bootstrap.json();
if (!payload.state || typeof payload.csrfToken !== 'string')
  throw new Error('proxy bootstrap smoke returned an invalid payload');

process.stdout.write('proxy smoke: session and bootstrap through /api/mini-app succeeded\n');
