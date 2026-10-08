# bun-csv-copy

Stream a CSV into an existing PostgreSQL table using Bun and `COPY FROM STDIN`.
The default UAS profile retains account-family backfill validation. The generic
profile supports other tables and PostgreSQL column types.

## Setup

```bash
bun install --frozen-lockfile
cp .env.example .env
```

Edit `.env` with the connection URL and CSV path, then run:

```bash
bun run copy
```

This imports and commits rows to the configured database. The importer does not
create tables, truncate data, overwrite existing rows, or enable a backfill job.
CSV files, local environment files, and certificate files are ignored by Git.

An optional command argument overrides `CSV_PATH`:

```bash
bun run copy /absolute/path/input.csv
```

`bun run copy:live` remains an alias for the same importer. It does not select
a live database automatically. Exported shell variables take precedence over
Bun's `.env` values.

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `DB_URL` | PostgreSQL URL with username, password, host, and database | Required, with `DSN_LIVE` as a compatibility fallback |
| `CSV_PATH` | Local UTF-8 CSV file | Required unless supplied as an argument |
| `IMPORT_PROFILE` | `uas` or `generic` | `uas` |
| `DB_NAME` | Expected connected database, checked before COPY | `user_account_database` for UAS; URL database for generic |
| `DB_SCHEMA` | Target schema | `public` |
| `DB_TABLE` | Target table | `account_family_backfill_tasks` for UAS; required for generic |
| `CSV_COLUMNS` | Comma-separated target columns in CSV header order | UAS columns below; required for generic |
| `CSV_DELIMITER` | Single ASCII field separator; `\t` selects tab | `,` |
| `DB_SSL_ROOT_CERT` | Path to the database CA certificate bundle | Optional; also supports `sslrootcert` in the URL |

Schema, table, and column names must use letters, digits, underscores, or dollar
signs, start with a letter or underscore, and be at most 63 characters. Names
are quoted in SQL, so mixed-case names are preserved. `CSV_COLUMNS` always uses
commas to separate names, even when the file uses another delimiter. The file
must contain a header matching those names and their order.

URL-encode special characters in credentials. Credentials and user records are
not printed. Database failures report an error code without the server's row
details. If your connection variables are initialized by interactive zsh, run
the command from that shell.

### UAS profile

The UAS columns are `user_id,product_category_combination,credit_line_family`.
Each row must contain three populated fields. Supported families are
`KLAR_FAMILY` and `UBER_FAMILY`. The table must have required TEXT input columns,
a primary key on `user_id`, and processing defaults of `processed = false` and
`processed_at = NULL`. Database, schema, and table names can be configured while
retaining these checks.

### Generic profile

For example, given an existing table with columns `id`, `amount`, and `note`:

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

Only configured columns are loaded. Omitted columns must be nullable, generated,
identity columns, or have a default. PostgreSQL validates types and constraints;
UAS family and processing rules do not apply. Unquoted empty fields become NULL,
while quoted empty fields remain empty strings. Duplicate rows fail when a
database uniqueness constraint rejects them; the generic importer does not
invent uniqueness rules.

### TLS certificates

For a database whose CA is not in the system trust store, set
`DB_SSL_ROOT_CERT=/absolute/path/ca-bundle.pem`. This sets `sslmode=verify-full`
and verifies both the certificate chain and hostname. For Amazon RDS, download
the bundle for your database's region from the
[AWS RDS certificate documentation](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html).
The importer does not disable certificate verification to work around a trust
error.

## Import behavior

The importer validates the entire CSV before connecting, then streams the
original file through one COPY transaction. It checks the connected database,
target columns, file digest, and COPY row count before committing. It keeps
stream buffers rather than loading all rows into memory. Empty files, malformed
CSV, mismatched headers, changed files, database constraint failures, and stream
interruptions abort the load.

Progress reports streamed bytes before commit. The committed row count appears
only after PostgreSQL acknowledges COMMIT. Ctrl-C before commit requests
rollback. If commit acknowledgment is lost, check database state before retrying.

## Tests

```bash
bun run typecheck
bun test
```

CSV and configuration tests run without a database. To run PostgreSQL integration
tests, set `COPY_TEST_DSN` to an isolated local database named
`user_account_database`, including local test credentials. The tests create and
remove their tables and refuse to use an existing UAS target table. They never
read `DB_URL` or `DSN_LIVE` for test connections.
