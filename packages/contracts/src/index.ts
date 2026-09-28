import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';

export * from './generated/contracts.js';

interface SchemaDocument {
  $id: string;
  $defs: Record<string, object>;
}
const schemaPath = fileURLToPath(new URL('../source/schemas.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as SchemaDocument;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as FormatsPlugin;
addFormats(ajv);
ajv.addSchema(schema);

export const contractNames = Object.freeze(Object.keys(schema.$defs));
const validators = new Map<string, ValidateFunction>();

export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[];
}

export function validateContract(name: string, value: unknown): ValidationResult {
  if (!(name in schema.$defs)) throw new Error(`Unknown contract: ${name}`);
  const cached = validators.get(name);
  const validator = cached ?? ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
  if (!cached) validators.set(name, validator);
  const valid = validator(value);
  return { valid, errors: validator.errors ? [...validator.errors] : [] };
}
