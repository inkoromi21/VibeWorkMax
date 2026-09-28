import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMissingRows, validateMissingRows, validateStage00, validateStage01, validateStage02 } from '../../scripts/check-phase0.mjs';

test('positive: actual Prompt 00 artifacts are complete', () => {
  const result = validateStage00();
  assert.equal(result.fr, 16);
  assert.equal(result.requestTypes, 4);
});

test('positive: legacy selection matches its checksum manifest', () => {
  const result = validateStage01();
  assert.equal(result.files, 55);
});

test('positive: missing-input register is complete and uses safe fallbacks', () => {
  const result = validateStage02();
  assert.equal(result.missingInputs, 41);
});

test('boundary: deadline may be a named release gate instead of an invented date', () => {
  const text = '| MI-001 | MAX | token | команда MAX | ожидается | до интеграционного smoke | `MAX_BOT_TOKEN` | webhook disabled | mock transport | защищённый канал |';
  const items = parseMissingRows(text);
  assert.doesNotThrow(() => validateMissingRows(items));
});

test('error: duplicate IDs and secret values are rejected', () => {
  const duplicate = '| MI-001 | MAX | token | команда MAX | ожидается | до smoke | `MAX_BOT_TOKEN` | disabled | mock | vault |\n| MI-001 | MAX | secret | команда MAX | ожидается | до smoke | `MAX_SECRET=real` | disabled | mock | vault |';
  assert.throws(() => validateMissingRows(parseMissingRows(duplicate)), /Дублирующий ID|только именем env|значение секрета/);
});
