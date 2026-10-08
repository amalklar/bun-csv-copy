import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { importCsv, safeErrorMessage, validateCsv } from './copy-live';
import { readConfig } from './config';

const HEADER = 'user_id,product_category_combination,credit_line_family\n';
const VALID = HEADER + 'user-1,"checking,credit",KLAR_FAMILY\nuser-2,"quoted ""text""\nsecond line",UBER_FAMILY\n';
const directory = await mkdtemp(join(tmpdir(), 'copy-live-test-'));
let nextFixture = 0;
async function fixture(contents: string) {
    const file = join(directory, `${nextFixture++}.csv`);
    await writeFile(file, contents);
    return file;
}
afterAll(() => rm(directory, { recursive: true, force: true }));

describe('CSV validation', () => {
    test('accepts quoting, escaped quotes, multiline fields, CRLF, and a BOM', async () => {
        const validated = await validateCsv(await fixture('\uFEFF' + VALID.replace(/\n/g, '\r\n')));
        expect(validated.rows).toBe(2);
        expect(validated.sha256).toHaveLength(64);
    });

    test.each([
        ['', 'expected header'],
        [HEADER, 'at least one data row'],
        ['credit_line_family,user_id,product_category_combination\nKLAR_FAMILY,user-1,a\n', 'header must be exactly'],
        [HEADER + 'user-1,a\n', 'exactly 3 fields'],
        [HEADER + 'user-1,a,KLAR_FAMILY,extra\n', 'exactly 3 fields'],
        [HEADER + 'user-1,"",KLAR_FAMILY\n', 'empty required field'],
        [HEADER + 'user-1,   ,KLAR_FAMILY\n', 'empty required field'],
        [HEADER + 'user-1,a,UNKNOWN\n', 'unsupported credit_line_family'],
        [HEADER + 'user-1,"unclosed,KLAR_FAMILY\n', 'CSV syntax'],
        [HEADER + '\n', 'exactly 3 fields'],
    ])('rejects invalid CSV (%#)', async (contents, message) => {
        await expect(validateCsv(await fixture(contents))).rejects.toThrow(message);
    });

    test('rejects an aborted validation', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(validateCsv(await fixture(VALID), { signal: controller.signal })).rejects.toThrow('interrupted');
    });

    test('does not disclose raw parser or database error content', () => {
        const secret = 'sensitive-user-record';
        expect(safeErrorMessage(new Error(secret))).not.toContain(secret);
        const message = safeErrorMessage({ code: '23505', message: secret, detail: secret });
        expect(message).toContain('23505');
        expect(message).not.toContain(secret);
    });

    test('requires a PostgreSQL DSN', async () => {
        await expect(importCsv({ dsn: '', log: () => {} })).rejects.toThrow('DB_URL or DSN_LIVE must be set');
        await expect(importCsv({ dsn: 'https://example.com', log: () => {} })).rejects.toThrow('PostgreSQL connection URL');
        await expect(importCsv({ dsn: 'postgresql://localhost/user_account_database', log: () => {} }))
            .rejects.toThrow('must include the username, password, and database');
    });

    test('generic validation accepts other headers, nullable fields, and semicolon delimiters', async () => {
        const result = await validateCsv(await fixture('id;note\n1;\n2;"a;b"\n'), {
            profile: 'generic', columns: ['id', 'note'], delimiter: ';',
        });
        expect(result.rows).toBe(2);
    });
});

// Integration tests accept only an explicitly supplied local test connection.
// They never read DSN_LIVE, and refuse to take ownership of an existing table.
const testDsn = process.env.COPY_TEST_DSN;
const integration = testDsn ? describe : describe.skip;
integration('PostgreSQL COPY integration', () => {
    let client: Client;
    let ownsTable = false;
    const messages: string[] = [];
    const log = (message: string) => messages.push(message);
    const schema = `CREATE TABLE public.account_family_backfill_tasks (
        user_id TEXT PRIMARY KEY,
        product_category_combination TEXT NOT NULL,
        credit_line_family TEXT NOT NULL,
        processed BOOLEAN NOT NULL DEFAULT false,
        processed_at TIMESTAMPTZ
    );
    CREATE INDEX idx_account_family_backfill_unprocessed
        ON public.account_family_backfill_tasks (user_id) WHERE processed = false;`;

    beforeAll(async () => {
        const url = new URL(testDsn!);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
            || url.pathname !== '/user_account_database') {
            throw new Error('COPY_TEST_DSN must target an isolated local user_account_database.');
        }
        client = new Client({ connectionString: testDsn });
        await client.connect();
        const existing = await client.query("SELECT to_regclass('public.account_family_backfill_tasks') AS existing");
        if (existing.rows[0].existing) throw new Error('Integration tests require an absent target table.');
        await client.query(schema);
        ownsTable = true;
    });
    beforeEach(async () => {
        if (!ownsTable) throw new Error('Test table ownership was not established.');
        await client.query('DROP TABLE public.account_family_backfill_tasks');
        await client.query(schema);
        messages.length = 0;
    });
    afterAll(async () => {
        if (ownsTable) await client.query('DROP TABLE public.account_family_backfill_tasks');
        await client?.end();
    });
    const count = async () => Number((await client.query('SELECT count(*) FROM public.account_family_backfill_tasks')).rows[0].count);
    const run = async (contents: string, extra: { signal?: AbortSignal; log?: (message: string) => void } = {}) => {
        return importCsv({ dsn: testDsn!, csvPath: await fixture(contents), log, ...extra });
    };

    test('maps CSV columns, preserves existing rows, and uses processing defaults', async () => {
        await client.query(`INSERT INTO public.account_family_backfill_tasks
            VALUES ('existing', 'original', 'KLAR_FAMILY', true, CURRENT_TIMESTAMP)`);
        expect(await run(VALID)).toBe(2);
        const result = await client.query('SELECT * FROM public.account_family_backfill_tasks ORDER BY user_id');
        expect(result.rows).toHaveLength(3);
        expect(result.rows[0].processed).toBe(true);
        expect(result.rows[0].product_category_combination).toBe('original');
        expect(result.rows[1]).toEqual({
            user_id: 'user-1', product_category_combination: 'checking,credit',
            credit_line_family: 'KLAR_FAMILY', processed: false, processed_at: null,
        });
        expect(result.rows[2].product_category_combination).toBe('quoted "text"\nsecond line');
        expect(result.rows[2].credit_line_family).toBe('UBER_FAMILY');
        expect(messages.some((message) => message.startsWith('Committed 2 rows'))).toBe(true);
    });

    test('rolls back duplicate IDs in the CSV', async () => {
        await expect(run(HEADER + 'same,a,KLAR_FAMILY\nsame,b,UBER_FAMILY\n')).rejects.toMatchObject({ code: '23505' });
        expect(await count()).toBe(0);
        expect(messages).toContain('Rolled back.');
    });

    test('package command uses DSN_LIVE and hides database error details', async () => {
        const csvPath = await fixture(VALID);
        const invoke = async () => {
            const child = Bun.spawn(['bun', 'run', 'copy:live', csvPath], {
                cwd: import.meta.dir,
                env: { ...process.env, DB_URL: '', DSN_LIVE: testDsn!, IMPORT_PROFILE: 'uas', CSV_PATH: csvPath, DB_NAME: 'user_account_database', DB_SCHEMA: 'public', DB_TABLE: 'account_family_backfill_tasks', CSV_COLUMNS: 'user_id,product_category_combination,credit_line_family', CSV_DELIMITER: ',', DB_SSL_ROOT_CERT: '', DATABASE_URL: 'invalid-unused-connection' },
                stdout: 'pipe', stderr: 'pipe',
            });
            const [stdout, stderr, exitCode] = await Promise.all([
                new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
            ]);
            expect(stdout + stderr).not.toContain(testDsn!);
            return { stdout, stderr, exitCode };
        };
        const success = await invoke();
        expect(success.exitCode).toBe(0);
        expect(success.stdout).toContain('Committed 2 rows');
        const conflict = await invoke();
        expect(conflict.exitCode).toBe(1);
        expect(conflict.stderr).toContain('database code 23505');
        expect(conflict.stderr).not.toContain('user-1');
        expect(await count()).toBe(2);
    });

    test('rolls back earlier rows when an existing user conflicts', async () => {
        await client.query(`INSERT INTO public.account_family_backfill_tasks
            VALUES ('user-2', 'keep', 'KLAR_FAMILY', true, CURRENT_TIMESTAMP)`);
        await expect(run(VALID)).rejects.toMatchObject({ code: '23505' });
        expect(await count()).toBe(1);
        expect((await client.query('SELECT product_category_combination, processed FROM public.account_family_backfill_tasks')).rows)
            .toEqual([{ product_category_combination: 'keep', processed: true }]);
    });

    test.each([
        [HEADER + 'user-1,a,UNKNOWN\n'],
        [HEADER + 'user-1,"unclosed,KLAR_FAMILY\n'],
        [HEADER + 'user-1,,KLAR_FAMILY\n'],
    ])('invalid input leaves no rows (%#)', async (contents) => {
        await expect(run(contents)).rejects.toThrow();
        expect(await count()).toBe(0);
        expect(messages.some((message) => message.includes('Starting COPY'))).toBe(false);
    });

    test.each([
        ['ALTER TABLE public.account_family_backfill_tasks ALTER COLUMN processed SET DEFAULT true'],
        ['ALTER TABLE public.account_family_backfill_tasks ALTER COLUMN processed_at SET DEFAULT CURRENT_TIMESTAMP'],
        ['ALTER TABLE public.account_family_backfill_tasks DROP CONSTRAINT account_family_backfill_tasks_pkey'],
        ['ALTER TABLE public.account_family_backfill_tasks ALTER COLUMN credit_line_family DROP NOT NULL'],
    ])('refuses an incompatible deployed table (%#)', async (change) => {
        await client.query(change);
        await expect(run(VALID)).rejects.toThrow();
        expect(await count()).toBe(0);
        expect(messages).toContain('Rolled back.');
    });

    test('refuses the wrong database', async () => {
        const url = new URL(testDsn!);
        url.pathname = '/postgres';
        await expect(importCsv({ dsn: url.toString(), csvPath: await fixture(VALID), log })).rejects.toThrow('Connection must target');
        expect(await count()).toBe(0);
    });

    test('generic profile supports a custom database, mixed-case schema, typed columns, and NULLs', async () => {
        const url = new URL(testDsn!);
        url.pathname = '/postgres';
        const genericClient = new Client({ connectionString: url.toString() });
        const schemaName = `CopyTest_${process.pid}`;
        let created = false;
        try {
            await genericClient.connect();
            await genericClient.query(`CREATE SCHEMA "${schemaName}"`);
            created = true;
            await genericClient.query(`CREATE TABLE "${schemaName}"."Payments" (
                "ExternalID" INTEGER PRIMARY KEY,
                amount NUMERIC NOT NULL CHECK (amount > 0),
                note TEXT,
                created_at DATE NOT NULL DEFAULT CURRENT_DATE,
                doubled NUMERIC GENERATED ALWAYS AS (amount * 2) STORED
            )`);
            const config = readConfig({ DB_URL: url.toString(), IMPORT_PROFILE: 'generic',
                CSV_PATH: await fixture('ExternalID;amount;note\n1;12.50;\n2;9.99;""\n3;5;"a;b"\n'),
                DB_SCHEMA: schemaName, DB_TABLE: 'Payments', CSV_COLUMNS: 'ExternalID,amount,note', CSV_DELIMITER: ';' });
            expect(config.database).toBe('postgres');
            expect(await importCsv({ ...config, log })).toBe(3);
            const rows = (await genericClient.query(`SELECT * FROM "${schemaName}"."Payments" ORDER BY "ExternalID"`)).rows;
            expect(rows[0].amount).toBe('12.50');
            expect(rows[0].note).toBeNull();
            expect(rows[1].note).toBe('');
            expect(rows[2].note).toBe('a;b');
            expect(rows[0].doubled).toBe('25.00');
            expect(rows[0].created_at).not.toBeNull();
            const invalid = await fixture('ExternalID;amount;note\n4;10;ok\n5;-2;invalid\n');
            await expect(importCsv({ ...config, csvPath: invalid, log })).rejects.toMatchObject({ code: '23514' });
            expect(Number((await genericClient.query(`SELECT COUNT(*) FROM "${schemaName}"."Payments"`)).rows[0].count)).toBe(3);
        } finally {
            if (created) await genericClient.query(`DROP SCHEMA "${schemaName}" CASCADE`);
            await genericClient.end();
        }
    });

    test('generic profile accepts omitted identity columns and refuses omitted required input', async () => {
        const schemaName = `copy_generic_${process.pid}`;
        let created = false;
        try {
            await client.query(`CREATE SCHEMA ${schemaName}`);
            created = true;
            await client.query(`CREATE TABLE ${schemaName}.items (
                id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note TEXT NOT NULL
            )`);
            const options = { dsn: testDsn!, profile: 'generic' as const, schema: schemaName,
                table: 'items', columns: ['note'], csvPath: await fixture('note\nhello\n'), log };
            expect(await importCsv(options)).toBe(1);
            expect((await client.query(`SELECT id FROM ${schemaName}.items`)).rows[0].id).toBe(1);
            await client.query(`ALTER TABLE ${schemaName}.items ADD COLUMN required TEXT NOT NULL DEFAULT 'x'`);
            await client.query(`ALTER TABLE ${schemaName}.items ALTER COLUMN required DROP DEFAULT`);
            await expect(importCsv(options)).rejects.toThrow('omitted required column');
            expect(Number((await client.query(`SELECT COUNT(*) FROM ${schemaName}.items`)).rows[0].count)).toBe(1);
        } finally {
            if (created) await client.query(`DROP SCHEMA ${schemaName} CASCADE`);
        }
    });

    test('rolls back if the validated file changes before COPY', async () => {
        const csvPath = await fixture(VALID);
        await expect(importCsv({
            dsn: testDsn!, csvPath,
            log(message) {
                if (message.includes('Starting COPY')) {
                    // Synchronous replacement occurs before the second file stream is opened.
                    writeFileSync(csvPath, HEADER + 'changed,a,KLAR_FAMILY\n');
                }
                log(message);
            },
        })).rejects.toThrow('CSV changed after validation');
        expect(await count()).toBe(0);
    });

    test('rolls back a source stream failure after validation', async () => {
        const csvPath = await fixture(VALID);
        await expect(importCsv({
            dsn: testDsn!, csvPath,
            log(message) {
                if (message.includes('Starting COPY')) unlinkSync(csvPath);
                log(message);
            },
        })).rejects.toThrow();
        expect(await count()).toBe(0);
        expect(messages).toContain('Rolled back.');
    });

    test('rolls back an interrupted COPY stream', async () => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const contents = HEADER + Array.from({ length: 100_000 }, (_, i) => `user-${i},a,KLAR_FAMILY\n`).join('');
        try {
            await expect(run(contents, {
                signal: controller.signal,
                log(message) {
                    if (message.includes('Starting COPY')) timer = setTimeout(() => controller.abort(), 10);
                    log(message);
                },
            })).rejects.toThrow('interrupted before commit');
        } finally {
            clearTimeout(timer);
        }
        expect(await count()).toBe(0);
        expect(messages).toContain('Rolled back.');
    });
});
