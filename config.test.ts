import { describe, expect, test } from 'bun:test';
import { readConfig, resolveConfig, UAS_COLUMNS } from './config';

const DSN = 'postgresql://user:password@localhost/custom_database';
const BASE = { DB_URL: DSN, CSV_PATH: '/tmp/input.csv' };

describe('environment configuration', () => {
    test('keeps UAS defaults and requires an explicit CSV path', () => {
        const config = readConfig(BASE);
        expect(config.profile).toBe('uas');
        expect(config.database).toBe('user_account_database');
        expect(config.table).toBe('account_family_backfill_tasks');
        expect(config.columns).toEqual(UAS_COLUMNS);
        expect(new URL(config.dsn).port).toBe('5432');
        expect(() => readConfig({ DB_URL: DSN })).toThrow('CSV_PATH');
    });
    test('prefers DB_URL and the CSV argument while retaining DSN_LIVE fallback', () => {
        expect(readConfig({ ...BASE, DSN_LIVE: 'invalid' }, '/tmp/override.csv').csvPath).toBe('/tmp/override.csv');
        expect(readConfig({ CSV_PATH: '/tmp/input.csv', DSN_LIVE: DSN }).dsn).toContain('custom_database');
    });
    test('names the variable that supplied the connection URL', () => {
        expect(readConfig(BASE).dsnSource).toBe('DB_URL');
        expect(readConfig({ CSV_PATH: '/tmp/input.csv', DSN_LIVE: DSN }).dsnSource).toBe('DSN_LIVE');
        expect(() => readConfig({ ...BASE, DB_URL: 'postgresql://HOST/db' })).toThrow('connection URL in DB_URL');
    });
    test('configures generic targets and tab-delimited input', () => {
        const config = readConfig({ ...BASE, IMPORT_PROFILE: 'generic', DB_SCHEMA: 'OtherSchema',
            DB_TABLE: 'OtherTable', CSV_COLUMNS: 'id, amount', CSV_DELIMITER: '\\t' });
        expect(config.database).toBe('custom_database');
        expect(config.schema).toBe('OtherSchema');
        expect(config.table).toBe('OtherTable');
        expect(config.columns).toEqual(['id', 'amount']);
        expect(config.delimiter).toBe('\t');
    });
    test('requires generic table and column configuration', () => {
        expect(() => readConfig({ ...BASE, IMPORT_PROFILE: 'generic' })).toThrow('DB_TABLE');
        expect(() => readConfig({ ...BASE, IMPORT_PROFILE: 'generic', DB_TABLE: 'items' })).toThrow('CSV_COLUMNS');
    });
    test('supports custom UAS locations while keeping UAS columns fixed', () => {
        expect(readConfig({ ...BASE, DB_NAME: 'custom_database', DB_SCHEMA: 'custom', DB_TABLE: 'tasks' }).database)
            .toBe('custom_database');
        expect(() => readConfig({ ...BASE, CSV_COLUMNS: 'other' })).toThrow('UAS profile requires');
    });
    test.each([
        { DB_SCHEMA: 'public; DROP TABLE users' },
        { DB_TABLE: 'public.items' },
        { DB_TABLE: 'a'.repeat(64) },
        { IMPORT_PROFILE: 'generic', DB_TABLE: 'items', CSV_COLUMNS: 'id,id' },
        { IMPORT_PROFILE: 'generic', DB_TABLE: 'items', CSV_COLUMNS: 'id,amount);--' },
        { IMPORT_PROFILE: 'unknown' },
        { CSV_DELIMITER: '\n' },
        { CSV_DELIMITER: '||' },
        { CSV_DELIMITER: 'é' },
        { DB_NAME: '' },
    ].map((overrides) => [overrides]))('rejects invalid or unsafe configuration (%#)', (overrides) => {
        expect(() => readConfig({ ...BASE, ...overrides })).toThrow();
    });
    test('supports a TLS root certificate without exposing credentials', () => {
        const url = new URL(readConfig({ ...BASE, DB_SSL_ROOT_CERT: '/tmp/ca.pem' }).dsn);
        expect(url.searchParams.get('sslmode')).toBe('verify-full');
        expect(url.searchParams.get('sslrootcert')).toBe('/tmp/ca.pem');
        expect(url.username).toBe('user');
    });
    test('preserves explicit ports and URL-encoded credentials', () => {
        const config = resolveConfig({ dsn: 'postgresql://user:p%40ss%3Aword@localhost:16472/custom_database', csvPath: '/tmp/in.csv' });
        expect(new URL(config.dsn).port).toBe('16472');
        expect(decodeURIComponent(new URL(config.dsn).password)).toBe('p@ss:word');
    });
});
