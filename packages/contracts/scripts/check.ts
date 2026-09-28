import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { generatedContracts } from './generate.js';

const sourceRoot = fileURLToPath(new URL('../source/', import.meta.url));
const expected = new Map([
  ['fixtures.json', '4faa5dad9efbc52e4110adcc8c38830cc7da893361e31d007f1e23617ae80c98'],
  ['openapi-core.json', '40d13875449a0e2e137fc41af4be999b47a4319b5054ea9a6f14926fcbede873'],
  ['schemas.json', '3ac9318ca3896168a5001291c868353966180fd00a50a1b56e6ac71bc5669f34'],
]);

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

for (const [name, checksum] of expected) {
  const local = await readFile(`${sourceRoot}/${name}`);
  if (sha256(local) !== checksum) throw new Error(`checksum mismatch: ${name}`);
  const original = `/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Контракты и примеры/${name}`;
  if (existsSync(original) && sha256(await readFile(original)) !== checksum) {
    throw new Error(`source checksum mismatch: ${name}`);
  }
}

const schema = JSON.parse(await readFile(`${sourceRoot}/schemas.json`, 'utf8')) as {
  $defs: object;
};
if (Object.keys(schema.$defs).length !== 21) throw new Error('expected 21 schema definitions');

const api = (await SwaggerParser.validate(`${sourceRoot}/openapi-core.json`)) as { paths?: object };
if (Object.keys(api.paths ?? {}).length !== 17) throw new Error('expected 17 OpenAPI paths');

const committed = await readFile(new URL('../src/generated/contracts.ts', import.meta.url), 'utf8');
if (committed !== (await generatedContracts())) throw new Error('generated contracts are stale');

process.stdout.write('contracts: checksums, 21 definitions, 17 paths, generated types OK\n');
