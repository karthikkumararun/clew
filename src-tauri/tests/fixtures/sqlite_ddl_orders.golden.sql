CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users (id),
    total NUMERIC DEFAULT 0 CHECK (total >= 0)
);

CREATE INDEX orders_user_id_idx ON orders (user_id);

CREATE TRIGGER orders_audit AFTER INSERT ON orders BEGIN SELECT 1; END
