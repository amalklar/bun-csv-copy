import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'fast-csv';
import { Client } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { quoteIdentifier, readConfig, resolveConfig, UAS_COLUMNS } from './config';
import type { ImportConfig, ImportInput } from './config';
import { debugTrace, describeError, errorCode, ImportError, safeErrorMessage } from './errors';

const FAMILIES = new Set(['KLAR_FAMILY', 'UBER_FAMILY']);
const FILE_ERRORS = new Set(['ENOENT', 'EACCES', 'EISDIR']);
type Logger = (message: string) => void;
export { ImportError, safeErrorMessage } from './errors';

class FileDigest extends Transform {
    private readonly hash = createHash('sha256');
    bytes = 0;

    constructor(private readonly progress?: (bytes: number) => void) {
        super();
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        this.hash.update(chunk);
        this.bytes += chunk.length;
        this.progress?.(this.bytes);
        this.push(chunk);
        callback();
    }

    digest() {
        return this.hash.digest('hex');
    }
}

const mebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export async function validateCsv(csvPath: string, { signal, log = () => {}, columns = UAS_COLUMNS,
    profile = 'uas', delimiter = ',' }: {
    signal?: AbortSignal; log?: Logger; columns?: string[];
    profile?: ImportConfig['profile']; delimiter?: string;
} = {}) {
    let rows = 0;
    let lastProgress = Date.now();
    const digest = new FileDigest();
    const parser = parse({
        headers: (headers) => {
            if (headers.length !== columns.length || headers.some((header, i) => header !== columns[i])) {
                throw new ImportError(`CSV header must be exactly: ${columns.join(delimiter)}`);
            }
            return headers;
        },
        strictColumnHandling: true,
        ignoreEmpty: false,
        delimiter,
    });
    parser.on('data-invalid', () => {
        parser.destroy(new ImportError(`CSV data row ${rows + 1} must have exactly ${columns.length} fields.`));
    });
    const validator = new Writable({
        objectMode: true,
        write(row: Record<string, string>, _encoding, callback) {
            if (profile === 'uas' && columns.some((column) => !row[column]?.trim())) {
                callback(new ImportError(`CSV data row ${rows + 1} has an empty required field.`));
            } else if (profile === 'uas' && !FAMILIES.has(row.credit_line_family)) {
                callback(new ImportError(`CSV data row ${rows + 1} has an unsupported credit_line_family.`));
            } else {
                rows++;
                const now = Date.now();
                if (now - lastProgress >= 5_000) {
                    log(`Validated ${rows.toLocaleString('en-US')} rows...`);
                    lastProgress = now;
                }
                callback();
            }
        },
    });
    try {
        await pipeline(createReadStream(csvPath), digest, parser, validator, { signal });
    } catch (error) {
        if (error instanceof ImportError) throw error;
        if (signal?.aborted) throw new ImportError('CSV validation was interrupted.');
        const code = errorCode(error);
        if (FILE_ERRORS.has(code)) {
            throw new ImportError(`Cannot read the CSV file at ${csvPath}. ${describeError(error)}`, code, { cause: error });
        }
        throw new ImportError(`CSV syntax error near data row ${rows + 1}, such as an unclosed quote.`,
            code || undefined, { cause: error });
    }
    if (rows === 0) throw new ImportError('CSV must contain the expected header and at least one data row.');
    return { rows, bytes: digest.bytes, sha256: digest.digest() };
}

async function verifyTarget(client: Client, config: ImportConfig, target: string) {
    const database = await client.query<{ database: string }>('SELECT current_database() AS database');
    const connected = database.rows[0].database;
    if (connected !== config.database) {
        throw new ImportError(`Connection must target ${config.database}, but it reached ${connected}. `
            + 'Fix DB_NAME or the database in the connection URL.');
    }
    // Hold the same lock COPY needs, preventing table changes during verification and import.
    await client.query(`LOCK TABLE ${target} IN ROW EXCLUSIVE MODE`);
    const columns = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
        is_generated: string;
        is_identity: string;
    }>(`
        SELECT column_name, data_type, is_nullable, column_default, is_generated, is_identity
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
    `, [config.schema, config.table]);
    for (const name of config.columns) {
        const column = columns.rows.find((candidate) => candidate.column_name === name);
        if (!column) throw new ImportError(`${target}.${name} must be a writable column, but it does not exist.`);
        if (column.is_generated !== 'NEVER') {
            throw new ImportError(`${target}.${name} must be a writable column, but it is generated.`);
        }
        if (config.profile === 'uas' && (column.data_type !== 'text' || column.is_nullable !== 'NO')) {
            throw new ImportError(`${target}.${name} must be a required TEXT column, but it is `
                + `${column.data_type}${column.is_nullable === 'YES' ? ' and allows NULL' : ''}.`);
        }
    }
    const missingDefaults = columns.rows.filter((column) => !config.columns.includes(column.column_name)
        && column.is_nullable === 'NO' && column.column_default === null
        && column.is_generated === 'NEVER' && column.is_identity !== 'YES');
    if (missingDefaults.length > 0) {
        throw new ImportError(`${target} has an omitted required column without a default: `
            + `${missingDefaults.map((column) => column.column_name).join(', ')}.`);
    }
    if (config.profile !== 'uas') return;
    const processed = columns.rows.find((column) => column.column_name === 'processed');
    const processedAt = columns.rows.find((column) => column.column_name === 'processed_at');
    if (!processed || processed.data_type !== 'boolean' || processed.is_nullable !== 'NO'
        || processed.column_default !== 'false' || processed.is_generated !== 'NEVER'
        || !processedAt || processedAt.data_type !== 'timestamp with time zone'
        || processedAt.is_nullable !== 'YES' || processedAt.column_default !== null
        || processedAt.is_generated !== 'NEVER') {
        throw new ImportError(`${target} must default processed to false and processed_at to NULL.`);
    }
    const primaryKey = await client.query<{ columns: string[] }>(`
        SELECT array_agg(a.attname::text ORDER BY key.ordinality) AS columns
        FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
        WHERE c.conrelid = to_regclass($1) AND c.contype = 'p'
        GROUP BY c.oid
    `, [target]);
    const keyColumns = primaryKey.rows[0]?.columns ?? [];
    if (keyColumns.length !== 1 || keyColumns[0] !== 'user_id') {
        throw new ImportError(`${target} must have a primary key on user_id alone, but it has `
            + `${keyColumns.length ? keyColumns.join(', ') : 'none'}.`);
    }
}

function connectionLabel(config: ImportConfig) {
    const url = new URL(config.dsn);
    const sslMode = url.searchParams.get('sslmode') ?? 'default';
    return `${url.hostname}:${url.port}${url.pathname} from ${config.dsnSource ?? 'the connection URL'} (sslmode ${sslMode})`;
}

export async function importCsv({ signal, log = console.log, ...input }: ImportInput & {
    signal?: AbortSignal;
    log?: Logger;
}) {
    const config = resolveConfig(input);
    const target = `${quoteIdentifier(config.schema)}.${quoteIdentifier(config.table)}`;
    const started = Date.now();
    log(`Checking CSV file ${config.csvPath}...`);
    const validated = await validateCsv(config.csvPath, { ...config, signal, log });
    log(`CSV OK: ${validated.rows.toLocaleString('en-US')} rows, ${mebibytes(validated.bytes)}.`);

    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    let client: Client | undefined;
    let connectionError: unknown;
    const onConnectionError = (error: unknown) => {
        connectionError ??= error;
        log(`Database connection error: ${describeError(error)}`);
        controller.abort();
    };
    let phase: 'none' | 'open' | 'committing' | 'committed' = 'none';
    let step = 'connecting to the database';
    try {
        controller.signal.throwIfAborted();
        log(`Connecting to ${connectionLabel(config)}...`);
        client = new Client({ connectionString: config.dsn, connectionTimeoutMillis: 10_000 });
        client.on('error', onConnectionError);
        await client.connect();
        step = 'starting the transaction';
        await client.query('BEGIN');
        phase = 'open';
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        step = `checking ${target}`;
        await verifyTarget(client, config, target);
        await client.query('SET LOCAL statement_timeout = 0');
        controller.signal.throwIfAborted();
        log(`Connected to ${config.database}. Starting COPY into ${target}...`);
        step = 'copying rows';
        let lastProgress = Date.now();
        const digest = new FileDigest((bytes) => {
            const now = Date.now();
            if (now - lastProgress >= 5_000) {
                log(`${mebibytes(bytes)} of ${mebibytes(validated.bytes)} uploaded (not committed).`);
                lastProgress = now;
            }
        });
        const copy = client.query(copyFrom(`
            COPY ${target} (${config.columns.map(quoteIdentifier).join(', ')})
            FROM STDIN WITH (FORMAT CSV, HEADER true, ENCODING 'UTF8', DELIMITER '${config.delimiter}')
        `));
        await pipeline(createReadStream(config.csvPath), digest, copy, { signal: controller.signal });
        if (digest.digest() !== validated.sha256 || digest.bytes !== validated.bytes) {
            throw new ImportError('CSV changed after validation. Rolling back.');
        }
        if (copy.rowCount !== validated.rows) {
            throw new ImportError(`COPY loaded ${copy.rowCount ?? 0} rows, but the CSV has ${validated.rows}. Rolling back.`);
        }
        controller.signal.throwIfAborted();
        step = 'committing';
        phase = 'committing';
        await client.query('COMMIT');
        phase = 'committed';
        log(`Committed ${copy.rowCount.toLocaleString('en-US')} rows in ${((Date.now() - started) / 1000).toFixed(1)} seconds.`);
        return copy.rowCount;
    } catch (error) {
        const failure = connectionError ?? error;
        if (phase === 'open' && client) {
            log('Rolling back...');
            try {
                await client.query('ROLLBACK');
                log('Rolled back.');
            } catch (rollbackError) {
                log(`Rollback did not confirm. ${describeError(rollbackError)} Check database state.`);
            }
        }
        if (phase === 'committing') {
            throw new ImportError(`Commit was not confirmed. ${describeError(failure)} Check database state before retrying.`,
                errorCode(failure) || undefined, { cause: failure });
        }
        if (signal?.aborted) throw new ImportError('Import was interrupted before commit. Nothing was committed.');
        if (error instanceof ImportError) throw error;
        throw new ImportError(`Import failed while ${step}. ${describeError(failure)} Nothing was committed.`,
            errorCode(failure) || undefined, { cause: failure });
    } finally {
        signal?.removeEventListener('abort', abort);
        try {
            await client?.end();
        } catch {
            // A broken connection may already be closed; preserve the import outcome.
        }
        client?.removeListener('error', onConnectionError);
    }
}

if (import.meta.main) {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try {
        const args = process.argv.slice(2);
        if (args.length > 1) throw new ImportError('Usage: bun run copy [csv-file]');
        await importCsv({ ...readConfig(process.env, args[0]), signal: controller.signal });
    } catch (error) {
        console.error(safeErrorMessage(error));
        if (process.env.DEBUG) console.error(debugTrace(error));
        else console.error('Set DEBUG=1 to print where the error happened.');
        process.exitCode = 1;
    } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
    }
}
