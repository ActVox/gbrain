import { test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { refreshUnindexedFiles, unindexedScanBudgetMs } from '../src/core/persistence/unindexed-files.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
const N = Number(process.env.N ?? 300000), MISSING = Number(process.env.MISSING ?? 3000);
test('scale probe', async () => {
  const home = mkdtempSync(join(tmpdir(), 'probe-'));
  await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
    let engine: any;
    if (process.env.DATABASE_URL) engine = (await isolatedPersistencePostgres(process.env.DATABASE_URL)).engine; else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    const root = join(home, 'repo'); mkdirSync(root);
    execSync('git init -q ' + root + ' && cd ' + root + ' && python3 ' + process.env.HOME + '/.capy/work/big/gen.py ' + N + ' | git fast-import --quiet && git checkout -q -f master', { stdio: 'inherit', shell: '/bin/bash' });
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config,last_commit) VALUES('big','big',$1,'{}',$2)", [root, head]);
    let t = Date.now();
    for (let lo = 0; lo < N; lo += 10000) await engine.executeRaw("SET LOCAL statement_timeout = 0; INSERT INTO pages (source_id, slug, type, title, compiled_truth, source_path) SELECT 'big', 'd'||lpad((i%300)::text,3,'0')||'/f'||i, 'note', 'n'||i, 'x', 'd'||lpad((i%300)::text,3,'0')||'/f'||i||'.md' FROM generate_series($3::int, LEAST($1::int, $3::int + 10000) - 1) i WHERE i % (($1::int) / $2::int) <> 7".replace('SET LOCAL statement_timeout = 0; ', ''), [N, MISSING, lo]);
    console.log('pages inserted', Date.now() - t, 'ms', (await engine.executeRaw("SELECT count(*)::int n FROM pages WHERE source_id='big'"))[0].n);
    await claimWorktree(engine, 'big', root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const budget = await unindexedScanBudgetMs(engine, 'big');
    console.log('budget', budget);
    const passBudget = Number(process.env.PASS_MS ?? budget);
    let passes = 0, record: any;
    do {
      t = Date.now();
      const r = await refreshUnindexedFiles(engine, 'big', { deadlineAt: Date.now() + passBudget });
      record = r.record; passes++;
      console.log('pass', passes, 'ms', Date.now() - t, 'scan', r.scan.scanned, 'total', record.scanned, 'complete', record.complete, 'unindexed', record.unindexed);
      if (process.env.COMMITS) {
        writeFileSync(join(root, 'zz-new-' + passes + '.md'), '---\ntitle: n\n---\nx\n');
        execSync('cd ' + root + ' && git add -A && git -c user.name=E -c user.email=e@e.invalid commit -qm n', { shell: '/bin/bash' });
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw("UPDATE sources SET last_commit=$1 WHERE id='big'", [execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()]);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
    } while (!record.complete && passes < Number(process.env.MAX ?? 8));
  });
}, 3_600_000);
