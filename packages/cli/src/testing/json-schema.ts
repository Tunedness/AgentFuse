/**
 * A validator for the subset of JSON Schema the published FusePolicy schema
 * uses. Test scaffolding, not product code.
 *
 * `init.test.ts` has to check its output against the **published**
 * `schemas/fusepolicy.v1.schema.json`, not against the Zod schema it was
 * generated from. Those two can disagree — `z.toJSONSchema` is a projection,
 * and a starter file an editor would underline in red while the runtime
 * accepted it is exactly the bug worth catching. Validating against the Zod
 * schema would prove nothing about the file people's editors read.
 *
 * Doing that needs a JSON Schema validator, and the phase brief forbids new
 * dependencies (rightly: `ajv` for one test is not a trade worth making). The
 * schema uses fourteen keywords, all of them structural, so the validator is
 * forty lines — and `init.test.ts` proves the validator itself rejects known
 * violations before trusting it to accept the starter file. A validator that
 * silently passes everything would be worse than no test at all.
 *
 * Lives in `src/testing/`, which the package build and the coverage report
 * both exclude — the same exemption `@agentfuse/proxy` gives its scenario
 * harnesses, and for the same reason: this is scaffolding that happens not to
 * end in `.test.ts`, and publishing it would turn it into a public contract.
 */

/** One problem, as `path: message`. */
export type SchemaProblem = string;

interface Schema {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  required?: string[];
  items?: Schema;
  pattern?: string;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Whether a value satisfies a `type` keyword. `integer` also satisfies `number`. */
function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

/**
 * Validates `value` against `schema`.
 *
 * @returns every problem found, deepest path first within each object.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: Schema,
  path = '<root>',
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      return [`${path}: expected ${types.join(' or ')}, got ${typeOf(value)}`];
    }
  }

  if ('const' in schema && value !== schema.const) {
    problems.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${path}: expected one of ${schema.enum.map((x) => String(x)).join(', ')}`);
  }

  if (schema.anyOf !== undefined) {
    const branches = schema.anyOf.map((branch) => validateAgainstSchema(value, branch, path));
    if (branches.every((found) => found.length > 0)) {
      problems.push(`${path}: matched none of the ${branches.length} allowed forms`);
    }
  }

  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      problems.push(`${path}: does not match ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${path}: shorter than ${schema.minLength}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${path}: below the minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${path}: above the maximum ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      problems.push(`${path}: not above ${schema.exclusiveMinimum}`);
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    for (const [index, item] of value.entries()) {
      problems.push(...validateAgainstSchema(item, schema.items, `${path}[${index}]`));
    }
  }

  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in object)) problems.push(`${path}: missing required key ${key}`);
    }
    for (const [key, item] of Object.entries(object)) {
      const child = schema.properties?.[key];
      if (child !== undefined) {
        problems.push(...validateAgainstSchema(item, child, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}: unexpected key ${key}`);
      } else if (typeof schema.additionalProperties === 'object') {
        problems.push(
          ...validateAgainstSchema(item, schema.additionalProperties, `${path}.${key}`),
        );
      }
    }
  }

  return problems;
}
