#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ALLOWED_STATUSES = new Set(['не начато', 'ожидается', 'частично', 'получено', 'не требуется', 'блокировано']);
const FORBIDDEN_NAMES = [/(^|\/)\.env($|\.)/i, /(^|\/)vibework\.db$/i, /(^|\/).*\.(sqlite|sqlite3|db)$/i, /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|node_modules)(\/|$)/i];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function read(root, path) {
  const full = resolve(root, path);
  invariant(existsSync(full), `Отсутствует ${path}`);
  return readFileSync(full, 'utf8');
}

function rows(text, prefix) {
  return text.split(/\r?\n/).filter((line) => line.startsWith(`| ${prefix}`));
}

function cells(line) {
  return line.split('|').slice(1, -1).map((value) => value.trim());
}

export function parseMissingRows(text) {
  return rows(text, 'MI-').map((line) => {
    const values = cells(line);
    invariant(values.length >= 10, `Неполная строка MISSING_INPUTS: ${line}`);
    const [id, category, name, owner, status, deadline, env, impact, fallback, acquisition] = values;
    return { id, category, name, owner, status, deadline, env, impact, fallback, acquisition };
  });
}

export function validateMissingRows(items) {
  invariant(items.length > 0, 'Реестр отсутствующих данных пуст');
  const ids = new Set();
  for (const item of items) {
    invariant(!ids.has(item.id), `Дублирующий ID ${item.id}`);
    ids.add(item.id);
    invariant(ALLOWED_STATUSES.has(item.status), `Недопустимый status у ${item.id}: ${item.status}`);
    for (const field of ['owner', 'deadline', 'impact', 'fallback', 'acquisition']) {
      invariant(item[field] && item[field] !== '—', `Пустое поле ${field} у ${item.id}`);
    }
    if (item.env !== 'не требуется') {
      invariant(/^(?:`[A-Z][A-Z0-9_]*(?:`, `?[A-Z][A-Z0-9_]*`?)*`?)$/.test(item.env), `Секрет у ${item.id} должен быть только именем env: ${item.env}`);
      invariant(!item.env.includes('='), `В ${item.id} найдено значение секрета`);
    }
  }
}

function walk(dir) {
  const result = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) result.push(...walk(full));
    else result.push(full);
  }
  return result;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function validateStage00(root = ROOT) {
  const map = read(root, 'docs/REQUIREMENTS_MAP.md');
  const inventory = read(root, 'docs/SOURCE_INVENTORY.md');
  const frRows = rows(map, 'FR-');
  invariant(frRows.length === 16, `Ожидалось 16 FR, найдено ${frRows.length}`);
  const ids = frRows.map((line) => cells(line)[0]);
  invariant(new Set(ids).size === 16, 'FR содержат дубли');
  for (let number = 1; number <= 16; number += 1) {
    const id = `FR-${String(number).padStart(2, '0')}`;
    invariant(ids.includes(id), `Отсутствует ${id}`);
  }
  invariant(rows(map, 'REQ-TYPE-').length === 4, 'Должно быть четыре типа пользовательского запроса');
  const suites = { FL: 8, DT: 12, CR: 12, SC: 7, VAL: 7, UX: 8, INT: 6, E: 6 };
  for (const [prefix, expected] of Object.entries(suites)) {
    const found = rows(map, `${prefix}-`).filter((line) => /^\| [A-Z]+-\d{2} \|/.test(line));
    invariant(found.length === expected, `Ожидалось ${expected} требований ${prefix}, найдено ${found.length}`);
    invariant(new Set(found.map((line) => cells(line)[0])).size === expected, `Требования ${prefix} содержат дубли`);
  }
  invariant(map.includes('бот является основным решением, mini app расширяет его, а не заменяет'), 'Не зафиксировано правило bot-first');
  for (const line of [...frRows, ...rows(map, 'REQ-TYPE-')]) {
    const values = cells(line);
    invariant(values.length === 9 && values.every(Boolean), `Пустая ячейка карты: ${line}`);
  }
  const sourceIds = [...map.matchAll(/`(SRC-[A-Z0-9-]+)`/g)].map((match) => match[1]);
  for (const id of new Set(sourceIds)) invariant(inventory.includes(`| ${id} |`), `Источник ${id} не описан в инвентаре`);
  const requiredSources = [
    '/Users/inkoromi21/Downloads/Obrazovatelnye_reshenia_1.pdf',
    '/Users/inkoromi21/Downloads/Dopolnenie_k_TZ_MAX_po_kriteriam_khakatona.docx',
    '/Users/inkoromi21/Downloads/TZ_MAX_komplekt_4_0/Контракты и примеры/schemas.json',
    resolve(root, 'legacy/vibework_reference/README.md'),
    resolve(root, 'legacy/vibework_reference/SOURCE_MANIFEST.md'),
  ];
  for (const path of requiredSources) invariant(existsSync(path), `Источник не существует: ${path}`);
  return { fr: 16, requestTypes: 4, sourceIds: new Set(sourceIds).size };
}

export function validateStage01(root = ROOT) {
  const reuse = read(root, 'docs/VIBEWORK_REUSE.md');
  for (const word of ['take', 'adapt', 'leave', 'GapBar', 'owner_user_id', 'website/data']) invariant(reuse.includes(word), `VIBEWORK_REUSE не содержит ${word}`);
  invariant(/Python[^\n]{0,100}не (?:является|входит)/i.test(reuse), 'Не зафиксирован запрет Python runtime');
  const base = resolve(root, 'legacy/vibework_reference');
  const manifestPath = resolve(base, 'SHA256SUMS');
  const lines = readFileSync(manifestPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const manifest = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    invariant(match, `Некорректная строка SHA256SUMS: ${line}`);
    invariant(!manifest.has(match[2]), `Дублирующий путь в SHA256SUMS: ${match[2]}`);
    manifest.set(match[2], match[1]);
  }
  const actual = walk(base).filter((path) => path !== manifestPath).map((path) => relative(base, path).split(sep).join('/')).sort();
  invariant(actual.length === manifest.size, `Manifest=${manifest.size}, фактически=${actual.length}`);
  for (const path of actual) {
    invariant(manifest.has(path), `Лишний файл в выборке: ${path}`);
    invariant(!FORBIDDEN_NAMES.some((pattern) => pattern.test(path)), `Запрещённый путь: ${path}`);
    invariant(sha256(resolve(base, path)) === manifest.get(path), `Не совпала сумма: ${path}`);
  }
  return { files: actual.length };
}

export function validateStage02(root = ROOT) {
  const text = read(root, 'docs/MISSING_INPUTS.md');
  for (const section of ['MAX', 'Yandex Cloud', 'S3', 'ClamAV', 'домен и TLS', 'контент', 'эксперт', 'юридические тексты', 'оператор', 'аналитика', 'submission']) {
    invariant(text.includes(`## ${section}`), `Отсутствует раздел ${section}`);
  }
  const items = parseMissingRows(text);
  validateMissingRows(items);
  invariant(!/https?:\/\//i.test(text), 'В MISSING_INPUTS найден придуманный или фактический URL');
  for (const category of ['MAX', 'Yandex Cloud', 'S3', 'ClamAV', 'домен и TLS', 'аналитика']) {
    const related = items.filter((item) => item.category === category);
    invariant(related.length > 0, `Нет записей внешнего сервиса ${category}`);
    invariant(related.every((item) => /(mock|fake|local|локаль|disabled|отключ|quarantine|feature flag)/i.test(item.fallback)), `Не у всех записей ${category} безопасный локальный fallback`);
  }
  return { missingInputs: items.length };
}

export function validateAll(root = ROOT) {
  const stage00 = validateStage00(root);
  const stage01 = validateStage01(root);
  const stage02 = validateStage02(root);
  const inventory = read(root, 'docs/SOURCE_INVENTORY.md');
  invariant(inventory.includes('docs/VIBEWORK_REUSE.md'), 'SOURCE_INVENTORY не связан с VIBEWORK_REUSE');
  invariant(inventory.includes('legacy/vibework_reference/SHA256SUMS'), 'SOURCE_INVENTORY не связан с checksum manifest');
  return { stage00, stage01, stage02 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = process.argv[2] ?? 'all';
  const result = stage === '00' ? validateStage00() : stage === '01' ? validateStage01() : stage === '02' ? validateStage02() : validateAll();
  console.log(JSON.stringify({ ok: true, stage, ...result }));
}
