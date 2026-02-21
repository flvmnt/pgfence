/**
 * AST Probe — Inspect libpg-query JSON output for all fixtures.
 * Run: npx tsx scripts/ast-probe.ts
 *
 * This MUST be run before writing any rule code to confirm exact field names.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// libpg-query uses CJS, load it properly
async function loadParser() {
  const mod = await import('libpg-query');
  // The export is `parse` (async) or `parseSync`
  const parseFn = mod.parse ?? mod.default?.parse;
  if (!parseFn) throw new Error('Cannot find parse function. Exports: ' + Object.keys(mod));
  return parseFn as (sql: string) => Promise<{ stmts: Array<{ stmt: Record<string, unknown>; stmt_location?: number; stmt_len?: number }> }>;
}

async function main() {
  const parseFn = await loadParser();
  const dir = path.join(process.cwd(), 'tests', 'fixtures');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));

  for (const f of files) {
    const sql = await readFile(path.join(dir, f), 'utf8');
    const res = await parseFn(sql);
    console.log('\n===', f, '===');
    for (const s of res.stmts ?? []) {
      const nodeType = Object.keys(s.stmt)[0];
      console.log('  nodeType:', nodeType);
      console.log('  stmt_location:', s.stmt_location, 'stmt_len:', s.stmt_len);
      const json = JSON.stringify(s.stmt[nodeType], null, 2);
      console.log('  ', json.slice(0, 3000));
      if (json.length > 3000) console.log('  ... (truncated)');
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
