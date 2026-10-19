/**
 * Wave B write operations from the local CLI (spec 6.1, 6.2, 6.5):
 * `gbrain put <slug> --file` reads the page from a file (no stdin), and over
 * one request uploads it in parts; `gbrain append` adds text with
 * append_page, idempotent by --request-id, through an upload session when the
 * text is over one request. Runs the real CLI on PGLite and on Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
/** Quotes, backslashes, tabs and other control characters, multi-byte and astral text. */
const ESCAPE_HEAVY = 'said "hi" \\ path\\to\\x \t tab \u0007 bell é 中文 😀 🧠';

for (const backend of testBackends()) {
  describe(`CLI page writes (${backend})`, () => {
    let home: string;
    let close: (() => Promise<void>) | undefined;

    async function cli(args: string[], stdin?: string) {
      const child = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
        cwd: home, stdout: 'pipe', stderr: 'pipe', stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
        env: { PATH: process.env.PATH, HOME: home, GBRAIN_HOME: home, GBRAIN_DISABLE_UPDATE_CHECK: '1', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' },
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    }
    async function page(slug: string): Promise<{ compiled_truth: string; knowledge_revision: string }> {
      const read = await cli(['get', slug, '--json']);
      expect(read.code, read.stderr).toBe(0);
      return JSON.parse(read.stdout);
    }
    const file = (name: string, content: string | Buffer) => { const path = join(home, name); writeFileSync(path, content); return path; };

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), `gbrain-cli-page-writes-${backend}-`));
      if (backend === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        close = pg.close;
        const [database] = await pg.engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
        const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database.name}`;
        await pg.engine.disconnect();
        mkdirSync(join(home, '.gbrain'), { recursive: true });
        writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: url.toString(), embedding_disabled: true }));
      } else {
        const init = await cli(['init', '--pglite', '--no-embedding']);
        expect(init.code, init.stderr).toBe(0);
      }
    }, 180_000);
    afterAll(async () => {
      await close?.();
      rmSync(home, { recursive: true, force: true });
    });

    test('put --file reads the page from the file, escape-heavy text intact, without stdin', async () => {
      const body = `# File page\n\n${ESCAPE_HEAVY}\nsecond line`;
      const put = await cli(['put', 'notes/from-file', '--file', file('from-file.md', body + '\n')]);
      expect(put.code, put.stderr).toBe(0);
      expect((await page('notes/from-file')).compiled_truth).toBe(body);
    }, 120_000);

    test('put --file=PATH replaces with --expected-revision; a missing file writes nothing', async () => {
      await cli(['put', 'notes/replaced', '--file', file('v1.md', '# V1\n\nfirst version\n')]);
      const { knowledge_revision } = await page('notes/replaced');
      const put = await cli(['put', 'notes/replaced', `--file=${file('v2.md', '# V2\n\nsecond version\n')}`, '--expected-revision', knowledge_revision]);
      expect(put.code, put.stderr).toBe(0);
      expect((await page('notes/replaced')).compiled_truth).toBe('# V2\n\nsecond version');
      const missing = await cli(['put', 'notes/missing', '--file', join(home, 'nope.md')]);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain('invalid_params');
      expect((await cli(['get', 'notes/missing', '--json'])).code).not.toBe(0);
    }, 120_000);

    test('put --file refuses binary input before any write', async () => {
      const denied = await cli(['put', 'notes/binary', '--file', file('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]))]);
      expect(denied.code).toBe(2);
      expect(denied.stderr).toContain('binary (PNG)');
    }, 60_000);

    test('append adds text from a file and from stdin in order; a replayed --request-id appends once', async () => {
      await cli(['put', 'notes/log', '--file', file('log.md', '# Log\n\n- first message\n')]);
      const fromFile = await cli(['append', 'notes/log', '--file', file('next.md', `- second ${ESCAPE_HEAVY}\n`), '--json']);
      expect(fromFile.code, fromFile.stderr).toBe(0);
      expect(JSON.parse(fromFile.stdout)).toMatchObject({ slug: 'notes/log' });
      const requestId = crypto.randomUUID();
      for (let i = 0; i < 2; i++) {
        const fromStdin = await cli(['append', 'notes/log', '--request-id', requestId], '- third message\n');
        expect(fromStdin.code, fromStdin.stderr).toBe(0);
      }
      const body = (await page('notes/log')).compiled_truth;
      expect(body).toBe(`# Log\n\n- first message\n- second ${ESCAPE_HEAVY}\n- third message`);
    }, 120_000);

    test('append with no text, or an invalid --region, is a usage error', async () => {
      const empty = await cli(['append', 'notes/log']);
      expect(empty.code).toBe(2);
      const region = await cli(['append', 'notes/log', '--region', 'middle'], 'x\n');
      expect(region.code).toBe(2);
      expect(region.stderr).toContain('--region must be one of: auto, truth, timeline');
    }, 60_000);

    test('append over one request goes through an upload session and lands whole', async () => {
      await cli(['put', 'notes/big-append', '--file', file('big-append.md', '# Big append\n\nstart\n')]);
      const line = `- ${ESCAPE_HEAVY} message\n`;
      const text = line.repeat(Math.ceil((1.5 * 1024 * 1024) / Buffer.byteLength(line)));
      const appended = await cli(['append', 'notes/big-append', '--file', file('big-append-text.md', text), '--json']);
      expect(appended.code, appended.stderr).toBe(0);
      expect((await page('notes/big-append')).compiled_truth).toBe(`# Big append\n\nstart\n${text}`.trimEnd());
    }, 300_000);

    test('put --file over the page ceiling streams through an upload session', async () => {
      const line = `- ${ESCAPE_HEAVY} row\n`;
      const body = '# Huge\n\n' + line.repeat(Math.ceil((25 * 1024 * 1024) / Buffer.byteLength(line)));
      const path = file('huge.md', body);
      const put = await cli(['put', 'notes/huge', '--file', path]);
      expect(put.code, put.stderr).toBe(0);
      const read = await cli(['get', 'notes/huge']);
      expect(read.code, read.stderr).toBe(0);
      expect(createHash('sha256').update(read.stdout).digest('hex')).toBe(createHash('sha256').update(body).digest('hex'));
    }, 600_000);
  });
}
