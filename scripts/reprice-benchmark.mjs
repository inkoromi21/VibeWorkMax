import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  pricingCatalogFromEnvironment,
  repriceBenchmarkFromRecordedUsage,
} from '../packages/ai/dist/index.js';

const inputPath = process.env.BENCHMARK_INPUT_PATH;
const outputDirectory = process.env.BENCHMARK_OUTPUT_DIR;
if (!inputPath || !outputDirectory) {
  throw new Error('BENCHMARK_INPUT_PATH and BENCHMARK_OUTPUT_DIR are required');
}
const pricing = pricingCatalogFromEnvironment();
if (!pricing) throw new Error('AI_PRICING_CONFIG_JSON is required');
const original = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
if (original.invocations.some((row) => row.status !== 'SUCCEEDED'))
  throw new Error('Cannot declare exact total cost when an invocation failed');
const corrected = repriceBenchmarkFromRecordedUsage(original, pricing);
const expectedCount = original.models.length * original.runCount * 6;
if (corrected.invocations.length !== expectedCount)
  throw new Error('Benchmark invocation count is incomplete');
await mkdir(resolve(outputDirectory), { recursive: false });
await writeFile(
  resolve(outputDirectory, 'benchmark-results.json'),
  `${JSON.stringify(corrected, null, 2)}\n`,
);
await writeFile(
  resolve(outputDirectory, 'cost-reconciliation.md'),
  [
    '# Cost reconciliation',
    '',
    `- Source: \`${inputPath}\` (unchanged raw benchmark).`,
    `- Pricing version: \`${pricing.version}\`.`,
    `- Reconciled spend from recorded provider usage and the requested model URI: **${corrected.actualAiSpend.amount} ${corrected.actualAiSpend.currency}**.`,
    `- Requests: ${corrected.invocations.length}; failed: ${corrected.invocations.filter((row) => row.status === 'FAILED').length}.`,
    `- ModelPolicy: \`${corrected.modelPolicy.status}\` (expert rubric is not yet applied).`,
    '- Original provider model aliases were not tariff keys. The original report undercounted known costs; this file does not trigger new provider calls.',
    '- Official synchronous RUB tariff source, checked 2026-09-29: https://aistudio.yandex.ru/ru/docs/ai-studio/pricing',
    '',
  ].join('\n'),
);
process.stdout.write(`RECONCILED: ${resolve(outputDirectory)}\n`);
