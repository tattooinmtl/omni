---
name: sql-coding
command: /sql
description: SQL environment setup, syntax rules, best practices, and query optimization.
---

# SQL Coding Skill

## Purpose
Guide the user through SQL database environment detection, installation, query writing, optimization, and best practices across PostgreSQL, MySQL, and SQLite.

## When to use
Use this skill when the user runs:

/sql [subcommand]

Subcommands:
- (none) — Detect SQL database environment, report status, and offer to fix issues
- new <project-name> — Scaffold a new database project
- check — Scan current project for SQL issues and best practice violations
- help — Show this help

---

## Phase 1 — Environment Detection & Installation

### Step 1: Detect existing SQL installation
Use `run_shell` to check:
```powershell
where psql          # PostgreSQL CLI
where mysql         # MySQL CLI
where sqlite3       # SQLite CLI
where sqlcmd        # SQL Server CLI
```

Check for database servers:
```powershell
where postgres      # PostgreSQL server
where mysqld        # MySQL server
```

Check for GUI tools:
```powershell
where pgadmin       # pgAdmin (PostgreSQL GUI)
where dbeaver       # DBeaver (universal SQL GUI)
```

### Step 2: Report status
- ✅ / ❌ PostgreSQL (psql)
- ✅ / ❌ MySQL (mysql)
- ✅ / ❌ SQLite (sqlite3)
- ✅ / ❌ GUI tool (pgAdmin/DBeaver)

### Step 3: Install databases as needed

**PostgreSQL:**
```powershell
# Windows
winget install PostgreSQL.PostgreSQL
# OR download from https://www.postgresql.org/download/windows/

# Linux
sudo apt install postgresql postgresql-contrib

# macOS
brew install postgresql@17
```

**MySQL:**
```powershell
# Windows
winget install Oracle.MySQL
# OR download from https://dev.mysql.com/downloads/installer/

# Linux
sudo apt install mysql-server

# macOS
brew install mysql
```

**SQLite:**
```powershell
# Windows
winget install SQLite.SQLite
# OR download from https://www.sqlite.org/download.html

# Linux (usually pre-installed)
sudo apt install sqlite3

# macOS (pre-installed)
```

### Step 4: Verify
```powershell
psql --version
mysql --version
sqlite3 --version
```

---

## Phase 2 — Project Scaffolding

### Database project structure
```
my-database-project/
├── migrations/
│   ├── 001_create_users.sql
│   ├── 002_add_indexes.sql
│   └── 003_add_orders.sql
├── seeds/
│   └── seed_data.sql
├── queries/
│   ├── analytics/
│   │   └── monthly_sales.sql
│   └── reports/
│       └── user_activity.sql
├── schemas/
│   └── schema.sql
├── tests/
│   └── test_queries.sql
└── README.md
```

### Migration example
```sql
-- migrations/001_create_users.sql
CREATE TABLE users (
    id          BIGSERIAL PRIMARY KEY,
    email       VARCHAR(255) NOT NULL UNIQUE,
    name        VARCHAR(100) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_created_at ON users(created_at);
```

---

## Phase 3 — Syntax Rules & Best Practices

### Query Writing
- **Never use `SELECT *`** — always specify columns explicitly
- **Use meaningful aliases** — not single letters (except in short queries)
- **Use CTEs** for readability and modularity
- **Comment complex queries** — explain the "why", not the "what"
- **Use consistent formatting** — uppercase keywords, lowercase identifiers

```sql
-- ✅ Good — explicit columns, aliases, CTE
WITH customer_sales AS (
    SELECT
        c.id           AS customer_id,
        c.name         AS customer_name,
        SUM(o.amount)  AS total_sales
    FROM customers c
    JOIN orders o ON c.id = o.customer_id
    WHERE o.order_date >= '2026-01-01'
    GROUP BY c.id, c.name
)
SELECT *
FROM customer_sales
WHERE total_sales > 5000
ORDER BY total_sales DESC;

-- ❌ Bad — SELECT *, no aliases, no structure
SELECT * FROM customers c JOIN orders o ON c.id = o.customer_id WHERE o.order_date >= '2026-01-01' GROUP BY c.id ORDER BY SUM(o.amount) DESC;
```

### CTEs (Common Table Expressions)
- **Use CTEs to break down complex queries** — modular, readable
- **Use recursive CTEs** for hierarchical data
- **CTEs are not always materialized** — check your database behavior

```sql
-- CTE for modular query
WITH active_users AS (
    SELECT id, name, email
    FROM users
    WHERE active = true
),
user_orders AS (
    SELECT
        u.id AS user_id,
        u.name,
        COUNT(o.id) AS order_count,
        SUM(o.amount) AS total_spent
    FROM active_users u
    LEFT JOIN orders o ON u.id = o.user_id
    GROUP BY u.id, u.name
)
SELECT *
FROM user_orders
WHERE order_count > 0
ORDER BY total_spent DESC;

-- Recursive CTE for hierarchical data
WITH RECURSIVE category_tree AS (
    -- Base case: root categories
    SELECT id, name, parent_id, 0 AS depth
    FROM categories
    WHERE parent_id IS NULL

    UNION ALL

    -- Recursive case: child categories
    SELECT c.id, c.name, c.parent_id, ct.depth + 1
    FROM categories c
    JOIN category_tree ct ON c.parent_id = ct.id
)
SELECT id, name, depth
FROM category_tree
ORDER BY depth, name;
```

### Window Functions
- **Use window functions** instead of self-joins or correlated subqueries
- **Understand window frames** — `ROWS`, `RANGE`, `GROUPS`
- **Use `QUALIFY`** (Snowflake, DuckDB) to filter window results

```sql
-- Ranking with window functions
SELECT
    employee_name,
    department,
    salary,
    RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS dept_rank,
    DENSE_RANK() OVER (ORDER BY salary DESC) AS overall_rank
FROM employees;

-- Running total
SELECT
    order_date,
    customer_id,
    amount,
    SUM(amount) OVER (
        PARTITION BY customer_id
        ORDER BY order_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_total
FROM orders;

-- Lag/Lead for comparison
SELECT
    date,
    revenue,
    LAG(revenue, 1) OVER (ORDER BY date) AS prev_day_revenue,
    revenue - LAG(revenue, 1) OVER (ORDER BY date) AS daily_change,
    ROUND(
        (revenue - LAG(revenue, 1) OVER (ORDER BY date)) /
        LAG(revenue, 1) OVER (ORDER BY date) * 100, 2
    ) AS pct_change
FROM daily_revenue;

-- First/Last value in a partition
SELECT
    customer_id,
    FIRST_VALUE(order_date) OVER (PARTITION BY customer_id ORDER BY order_date) AS first_order,
    LAST_VALUE(order_date) OVER (
        PARTITION BY customer_id ORDER BY order_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
    ) AS last_order
FROM orders;
```

### Indexing Strategy
- **Index foreign keys** — they are frequently joined
- **Index columns used in WHERE clauses** — especially for large tables
- **Use composite indexes** for multi-column queries
- **Use covering indexes** to avoid table lookups
- **Use partial indexes** for frequently filtered subsets
- **Don't over-index** — indexes slow down writes

```sql
-- Single column index
CREATE INDEX idx_users_email ON users(email);

-- Composite index (order matters — most selective first)
CREATE INDEX idx_orders_customer_date ON orders(customer_id, order_date);

-- Covering index (includes all columns needed by query)
CREATE INDEX idx_orders_covering ON orders(customer_id, order_date)
    INCLUDE (amount, status);

-- Partial index (only index active users)
CREATE INDEX idx_active_users ON users(last_login)
    WHERE active = true;

-- Unique index
CREATE UNIQUE INDEX idx_unique_email ON users(lower(email));
```

### Performance Optimization
- **Use `EXPLAIN` / `EXPLAIN ANALYZE`** to understand query plans
- **Filter early** — apply WHERE before JOIN when possible
- **Avoid correlated subqueries** — use JOINs or CTEs instead
- **Use `LIMIT` for testing** — don't query millions of rows during development
- **Use `COALESCE`** to handle NULLs explicitly
- **Batch large operations** — don't update millions of rows at once

```sql
-- Use EXPLAIN ANALYZE to find bottlenecks
EXPLAIN ANALYZE
SELECT c.name, SUM(o.amount)
FROM customers c
JOIN orders o ON c.id = o.customer_id
WHERE o.order_date >= '2026-01-01'
GROUP BY c.name;

-- COALESCE for NULL handling
SELECT
    product_name,
    COALESCE(price, 0) AS price,
    COALESCE(discount, 0) AS discount
FROM products;

-- Batch processing for large updates
-- Process in chunks to avoid locking the whole table
UPDATE orders SET status = 'archived'
WHERE status = 'completed'
  AND created_at < '2025-01-01'
LIMIT 10000;
```

### Data Types
- **Use `TIMESTAMPTZ`** (PostgreSQL) — not `TIMESTAMP` — for timezone-aware dates
- **Use `BIGSERIAL` / `BIGINT AUTO_INCREMENT`** for primary keys
- **Use `UUID`** for distributed systems — avoids ID collisions
- **Use `DECIMAL` / `NUMERIC`** for financial data — never `FLOAT`
- **Use `VARCHAR(n)`** with reasonable limits — not `TEXT` for indexed columns
- **Use `JSONB`** (PostgreSQL) for flexible schema data — not `JSON`

```sql
CREATE TABLE products (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    price       DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Constraints and Validation
- **Use `NOT NULL`** by default — only allow NULL when truly needed
- **Use `CHECK` constraints** for domain validation
- **Use `UNIQUE` constraints** for natural keys
- **Use foreign keys** — never skip referential integrity

```sql
CREATE TABLE orders (
    id          BIGSERIAL PRIMARY KEY,
    customer_id BIGINT NOT NULL REFERENCES customers(id),
    status      VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
    total       DECIMAL(10, 2) NOT NULL CHECK (total >= 0),
    order_date  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, order_date)
);
```

### Transactions
- **Use transactions** for multi-statement operations
- **Use appropriate isolation levels** — `READ COMMITTED` is usually sufficient
- **Keep transactions short** — long transactions lock resources

```sql
-- Transaction with proper error handling
BEGIN;

-- Deduct from account
UPDATE accounts SET balance = balance - 100
WHERE id = 1 AND balance >= 100;

-- Only proceed if deduction succeeded
-- (check row count or use RETURNING)
INSERT INTO transactions (from_account, to_account, amount)
VALUES (1, 2, 100);

-- Credit recipient
UPDATE accounts SET balance = balance + 100
WHERE id = 2;

COMMIT;
-- Use ROLLBACK on error
```

### Security Best Practices
- **Never interpolate user input into SQL** — use parameterized queries / prepared statements
- **Use least privilege** — application users should not have DDL privileges
- **Use views** to restrict access to sensitive columns
- **Encrypt sensitive data** at rest
- **Use connection pooling** — don't open a new connection per query

```sql
-- View to restrict access
CREATE VIEW user_public_info AS
SELECT id, name, email, created_at
FROM users;
-- Grant access to the view, not the table
GRANT SELECT ON user_public_info TO app_readonly;

-- Parameterized query (application side)
-- PostgreSQL:  SELECT * FROM users WHERE email = $1
-- MySQL:       SELECT * FROM users WHERE email = ?
-- Never:        SELECT * FROM users WHERE email = '" + userInput + "'
```

### Database-Specific Notes

**PostgreSQL:**
- `RETURNING` clause for INSERT/UPDATE/DELETE
- `JSONB` for JSON data (indexable, efficient)
- `GENERATED ALWAYS AS IDENTITY` (modern alternative to SERIAL)
- `FILTER` clause for conditional aggregation
- `DISTINCT ON` for first-row-per-group

**MySQL:**
- `LIMIT` for pagination (no `OFFSET` for large tables — use keyset pagination)
- `ON DUPLICATE KEY UPDATE` for upserts
- `JSON` type with JSON functions

**SQLite:**
- Serverless — no installation needed
- `PRAGMA` statements for configuration
- `WITHOUT ROWID` for tables with natural keys
- Good for embedded/local databases

---

## Phase 4 — Verification

### Validate queries
```sql
-- PostgreSQL: check syntax without executing
EXPLAIN <query>;

-- MySQL: validate
EXPLAIN <query>;

-- Check for table existence
SELECT EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_name = 'users'
);
```

### Test queries
```sql
-- Use LIMIT for safe testing
SELECT * FROM users LIMIT 10;

-- Test with EXPLAIN ANALYZE
EXPLAIN ANALYZE SELECT * FROM users WHERE email = 'test@example.com';
```

### Run migrations
```powershell
# PostgreSQL
psql -d mydb -f migrations/001_create_users.sql

# MySQL
mysql -u root -p mydb < migrations/001_create_users.sql

# SQLite
sqlite3 mydb.db < migrations/001_create_users.sql
```

---

## Phase 5 — Quick Reference

| Practice | Why |
|---|---|
| Explicit columns, not `SELECT *` | Performance, clarity |
| CTEs for complex queries | Readability, modularity |
| Window functions over self-joins | Performance, clarity |
| Index foreign keys | Join performance |
| `EXPLAIN ANALYZE` | Find bottlenecks |
| `TIMESTAMPTZ` over `TIMESTAMP` | Timezone awareness |
| `DECIMAL` for financial data | Precision |
| Parameterized queries | SQL injection prevention |
| `NOT NULL` by default | Data integrity |
| Foreign key constraints | Referential integrity |
| Short transactions | Reduce lock contention |
| Keyset pagination over `OFFSET` | Performance on large tables |

---

## Rules
- Always detect the environment before suggesting installation.
- Use `run_shell` for all commands — verify each succeeds before continuing.
- Read existing project files before suggesting changes.
- Never use `SELECT *` — always specify columns explicitly.
- Always use parameterized queries — never interpolate user input.
- Use CTEs for complex queries — not nested subqueries.
- Use window functions instead of self-joins or correlated subqueries.
- Use `EXPLAIN ANALYZE` to verify query performance.
- Always define foreign key constraints.
- Use `NOT NULL` by default — only allow NULL when truly needed.
- Use `DECIMAL`/`NUMERIC` for financial data — never `FLOAT`.
- Index foreign keys and frequently filtered columns.

## Output
1. Environment status report
2. Installation/fix steps (if needed)
3. Database schema/migrations (if requested)
4. Optimized SQL queries with best practices applied
5. EXPLAIN ANALYZE verification