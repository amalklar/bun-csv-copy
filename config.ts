import { resolve } from 'node:path';
import { ImportError } from './errors';

export const UAS_COLUMNS = ['user_id', 'product_category_combination', 'credit_line_family'];

export interface ImportConfig {
    dsn: string;
    csvPath: string;
    profile: 'uas' | 'generic';
    database: string;
    schema: string;
    table: string;
    columns: string[];
    delimiter: string;
    sslRootCert?: string;
    dsnSource?: 'DB_URL' | 'DSN_LIVE';
}

export type ImportInput = Partial<ImportConfig> & { dsn: string };

function identifier(value: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value)) {
        throw new ImportError('Schema, table, and column names must be simple PostgreSQL identifiers of at most 63 characters.');
    }
    return value;
}

export function quoteIdentifier(value: string) {
    return `"${identifier(value)}"`;
}

export function resolveConfig(input: ImportInput): ImportConfig {
    if (!input.dsn.trim()) throw new ImportError('DB_URL or DSN_LIVE must be set.');
    const source = input.dsnSource ?? 'DB_URL or DSN_LIVE';
    let url: URL;
    try {
        url = new URL(input.dsn);
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
    } catch {
        throw new ImportError(`${source} must be a PostgreSQL connection URL.`);
    }
    if (!(url.username || url.searchParams.get('user')) || !(url.password || url.searchParams.get('password'))
        || url.pathname.length <= 1) {
        throw new ImportError(`The connection URL in ${source} must include the username, password, and database.`);
    }
    if (!url.port && !url.searchParams.get('port')) url.port = '5432';
    if (input.sslRootCert) {
        url.searchParams.set('sslrootcert', resolve(input.sslRootCert));
        url.searchParams.set('sslmode', 'verify-full');
    }
    const profile = input.profile ?? 'uas';
    if (profile !== 'uas' && profile !== 'generic') throw new ImportError('IMPORT_PROFILE must be uas or generic.');
    if (!input.csvPath?.trim()) throw new ImportError('CSV_PATH must be set, or provide a CSV file as the command argument.');
    const schema = identifier(input.schema ?? 'public');
    const table = input.table ?? (profile === 'uas' ? 'account_family_backfill_tasks' : '');
    if (!table) throw new ImportError('DB_TABLE must be set for the generic profile.');
    identifier(table);
    const columns = input.columns ?? (profile === 'uas' ? UAS_COLUMNS : []);
    if (columns.length === 0) throw new ImportError('CSV_COLUMNS must be set for the generic profile.');
    columns.forEach(identifier);
    if (new Set(columns).size !== columns.length) throw new ImportError('CSV_COLUMNS must contain unique column names.');
    if (profile === 'uas' && (columns.length !== UAS_COLUMNS.length || columns.some((name, i) => name !== UAS_COLUMNS[i]))) {
        throw new ImportError('The UAS profile requires user_id,product_category_combination,credit_line_family in that order.');
    }
    const delimiter = input.delimiter === '\\t' ? '\t' : input.delimiter ?? ',';
    if (delimiter.length !== 1 || delimiter.charCodeAt(0) > 127 || /[\0\r\n'"\\]/.test(delimiter)) {
        throw new ImportError('CSV_DELIMITER must be one ASCII character other than NUL, newline, single quote, double quote, or backslash.');
    }
    let database: string;
    try {
        database = input.database ?? (profile === 'uas' ? 'user_account_database' : decodeURIComponent(url.pathname.slice(1)));
    } catch {
        throw new ImportError('The connection URL database name is invalid.');
    }
    if (!database.trim()) throw new ImportError('DB_NAME cannot be empty.');
    return {
        dsn: url.toString(), csvPath: input.csvPath, profile, database, schema, table, columns: [...columns], delimiter,
        dsnSource: input.dsnSource,
    };
}

export function readConfig(env: Record<string, string | undefined> = process.env, csvArgument?: string) {
    const dbUrl = env.DB_URL?.trim();
    return resolveConfig({
        dsn: dbUrl || env.DSN_LIVE?.trim() || '',
        dsnSource: dbUrl ? 'DB_URL' : env.DSN_LIVE?.trim() ? 'DSN_LIVE' : undefined,
        csvPath: csvArgument ?? env.CSV_PATH,
        profile: env.IMPORT_PROFILE as ImportConfig['profile'] | undefined,
        database: env.DB_NAME,
        schema: env.DB_SCHEMA,
        table: env.DB_TABLE,
        columns: env.CSV_COLUMNS === undefined ? undefined : env.CSV_COLUMNS.split(',').map((name) => name.trim()),
        delimiter: env.CSV_DELIMITER,
        sslRootCert: env.DB_SSL_ROOT_CERT,
    });
}
