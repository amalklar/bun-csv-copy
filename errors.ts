export class ImportError extends Error {
    override name = 'ImportError';

    constructor(message: string, readonly code?: string, options?: ErrorOptions) {
        super(message, options);
    }
}

const TLS_HINT = 'TLS verification failed. Set DB_SSL_ROOT_CERT to the database CA certificate file.';
const HOST_HINT = 'Database host not found. Check the VPN and the host in DB_URL or DSN_LIVE.';
const TIMEOUT_HINT = 'Timed out reaching the database. Check the VPN, host, and port.';
const DROPPED_HINT = 'The database connection dropped.';

const CODE_HINTS: Record<string, string> = {
    ENOTFOUND: HOST_HINT,
    EAI_AGAIN: HOST_HINT,
    ECONNREFUSED: 'The database refused the connection. Check the host and port.',
    ETIMEDOUT: TIMEOUT_HINT,
    ECONNRESET: DROPPED_HINT,
    EPIPE: DROPPED_HINT,
    ENOENT: 'File not found.',
    EACCES: 'No permission to read the file.',
    EISDIR: 'Expected a file but found a directory.',
    SELF_SIGNED_CERT_IN_CHAIN: TLS_HINT,
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: TLS_HINT,
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: TLS_HINT,
    DEPTH_ZERO_SELF_SIGNED_CERT: TLS_HINT,
    CERT_HAS_EXPIRED: 'The database TLS certificate has expired.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'The database TLS certificate does not match the host name.',
    '28P01': 'Login failed. Check the username and password.',
    '28000': 'The database rejected this login. Check the user and its access rules.',
    '3D000': 'The database in the connection URL does not exist.',
    '42P01': 'The target table does not exist.',
    '42501': 'The database user lacks permission for this import.',
    '23505': 'A row repeats a unique key that is already in the table or earlier in the CSV.',
    '23502': 'A required column received an empty value.',
    '23514': 'A row breaks a check constraint.',
    '22P02': 'A value does not match its column type.',
    '22007': 'A date or time value has the wrong format.',
    '22003': 'A number is out of range for its column.',
    '22001': 'A value is too long for its column.',
    '22P04': 'A CSV line does not match the COPY format.',
    '55P03': 'Another session holds a lock on the target table. Try again later.',
    '57014': 'A database statement was cancelled or timed out.',
    '57P01': 'The database is shutting down.',
    '57P03': 'The database is not accepting connections yet.',
    '53300': 'The database has too many open connections.',
};

// pg reports these without a code, so match its fixed wording.
const MESSAGE_HINTS: [RegExp, string][] = [
    [/timeout expired|connection timeout/i, TIMEOUT_HINT],
    [/connection terminated/i, DROPPED_HINT],
    [/does not support SSL/i, 'The database does not accept TLS. Check sslmode in the connection URL.'],
];

export function errorCode(error: unknown) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return typeof code === 'string' ? code : '';
}

// Raw messages and details can contain row values or credentials, so only codes,
// schema names, and line numbers are reported.
export function describeError(error: unknown) {
    if (error instanceof ImportError) return error.message;
    const fields = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
    const code = errorCode(error);
    const message = typeof fields.message === 'string' ? fields.message : '';
    const name = typeof fields.name === 'string' ? fields.name : 'error';
    const hint = CODE_HINTS[code] ?? MESSAGE_HINTS.find(([pattern]) => pattern.test(message))?.[1] ?? `Unexpected ${name}.`;
    const details: string[] = [];
    if (code) details.push(typeof fields.severity === 'string' || /^\d[0-9A-Z]{4}$/.test(code) ? `database code ${code}` : `code ${code}`);
    for (const key of ['table', 'constraint'] as const) {
        if (typeof fields[key] === 'string') details.push(`${key} ${fields[key]}`);
    }
    const where = typeof fields.where === 'string' ? fields.where : '';
    const column = typeof fields.column === 'string' ? fields.column : /\bcolumn ([A-Za-z_][A-Za-z0-9_$]*)/.exec(where)?.[1];
    if (column) details.push(`column ${column}`);
    const line = /\bline (\d+)/.exec(where)?.[1];
    if (line) details.push(`CSV line ${line}`);
    return details.length ? `${hint} Details: ${details.join(', ')}.` : hint;
}

export function safeErrorMessage(error: unknown) {
    if (error instanceof ImportError) return error.message;
    return `Import failed. ${describeError(error)} Nothing was committed.`;
}

// Stack frames show where a failure happened without repeating error messages.
export function debugTrace(error: unknown) {
    const lines: string[] = [];
    for (let current = error; current instanceof Error; current = current.cause) {
        const code = errorCode(current);
        lines.push(`${current.name}${code ? ` ${code}` : ''}`);
        lines.push(...(current.stack ?? '').split('\n').filter((line) => line.trimStart().startsWith('at ')));
    }
    return lines.join('\n');
}
