/** Read-only MAX credential/TLS smoke. Never prints token, bot identity, or response body. */
if (!process.env.MAX_BOT_TOKEN) {
  throw new Error('MAX_BOT_TOKEN is not configured');
}

try {
  const response = await fetch('https://platform-api2.max.ru/me', {
    headers: { Authorization: process.env.MAX_BOT_TOKEN },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    process.stderr.write(`MAX GET /me returned HTTP ${response.status}\n`);
    process.exitCode = 1;
  } else {
    const body = await response.json();
    if (body?.is_bot !== true) {
      process.stderr.write('MAX GET /me did not return a bot identity\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('MAX TLS and bot token: verified\n');
    }
  }
} catch (error) {
  const code = error?.cause?.code ?? error?.name ?? 'UNKNOWN';
  process.stderr.write(`MAX GET /me failed: ${String(code)}\n`);
  if (code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') {
    process.stderr.write(
      'Configure an approved Russian Trusted Root CA PEM through NODE_EXTRA_CA_CERTS; do not disable TLS verification.\n',
    );
  }
  process.exitCode = 1;
}
