-- StockPulse demo data for Supabase SQL Editor.
--
-- Run src/db/migrations/001_init.sql first to create the schema, then run this
-- file. This seeds the application's public.users table, not Supabase Auth.
-- Demo passwords are for development/demo use only.
--
-- Safe to rerun: existing matching users, warehouses, products, stock rows and
-- orders are left in place. The script does not reset or overwrite your data.

BEGIN;

DO $demo_seed$
DECLARE
  demo_user record;
  stock_row record;
  v_admin_id integer;
  v_nairobi_manager_id integer;
  v_lagos_manager_id integer;
  v_staff_id integer;
  v_client_id integer;
  v_nairobi_id integer;
  v_lagos_id integer;
  v_dubai_id integer;
  v_product_id integer;
  v_inventory_id integer;
  v_keyboard_id integer;
  v_monitor_id integer;
  v_cable_id integer;
  v_dock_id integer;
  v_order_id integer;
  v_available integer;
BEGIN
  -- These bcrypt hashes are compatible with the application's bcryptjs
  -- password verifier (BCRYPT_ROUNDS=12).
  FOR demo_user IN
    SELECT * FROM (VALUES
      ('Ada Okafor', 'admin@stockpulse.dev', '$2a$12$V4YAQyXGzI.VPiuPr6.rgO28BekJrXK8m7A41ygdKAwZp/zbjj3Fy', 'Admin'),
      ('Bruno Mwangi', 'manager.nairobi@stockpulse.dev', '$2a$12$ylwtZmzeWSp7jUKECZL0RO56TXns12jZaolWRgfSC6Nuft9fj5coK', 'Manager'),
      ('Chidi Balewa', 'manager.lagos@stockpulse.dev', '$2a$12$yyC7N0tlyWjnLlTL6b4C.eyEqk/v6hGeElKtCb0WzsNG8zcScpcrG', 'Manager'),
      ('Dana Kimani', 'staff.nairobi@stockpulse.dev', '$2a$12$zf5V7NM/DlFx8soOq4wn1uv/HFtqG4EqHorxutvJJN9WfGkPk0QqG', 'Staff'),
      ('Acme Procurement', 'client@acme.dev', '$2a$12$2RBoOAiWhiFuR.3cgu8yGOAfY7IHNAAnpTRhUAZ7acgyRfkmyI2um', 'Client')
    ) AS users(name, email, password_hash, role)
  LOOP
    INSERT INTO users (name, email, password_hash, role)
    SELECT demo_user.name, demo_user.email, demo_user.password_hash, demo_user.role
    WHERE NOT EXISTS (
      SELECT 1 FROM users
      WHERE lower(email) = lower(demo_user.email) AND deleted_at IS NULL
    )
    ON CONFLICT DO NOTHING;
  END LOOP;

  SELECT id INTO STRICT v_admin_id FROM users WHERE lower(email) = 'admin@stockpulse.dev' AND deleted_at IS NULL;
  SELECT id INTO STRICT v_nairobi_manager_id FROM users WHERE lower(email) = 'manager.nairobi@stockpulse.dev' AND deleted_at IS NULL;
  SELECT id INTO STRICT v_lagos_manager_id FROM users WHERE lower(email) = 'manager.lagos@stockpulse.dev' AND deleted_at IS NULL;
  SELECT id INTO STRICT v_staff_id FROM users WHERE lower(email) = 'staff.nairobi@stockpulse.dev' AND deleted_at IS NULL;
  SELECT id INTO STRICT v_client_id FROM users WHERE lower(email) = 'client@acme.dev' AND deleted_at IS NULL;

  INSERT INTO warehouses (code, name, location, manager_id)
  SELECT 'WH-NBO', 'Nairobi Central', 'Mombasa Road, Nairobi, KE', v_nairobi_manager_id
  WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE upper(code) = 'WH-NBO');
  INSERT INTO warehouses (code, name, location, manager_id)
  SELECT 'WH-LAG', 'Lagos Distribution', 'Apapa, Lagos, NG', v_lagos_manager_id
  WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE upper(code) = 'WH-LAG');
  INSERT INTO warehouses (code, name, location, manager_id)
  SELECT 'WH-DXB', 'Dubai Fulfilment', 'Jebel Ali Free Zone, Dubai, AE', NULL
  WHERE NOT EXISTS (SELECT 1 FROM warehouses WHERE upper(code) = 'WH-DXB');

  SELECT id INTO STRICT v_nairobi_id FROM warehouses WHERE upper(code) = 'WH-NBO';
  SELECT id INTO STRICT v_lagos_id FROM warehouses WHERE upper(code) = 'WH-LAG';
  SELECT id INTO STRICT v_dubai_id FROM warehouses WHERE upper(code) = 'WH-DXB';

  INSERT INTO user_warehouses (user_id, warehouse_id, granted_by)
  VALUES
    (v_nairobi_manager_id, v_nairobi_id, v_admin_id),
    (v_lagos_manager_id, v_lagos_id, v_admin_id),
    (v_staff_id, v_nairobi_id, v_admin_id)
  ON CONFLICT DO NOTHING;

  FOR demo_user IN
    SELECT * FROM (VALUES
      ('SP-KEYB-01', 'Mechanical Keyboard K80', 'Peripherals', 89.99::numeric, 20),
      ('SP-MOUSE-02', 'Wireless Mouse M2', 'Peripherals', 39.50::numeric, 25),
      ('SP-MON-27-03', '27in 4K Monitor', 'Displays', 249.00::numeric, 10),
      ('SP-DOCK-04', 'USB-C Docking Station', 'Accessories', 129.95::numeric, 15),
      ('SP-HDD-2T-05', '2TB External Drive', 'Storage', 109.00::numeric, 12),
      ('SP-ROUT-06', 'Enterprise Router R900', 'Networking', 459.00::numeric, 5),
      ('SP-CABLE-07', 'USB-C Cable 2m', 'Accessories', 12.75::numeric, 100),
      ('SP-LAMP-08', 'LED Desk Lamp', 'Office', 34.20::numeric, 30)
    ) AS products(sku, name, category, unit_price, reorder_level)
  LOOP
    INSERT INTO products (sku, name, category, unit_price, reorder_level)
    SELECT demo_user.sku, demo_user.name, demo_user.category, demo_user.unit_price, demo_user.reorder_level
    WHERE NOT EXISTS (
      SELECT 1 FROM products
      WHERE upper(sku) = upper(demo_user.sku) AND deleted_at IS NULL
    )
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- Opening stock mirrors src/db/seed.js. Existing stock is not overwritten.
  FOR stock_row IN
    SELECT w.code, p.sku, s.quantity
    FROM (VALUES
      ('WH-NBO', 'SP-KEYB-01', 45), ('WH-NBO', 'SP-MOUSE-02', 8),
      ('WH-NBO', 'SP-MON-27-03', 12), ('WH-NBO', 'SP-DOCK-04', 3),
      ('WH-NBO', 'SP-CABLE-07', 220), ('WH-LAG', 'SP-KEYB-01', 20),
      ('WH-LAG', 'SP-MOUSE-02', 60), ('WH-LAG', 'SP-HDD-2T-05', 15),
      ('WH-LAG', 'SP-ROUT-06', 4), ('WH-LAG', 'SP-CABLE-07', 40),
      ('WH-DXB', 'SP-MON-27-03', 25), ('WH-DXB', 'SP-DOCK-04', 40),
      ('WH-DXB', 'SP-ROUT-06', 9), ('WH-DXB', 'SP-LAMP-08', 5),
      ('WH-DXB', 'SP-HDD-2T-05', 30)
    ) AS s(warehouse_code, sku, quantity)
    JOIN warehouses w ON upper(w.code) = s.warehouse_code
    JOIN products p ON upper(p.sku) = s.sku AND p.deleted_at IS NULL
  LOOP
    SELECT id INTO STRICT v_product_id
    FROM products WHERE upper(sku) = stock_row.sku AND deleted_at IS NULL;

    INSERT INTO inventory (warehouse_id, product_id, quantity)
    SELECT
      CASE stock_row.code
        WHEN 'WH-NBO' THEN v_nairobi_id
        WHEN 'WH-LAG' THEN v_lagos_id
        ELSE v_dubai_id
      END,
      v_product_id,
      stock_row.quantity
    ON CONFLICT (warehouse_id, product_id) DO NOTHING
    RETURNING id INTO v_inventory_id;

    IF v_inventory_id IS NOT NULL THEN
      INSERT INTO inventory_transactions
        (warehouse_id, product_id, delta, reason, note, created_by)
      VALUES
        (CASE stock_row.code
           WHEN 'WH-NBO' THEN v_nairobi_id
           WHEN 'WH-LAG' THEN v_lagos_id
           ELSE v_dubai_id
         END,
         v_product_id, stock_row.quantity, 'receipt', 'Opening stock (demo seed)', v_admin_id);
    END IF;
    v_inventory_id := NULL;
  END LOOP;

  -- Add the two example orders only to a database with no existing orders,
  -- matching the Node.js seed's non-destructive behavior.
  IF NOT EXISTS (SELECT 1 FROM orders) THEN
    SELECT id INTO STRICT v_keyboard_id FROM products WHERE upper(sku) = 'SP-KEYB-01' AND deleted_at IS NULL;
    SELECT id INTO STRICT v_monitor_id FROM products WHERE upper(sku) = 'SP-MON-27-03' AND deleted_at IS NULL;
    SELECT id INTO STRICT v_cable_id FROM products WHERE upper(sku) = 'SP-CABLE-07' AND deleted_at IS NULL;
    SELECT id INTO STRICT v_dock_id FROM products WHERE upper(sku) = 'SP-DOCK-04' AND deleted_at IS NULL;

    SELECT quantity INTO STRICT v_available
    FROM inventory WHERE warehouse_id = v_nairobi_id AND product_id = v_keyboard_id;
    IF v_available < 5 THEN
      RAISE EXCEPTION 'Not enough Nairobi keyboard stock for the demo order (available: %)', v_available;
    END IF;
    SELECT quantity INTO STRICT v_available
    FROM inventory WHERE warehouse_id = v_dubai_id AND product_id = v_monitor_id;
    IF v_available < 2 THEN
      RAISE EXCEPTION 'Not enough Dubai monitor stock for the demo order (available: %)', v_available;
    END IF;

    INSERT INTO orders (order_number, client_id, status, total_amount, currency, idempotency_key)
    VALUES (
      'SO-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('order_number_seq')::text, 6, '0'),
      v_client_id, 'Pending',
      (SELECT 5 * unit_price FROM products WHERE id = v_keyboard_id)
        + (SELECT 2 * unit_price FROM products WHERE id = v_monitor_id),
      'USD', '67f5f7e0-b792-4a86-91c6-cbcf15909b01'
    )
    RETURNING id INTO v_order_id;

    INSERT INTO order_items
      (order_id, product_id, warehouse_id, product_sku, product_name, quantity, price_at_purchase)
    SELECT v_order_id, p.id, lines.warehouse_id, p.sku, p.name, lines.quantity, p.unit_price
    FROM (VALUES (v_keyboard_id, v_nairobi_id, 5), (v_monitor_id, v_dubai_id, 2))
      AS lines(product_id, warehouse_id, quantity)
    JOIN products p ON p.id = lines.product_id;

    UPDATE inventory SET quantity = quantity - 5 WHERE warehouse_id = v_nairobi_id AND product_id = v_keyboard_id;
    UPDATE inventory SET quantity = quantity - 2 WHERE warehouse_id = v_dubai_id AND product_id = v_monitor_id;

    INSERT INTO inventory_transactions
      (warehouse_id, product_id, delta, reason, ref_type, ref_id, created_by)
    VALUES
      (v_nairobi_id, v_keyboard_id, -5, 'sale', 'order', v_order_id, v_client_id),
      (v_dubai_id, v_monitor_id, -2, 'sale', 'order', v_order_id, v_client_id);
    INSERT INTO order_status_history (order_id, from_status, to_status, changed_by)
    VALUES (v_order_id, NULL, 'Pending', v_client_id);

    SELECT quantity INTO STRICT v_available
    FROM inventory WHERE warehouse_id = v_nairobi_id AND product_id = v_cable_id;
    IF v_available < 25 THEN
      RAISE EXCEPTION 'Not enough Nairobi cable stock for the demo order (available: %)', v_available;
    END IF;
    SELECT quantity INTO STRICT v_available
    FROM inventory WHERE warehouse_id = v_dubai_id AND product_id = v_dock_id;
    IF v_available < 1 THEN
      RAISE EXCEPTION 'Not enough Dubai docking-station stock for the demo order (available: %)', v_available;
    END IF;

    INSERT INTO orders (order_number, client_id, status, total_amount, currency, idempotency_key)
    VALUES (
      'SO-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('order_number_seq')::text, 6, '0'),
      v_client_id, 'Pending',
      (SELECT 25 * unit_price FROM products WHERE id = v_cable_id)
        + (SELECT unit_price FROM products WHERE id = v_dock_id),
      'USD', '67f5f7e0-b792-4a86-91c6-cbcf15909b02'
    )
    RETURNING id INTO v_order_id;

    INSERT INTO order_items
      (order_id, product_id, warehouse_id, product_sku, product_name, quantity, price_at_purchase)
    SELECT v_order_id, p.id, lines.warehouse_id, p.sku, p.name, lines.quantity, p.unit_price
    FROM (VALUES (v_cable_id, v_nairobi_id, 25), (v_dock_id, v_dubai_id, 1))
      AS lines(product_id, warehouse_id, quantity)
    JOIN products p ON p.id = lines.product_id;

    UPDATE inventory SET quantity = quantity - 25 WHERE warehouse_id = v_nairobi_id AND product_id = v_cable_id;
    UPDATE inventory SET quantity = quantity - 1 WHERE warehouse_id = v_dubai_id AND product_id = v_dock_id;

    INSERT INTO inventory_transactions
      (warehouse_id, product_id, delta, reason, ref_type, ref_id, created_by)
    VALUES
      (v_nairobi_id, v_cable_id, -25, 'sale', 'order', v_order_id, v_client_id),
      (v_dubai_id, v_dock_id, -1, 'sale', 'order', v_order_id, v_client_id);
    INSERT INTO order_status_history (order_id, from_status, to_status, changed_by)
    VALUES (v_order_id, NULL, 'Pending', v_client_id);
  END IF;
END;
$demo_seed$;

COMMIT;

-- Demo logins (development/demo use only):
-- Admin:   admin@stockpulse.dev / AdminPass1234
-- Manager: manager.nairobi@stockpulse.dev / ManagerPass1234
-- Manager: manager.lagos@stockpulse.dev / ManagerPass1234
-- Staff:   staff.nairobi@stockpulse.dev / StaffPass1234
-- Client:  client@acme.dev / ClientPass1234
