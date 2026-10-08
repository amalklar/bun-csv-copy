# bun-csv-copy

Load a CSV into an existing PostgreSQL table with Bun. Use `uas` for
account-family backfills or `generic` for other tables. `uas` is the default.

## Run

```bash
bun install --frozen-lockfile
cp .env.example .env
```

Set the database URL and CSV path in `.env`, then run:

```bash
bun run copy
```

The command adds rows and commits them together. It preserves existing rows,
leaves backfill jobs unchanged, and requires the table to exist.
Git ignores CSV files, local `.env` files, and certificates.

You can override `CSV_PATH` with a file argument:

```bash
bun run copy /absolute/path/input.csv
```

`bun run copy:live` runs the same importer using your configured database.
Shell variables override `.env`. If your credentials come from interactive zsh,
run the command there.

## Settings

| Variable | Purpose | Default |
| --- | --- | --- |
| `DB_URL` | PostgreSQL URL with username, password, host, and database | Required; falls back to `DSN_LIVE` |
| `CSV_PATH` | UTF-8 CSV file | Required unless passed as an argument |
| `IMPORT_PROFILE` | `uas` or `generic` | `uas` |
| `DB_NAME` | Expected database, checked before import | UAS: `user_account_database`; generic: URL database |
| `DB_SCHEMA` | Target schema | `public` |
| `DB_TABLE` | Target table | UAS: `account_family_backfill_tasks`; required for generic |
| `CSV_COLUMNS` | Target columns in CSV header order, separated by commas | UAS columns below; required for generic |
| `CSV_DELIMITER` | One ASCII separator; `\t` means tab | `,` |
| `DB_SSL_ROOT_CERT` | CA certificate file | Optional; `sslrootcert` in the URL also works |

The CSV header must match `CSV_COLUMNS` exactly, including order.
Names can contain letters, digits, underscores, or dollar signs, must start with
a letter or underscore, and have a 63-character limit. SQL preserves their case.
URL-encode special characters in credentials. Logs exclude credentials and user
records; database errors show a code instead of row details.

## UAS

The header is `user_id,product_category_combination,credit_line_family`.
All three fields are required. Families must be `KLAR_FAMILY` or `UBER_FAMILY`.
The table needs required TEXT columns, a primary key on `user_id`, and defaults
of `processed = false` and `processed_at = NULL`.
You can change the database, schema, and table while keeping these checks.

## Other tables

Set `IMPORT_PROFILE=generic` and name the table and columns. For example:

```dotenv
DB_URL=postgresql://USER:PASSWORD@HOST:5432/example_database?sslmode=verify-full
CSV_PATH=/absolute/path/payments.csv
IMPORT_PROFILE=generic
DB_NAME=example_database
DB_SCHEMA=public
DB_TABLE=payments
CSV_COLUMNS=id,amount,note
CSV_DELIMITER=,
```

PostgreSQL checks types and constraints. Omitted columns must allow NULL, have a
default, or generate their own values. Unquoted empty fields become NULL;
quoted empty fields stay empty strings. Database uniqueness rules decide whether
duplicate rows fail. UAS checks do not apply.

## TLS

Set `DB_SSL_ROOT_CERT=/absolute/path/ca-bundle.pem` if the database CA is not
trusted locally. This uses `sslmode=verify-full` to verify the certificate and
hostname. For RDS, get your region's bundle from the
[AWS RDS certificate documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).

## Import checks

The importer validates the CSV before connecting and streams it in one
transaction without holding all rows in memory. It checks the target columns,
file digest, and row count before committing. Bad input, changed files,
constraint failures, and stream interruptions abort the load.

Progress shows bytes streamed. Success means PostgreSQL confirmed the commit.
Ctrl-C before commit requests rollback. If commit confirmation is lost, check
the database before retrying.

## Tests

```bash
bun run typecheck
bun test
```

CSV and settings tests need no database. Integration tests use `COPY_TEST_DSN`
with credentials for an isolated local `user_account_database`. They create and
remove their tables and refuse an existing UAS target table. Test connections
never use your `DB_URL` or `DSN_LIVE`.
