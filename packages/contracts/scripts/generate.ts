import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = new URL('../source/', import.meta.url);
const outputPath = fileURLToPath(new URL('../src/generated/contracts.ts', import.meta.url));

async function generateFile(name: string): Promise<string> {
  const schema = JSON.parse(await readFile(new URL(name, sourceRoot), 'utf8')) as Record<
    string,
    unknown
  >;
  return compile(schema, String(schema.title), {
    bannerComment: '',
    format: false,
    unreachableDefinitions: true,
    unknownAny: false,
  });
}

export async function generatedContracts(): Promise<string> {
  const source = await generateFile('schemas.json');
  const phase1 = await generateFile('phase1-schemas.json');
  return `/* Generated from immutable JSON Schemas. Do not edit. */\n\n${source}\n${phase1}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await writeFile(outputPath, await generatedContracts(), 'utf8');
  process.stdout.write(`generated ${outputPath.replace(packageRoot, '.')}\n`);
}
