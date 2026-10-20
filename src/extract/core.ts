// The parts of extract() that do not depend on the platform: checking the schema, the prompt, the OCR text layout,
// the JSON repair and the check of the answer against the schema. The prompt form and the repair rules are the ones
// measured on CORD v2 receipts (prompt P1 + repair R1-R3; the receipt wording is in the README).

/** JSON Schema keywords extract() understands; others are passed to the model in the prompt and not checked. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  [keyword: string]: unknown;
}

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Problems with a schema (empty = usable): the top must be an object schema with properties. */
export function schemaProblems(schema: unknown): string[] {
  const out: string[] = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [`the schema must be a JSON Schema object such as { type: 'object', properties: { total: { type: 'string' } } }, got ${Array.isArray(schema) ? 'an array' : typeof schema}`];
  try {
    JSON.stringify(schema);
  } catch (e) {
    return [`the schema cannot be written as JSON (${(e as Error).message})`];
  }
  const s = schema as JsonSchema;
  if (s.type !== 'object') out.push(`the top level must have type 'object' (got ${JSON.stringify(s.type)})`);
  if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties) || !Object.keys(s.properties).length) out.push('the top level must list the fields in properties (an object with at least one field)');
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { out.push(`${path} must be a schema object`); return; }
    const n = node as JsonSchema;
    const types = n.type === undefined ? [] : Array.isArray(n.type) ? n.type : [n.type];
    for (const t of types) if (typeof t !== 'string' || !TYPES.has(t)) out.push(`${path}.type ${JSON.stringify(t)} is not a JSON Schema type (object, array, string, number, integer, boolean, null)`);
    if (n.properties !== undefined) {
      if (!n.properties || typeof n.properties !== 'object' || Array.isArray(n.properties)) out.push(`${path}.properties must be an object`);
      else for (const [k, v] of Object.entries(n.properties)) walk(v, `${path}.properties.${k}`);
    }
    if (n.required !== undefined && (!Array.isArray(n.required) || n.required.some((r) => typeof r !== 'string'))) out.push(`${path}.required must be an array of field names`);
    if (n.items !== undefined) walk(n.items, `${path}.items`);
    if (n.enum !== undefined && !Array.isArray(n.enum)) out.push(`${path}.enum must be an array`);
  };
  walk(s, 'schema');
  return out;
}

/** Where the answer does not follow the schema (empty = it does): types, required fields, enum values. */
export function answerProblems(value: unknown, schema: JsonSchema, path = 'answer'): string[] {
  const out: string[] = [];
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
  if (types.length) {
    const t = typeOf(value);
    const ok = types.some((x) => x === t || (x === 'number' && t === 'integer'));
    if (!ok) { out.push(`${path} is ${t}, the schema wants ${types.join(' or ')}`); return out; }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${path} is not one of ${JSON.stringify(schema.enum)}`);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!Object.hasOwn(o, r)) out.push(`${path}.${r} is required and missing`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(o, k) && o[k] !== null) out.push(...answerProblems(o[k], sub, `${path}.${k}`));
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => out.push(...answerProblems(v, schema.items!, `${path}[${i}]`)));
  return out;
}

/** OCR lines with boxes [x0, y0, x1, y1]. */
export interface BoxedLine {
  text: string;
  box: [number, number, number, number];
}

/**
 * The OCR text given to the model: lines grouped into rows by their vertical centre (same row when the centres are
 * closer than half the smaller height; rows top to bottom, left to right inside a row), one space inside a row, one
 * newline between rows.
 */
export function layoutText(lines: BoxedLine[]): string {
  const cy = (u: BoxedLine) => (u.box[1] + u.box[3]) / 2;
  const h = (u: BoxedLine) => u.box[3] - u.box[1];
  const sorted = lines.slice().sort((a, b) => cy(a) - cy(b) || a.box[0] - b.box[0]);
  const rows: BoxedLine[][] = [];
  for (const u of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy(u) - cy(row[0]!)) < 0.5 * Math.min(h(u), h(row[0]!))) row.push(u);
    else rows.push([u]);
  }
  const mean = (row: BoxedLine[]) => row.reduce((s, u) => s + cy(u), 0) / row.length;
  rows.sort((a, b) => mean(a) - mean(b));
  return rows.map((row) => row.sort((a, b) => a.box[0] - b.box[0]).map((u) => u.text).join(' ')).join('\n');
}

export const DEFAULT_INSTRUCTIONS = 'Copy every value exactly as printed. Leave out a field that is not on the document.';

export function buildPrompt(schema: JsonSchema, text: string, documentType = 'document', instructions = DEFAULT_INSTRUCTIONS): string {
  return `Extract the fields of this ${documentType} from its OCR text.\nReturn only a JSON object that follows this JSON Schema:\n${JSON.stringify(schema)}\n${instructions}\n\nOCR text:\n${text}`;
}

/**
 * The model's answer -> a JSON value. R0 = parse as is; else R1 = the inside of the first ``` fence (``` or ```json),
 * R2 = from the first '{' to the last '}', R3 = drop a ',' right before '}' or ']'. Nothing else is repaired.
 */
export function repairJson(text: string): { value: unknown; stage: 'R0' | 'R1-R3' | null } {
  try {
    return { value: JSON.parse(text), stage: 'R0' };
  } catch { /* repair below */ }
  let s = text;
  const fence = s.match(/```(?:json)?([\s\S]*?)```/);
  if (fence) s = fence[1]!;
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  s = a !== -1 && b > a ? s.slice(a, b + 1) : '';
  s = s.replace(/,\s*([}\]])/g, '$1');
  try {
    return { value: JSON.parse(s), stage: 'R1-R3' };
  } catch {
    return { value: null, stage: null };
  }
}
