import { describe, expect, test } from 'bun:test';
import { debugTrace, describeError, ImportError, safeErrorMessage } from './errors';

const SECRET = 'user-secret-value';

describe('error descriptions', () => {
    test('explains connection failures by code', () => {
        const error = Object.assign(new Error(`getaddrinfo ENOTFOUND ${SECRET}`), { code: 'ENOTFOUND' });
        const message = describeError(error);
        expect(message).toContain('Database host not found. Check the VPN');
        expect(message).toContain('code ENOTFOUND');
        expect(message).not.toContain(SECRET);
    });

    test('explains pg errors that have no code', () => {
        expect(describeError(new Error('timeout expired'))).toContain('Timed out reaching the database');
        expect(describeError(new Error('Connection terminated unexpectedly'))).toBe('The database connection dropped.');
    });

    test('reports database codes, schema names, and CSV lines without row values', () => {
        const message = describeError({
            severity: 'ERROR', code: '23505', table: 'tasks', constraint: 'tasks_pkey',
            message: `duplicate key ${SECRET}`, detail: `Key (user_id)=(${SECRET}) already exists.`,
            where: 'COPY tasks, line 3',
        });
        expect(message).toBe('A row repeats a unique key that is already in the table or earlier in the CSV. '
            + 'Details: database code 23505, table tasks, constraint tasks_pkey, CSV line 3.');
    });

    test('reads the column from COPY context but drops the value', () => {
        const message = describeError({ severity: 'ERROR', code: '22P02', where: `COPY tasks, line 2, column amount: "${SECRET}"` });
        expect(message).toContain('column amount, CSV line 2');
        expect(message).not.toContain(SECRET);
    });

    test('names unexpected errors without their message', () => {
        expect(safeErrorMessage(new TypeError(SECRET))).toBe('Import failed. Unexpected TypeError. Nothing was committed.');
    });

    test('keeps import error messages and codes', () => {
        const error = new ImportError('Specific problem.', '23505');
        expect(describeError(error)).toBe('Specific problem.');
        expect(error.code).toBe('23505');
    });

    test('debug trace lists stack frames for the whole cause chain without messages', () => {
        const cause = Object.assign(new Error(SECRET), { code: 'ECONNRESET' });
        const trace = debugTrace(new ImportError(`Wrapped ${SECRET}`, 'ECONNRESET', { cause }));
        expect(trace).toContain('Error ECONNRESET');
        expect(trace).toMatch(/\n\s+at /);
        expect(trace).not.toContain(SECRET);
    });
});
