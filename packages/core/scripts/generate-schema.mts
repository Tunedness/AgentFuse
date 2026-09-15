/**
 * Emits `schemas/fusepolicy.v1.schema.json` from the Zod schema.
 *
 * Zod is the single source of truth; this file is a projection of it. Running
 * with `--check` regenerates into memory and compares against the committed
 * file, so a changed schema that was not regenerated fails CI instead of
 * shipping a JSON Schema that lies to people's editors.
 *
 * The schema is emitted for the **input** side of the document: that is the
 * shape a human writes, with `30m` still a string and every defaulted field
 * still optional.
 *
 * Lives outside `src/` and imports from `dist/`, so it is not part of the
 * package's purity surface — it is a build tool and may touch the file system.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const distEntry = join(packageRoot, 'dist/policy/schema.js');
const target = join(packageRoot, 'schemas/fusepolicy.v1.schema.json');

if (!existsSync(distEntry)) {
  console.error(`missing ${distEntry}\nRun \`npm run build\` before generating the schema.`);
  process.exit(1);
}

const { FusePolicySchemaV1 } = (await import(distEntry)) as {
  FusePolicySchemaV1: z.ZodType;
};

const SCHEMA_ID = 'https://schemas.tunedness.com/agentfuse/fusepolicy.v1.schema.json';

const generated = z.toJSONSchema(FusePolicySchemaV1, { io: 'input' }) as Record<string, unknown>;
const { $schema, ...rest } = generated;
const document = { $schema, $id: SCHEMA_ID, ...rest };
const json = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (existing !== json) {
    console.error(
      `schema drift: ${target} is out of date.\nRun \`npm run schema:generate\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`schema up to date: ${target}`);
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, json, 'utf8');
  console.log(`wrote ${target}`);
}
