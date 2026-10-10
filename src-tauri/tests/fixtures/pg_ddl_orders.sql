-- Fixture for the PostgreSQL DDL integration test (tests/postgres.rs), created in `public`. Its
-- generated DDL is compared with pg_ddl_orders.golden.sql, which drivers/postgres/ddl.rs also
-- checks offline.
CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped');
CREATE TABLE users (id bigint PRIMARY KEY);
CREATE TABLE orders (
    id bigint GENERATED ALWAYS AS IDENTITY,
    user_id bigint NOT NULL,
    status order_status NOT NULL DEFAULT 'new',
    total numeric(12,2) DEFAULT 0,
    double_total numeric GENERATED ALWAYS AS (total * 2) STORED,
    CONSTRAINT orders_pkey PRIMARY KEY (id),
    CONSTRAINT orders_total_check CHECK (total >= 0),
    CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX orders_user_id_idx ON orders (user_id);
