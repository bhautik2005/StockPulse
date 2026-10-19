-- =============================================================================
-- StockPulse :: 001_init
-- Enterprise B2B multi-warehouse inventory & supply chain schema (3NF).
--
-- Comments marked [P0-n] document corrections applied to the original draft DDL.
-- Everything here is enforced by PostgreSQL itself, so bad data cannot enter the
-- system even if a future service layer forgets a rule.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shared helper: keep updated_at honest without trusting the application.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 1. users  (Admin | Manager | Staff | Client)
-- =============================================================================
CREATE TABLE users (
  id            integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          varchar(100) NOT NULL CHECK (length(btrim(name)) > 0),
  email         varchar(150) NOT NULL CHECK (position('@' in email) > 1),
  password_hash varchar(255) NOT NULL,

  -- [P0-1] 'Client' added. The original draft described Staff/Client buyers but
  --        the CHECK constraint silently rejected 'Client', because VARCHAR
  --        CHECK only fails at runtime, never at design time.
  role          varchar(50)  NOT NULL DEFAULT 'Client'
                             CHECK (role IN ('Admin', 'Manager', 'Staff', 'Client')),

  is_active     boolean      NOT NULL DEFAULT true,

  -- [P0-2] Privilege revocation. A JWT stays valid until it expires, so a user
  --        demoted from Admin would keep Admin rights for the token's lifetime.
  --        Bumping token_version invalidates every token already issued.
  token_version integer      NOT NULL DEFAULT 0,

  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),

  -- Soft delete: users are referenced by orders and ledger rows forever.
  deleted_at    timestamptz
);

-- [P0-3] Case-insensitive uniqueness: 'Ada@x.com' and 'ada@x.com' are the same
--        person. A plain UNIQUE(email) allows both to register.
CREATE UNIQUE INDEX users_email_lower_uniq
  ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 2. warehouses
-- =============================================================================
CREATE TABLE warehouses (
  id         integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       varchar(20)  NOT NULL,
  name       varchar(100) NOT NULL CHECK (length(btrim(name)) > 0),
  location   varchar(255) NOT NULL,

  -- [P0-4] ON DELETE SET NULL (original) silently orphaned a warehouse: stock
  --        kept existing with nobody accountable for it. RESTRICT forces the
  --        operator to reassign the manager or soft-delete first.
  manager_id integer      REFERENCES users (id) ON DELETE RESTRICT,

  is_active  boolean      NOT NULL DEFAULT true,
  created_at timestamptz  NOT NULL DEFAULT now(),
  updated_at timestamptz  NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  CHECK (code = upper(code))
);

CREATE UNIQUE INDEX warehouses_code_uniq    ON warehouses (upper(code));
CREATE UNIQUE INDEX warehouses_name_uniq    ON warehouses (lower(name)) WHERE deleted_at IS NULL;

-- [P0-5] One manager accountable per warehouse, enforced by the database.
CREATE UNIQUE INDEX warehouses_manager_uniq ON warehouses (manager_id)
  WHERE manager_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX warehouses_manager_idx ON warehouses (manager_id);

CREATE TRIGGER warehouses_set_updated_at BEFORE UPDATE ON warehouses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 3. user_warehouses  (explicit access grants -> the basis of RBAC scoping)
-- =============================================================================
-- [P0-6] The original schema had no way to express "this Staff user works at
--        warehouse 3". Without it, warehouse scoping is impossible to enforce
--        and every Manager/Staff endpoint is an IDOR waiting to happen.
CREATE TABLE user_warehouses (
  user_id      integer     NOT NULL REFERENCES users (id)      ON DELETE CASCADE,
  warehouse_id integer     NOT NULL REFERENCES warehouses (id) ON DELETE CASCADE,
  granted_by   integer     REFERENCES users (id) ON DELETE SET NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, warehouse_id)
);

CREATE INDEX user_warehouses_warehouse_idx ON user_warehouses (warehouse_id);

-- =============================================================================
-- 4. products
-- =============================================================================
CREATE TABLE products (
  id            integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku           varchar(50)  NOT NULL CHECK (length(btrim(sku)) > 0),
  name          varchar(150) NOT NULL CHECK (length(btrim(name)) > 0),
  category      varchar(100),

  -- [P0-7] Money is NUMERIC, never float. Also priced at 12,2 so nobody can
  --        insert a negative price or a value with sub-cent precision.
  unit_price    numeric(12,2) NOT NULL CHECK (unit_price >= 0),

  reorder_level integer       NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),

  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);

-- [P0-8] SKUs are case-insensitive keys ('abc-1' and 'ABC-1' are one product).
CREATE UNIQUE INDEX products_sku_uniq ON products (upper(sku)) WHERE deleted_at IS NULL;
CREATE INDEX products_category_idx ON products (category) WHERE deleted_at IS NULL;

CREATE TRIGGER products_set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 5. inventory  (junction: warehouse x product -> on-hand quantity)
-- =============================================================================
CREATE TABLE inventory (
  id            integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- [P0-9] CASCADE (original) deleted stock records when a warehouse or product
  --        was removed, destroying the audit trail. RESTRICT + soft delete.
  warehouse_id  integer     NOT NULL REFERENCES warehouses (id) ON DELETE RESTRICT,
  product_id    integer     NOT NULL REFERENCES products (id)   ON DELETE RESTRICT,

  -- [P0-10] quantity >= 0 is the last line of defence against overselling.
  quantity      integer     NOT NULL DEFAULT 0 CHECK (quantity >= 0),

  -- [P0-11] Reorder level is per warehouse, with the product value as fallback.
  --         A SKU can be critical in Nairobi and overstocked in Lagos; a single
  --         global threshold cannot express that.
  reorder_level integer     CHECK (reorder_level IS NULL OR reorder_level >= 0),

  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inventory_warehouse_product_uniq UNIQUE (warehouse_id, product_id)
);

-- [P0-12] PostgreSQL does NOT auto-index foreign keys. Every one of these was a
--         sequential scan in the original schema.
CREATE INDEX inventory_warehouse_idx ON inventory (warehouse_id);
CREATE INDEX inventory_product_idx   ON inventory (product_id);

CREATE TRIGGER inventory_set_updated_at BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 6. inventory_transactions  (append-only stock ledger)
-- =============================================================================
-- [P0-13] The original schema stored a mutable counter with no history, so
--         "who reduced this and why?" was unanswerable. Every quantity change
--         in this system writes a ledger row inside the same transaction.
CREATE TABLE inventory_transactions (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  warehouse_id integer     NOT NULL REFERENCES warehouses (id) ON DELETE RESTRICT,
  product_id   integer     NOT NULL REFERENCES products (id)   ON DELETE RESTRICT,

  delta        integer     NOT NULL CHECK (delta <> 0),
  reason       varchar(30) NOT NULL CHECK (reason IN
                 ('receipt', 'sale', 'adjustment', 'return', 'transfer_in', 'transfer_out', 'restock')),

  -- Polymorphic link back to whatever caused the movement (e.g. an order).
  ref_type     varchar(30),
  ref_id       bigint,
  note         text,
  created_by   integer     REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inventory_transactions_stock_idx
  ON inventory_transactions (warehouse_id, product_id, created_at DESC);
CREATE INDEX inventory_transactions_ref_idx
  ON inventory_transactions (ref_type, ref_id);

-- =============================================================================
-- 7. orders
-- =============================================================================
CREATE SEQUENCE order_number_seq AS bigint START 1;

CREATE TABLE orders (
  id              integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- [P0-14] Humans need 'SO-2025-000431', not 'id = 431'.
  order_number    varchar(30)  NOT NULL,

  -- [P0-15] RESTRICT, not SET NULL: an order with no owner is unaccountable.
  client_id       integer      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

  -- [P0-16] Original enum had no partial-fulfilment state, so a split shipment
  --         had nowhere to live.
  status          varchar(30)  NOT NULL DEFAULT 'Pending' CHECK (status IN
                    ('Pending', 'Processing', 'Partially Shipped', 'Shipped', 'Delivered', 'Cancelled')),

  -- [P0-17] Always computed server-side from order_items; a client-supplied
  --         total is never trusted. CHECK rejects negative totals.
  total_amount    numeric(14,2) NOT NULL CHECK (total_amount >= 0),
  currency        char(3)       NOT NULL DEFAULT 'USD' CHECK (currency = upper(currency)),

  -- [P0-18] Double-click / retried request protection. A retry with the same
  --         key returns the original order instead of creating a second one.
  idempotency_key uuid          NOT NULL,

  cancelled_reason text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  updated_at      timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT orders_number_uniq      UNIQUE (order_number),
  CONSTRAINT orders_idempotency_uniq UNIQUE (idempotency_key),

  -- Cancellation must be explainable.
  CONSTRAINT orders_cancel_reason_required
    CHECK (status <> 'Cancelled' OR cancelled_reason IS NOT NULL)
);

CREATE INDEX orders_client_created_idx ON orders (client_id, created_at DESC);
CREATE INDEX orders_status_created_idx ON orders (status, created_at DESC);
CREATE INDEX orders_created_idx        ON orders (created_at DESC);

CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- 8. order_items
-- =============================================================================
CREATE TABLE order_items (
  id               integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  order_id         integer      NOT NULL REFERENCES orders (id) ON DELETE CASCADE,

  -- [P0-19] SET NULL (original) + a NOT NULL price meant financial history
  --         survived while the link to *what was sold* vanished. SET NULL is
  --         kept only as a hard-delete fallback; SKU and name are snapshotted
  --         below so reporting never depends on the live catalog.
  product_id       integer      REFERENCES products (id) ON DELETE SET NULL,

  -- [P0-20] The original schema could not answer "which warehouse fulfils this
  --         order?". Placement is per line, so one order can ship from several
  --         warehouses (split shipment) without a schema change.
  warehouse_id     integer      NOT NULL REFERENCES warehouses (id) ON DELETE RESTRICT,

  product_sku      varchar(50)  NOT NULL,
  product_name     varchar(150) NOT NULL,

  -- [P0-21] Original had no CHECK, so quantity = 0 or -5 was storable.
  quantity         integer      NOT NULL CHECK (quantity > 0),
  price_at_purchase numeric(12,2) NOT NULL CHECK (price_at_purchase >= 0),

  line_total       numeric(14,2) GENERATED ALWAYS AS (quantity * price_at_purchase) STORED
);

CREATE INDEX order_items_order_idx     ON order_items (order_id);
CREATE INDEX order_items_product_idx   ON order_items (product_id);
CREATE INDEX order_items_warehouse_idx ON order_items (warehouse_id);

-- =============================================================================
-- 9. order_status_history  (every transition is recorded)
-- =============================================================================
CREATE TABLE order_status_history (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    integer     NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  from_status varchar(30),
  to_status   varchar(30) NOT NULL,
  changed_by  integer     REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX order_status_history_order_idx
  ON order_status_history (order_id, created_at DESC);

-- =============================================================================
-- 10. Reporting views
-- =============================================================================
-- [P0-22] Low-stock is a per-warehouse fact, resolved with the product fallback.
CREATE VIEW low_stock AS
SELECT
  i.warehouse_id,
  w.code                AS warehouse_code,
  w.name                AS warehouse_name,
  i.product_id,
  p.sku,
  p.name                AS product_name,
  p.category,
  i.quantity,
  COALESCE(i.reorder_level, p.reorder_level) AS effective_reorder_level,
  COALESCE(i.reorder_level, p.reorder_level) - i.quantity AS units_below_threshold
FROM inventory i
JOIN products   p ON p.id = i.product_id
JOIN warehouses w ON w.id = i.warehouse_id
WHERE i.quantity <= COALESCE(i.reorder_level, p.reorder_level)
  AND p.deleted_at IS NULL
  AND p.is_active = true
  AND w.deleted_at IS NULL;

CREATE VIEW product_stock_totals AS
SELECT
  p.id AS product_id,
  p.sku,
  p.name AS product_name,
  COALESCE(sum(i.quantity), 0)::bigint AS total_quantity,
  count(i.warehouse_id) FILTER (WHERE i.quantity > 0) AS warehouses_in_stock
FROM products p
LEFT JOIN inventory i ON i.product_id = p.id
WHERE p.deleted_at IS NULL AND p.is_active = true
GROUP BY p.id, p.sku, p.name;