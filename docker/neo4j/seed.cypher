// Seed for the graph QA profile (docker compose --profile graph). Test data only.
// Loaded once by healthcheck.sh through cypher-shell; every statement is idempotent. The marker
// (Category Lighting gets seeded = true) is written last, so a half-loaded seed is completed on the next health check.
// Shape: User -[PLACED]-> Order -[CONTAINS]-> Product -[IN_CATEGORY]-> Category,
// User -[BOUGHT]-> Product, User -[FOLLOWS]-> User.
CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE;
CREATE CONSTRAINT product_sku IF NOT EXISTS FOR (p:Product) REQUIRE p.sku IS UNIQUE;
CREATE INDEX product_name IF NOT EXISTS FOR (p:Product) ON (p.name);
CREATE INDEX order_placed IF NOT EXISTS FOR (o:Order) ON (o.placed_at);

UNWIND [
  {id: 1, name: 'Ada Lovelace',    email: 'ada@example.com',    plan: 'pro'},
  {id: 2, name: 'Grace Hopper',    email: 'grace@example.com',  plan: 'pro'},
  {id: 3, name: 'Linus Torvalds',  email: 'linus@example.com',  plan: 'free'},
  {id: 4, name: 'Margaret Hamilton', email: 'margaret@example.com', plan: 'free'},
  {id: 5, name: 'Alan Turing',     email: 'alan@example.com',   plan: 'free'}
] AS row
MERGE (u:User {id: row.id}) SET u.name = row.name, u.email = row.email, u.plan = row.plan;

UNWIND ['Lighting', 'Furniture', 'Kitchen'] AS name
MERGE (:Category {name: name});

UNWIND [
  {sku: 'LMP-001', name: 'Brass Lamp',     price: 39.5, category: 'Lighting'},
  {sku: 'LMP-002', name: 'Desk Lamp',      price: 24.0, category: 'Lighting'},
  {sku: 'FRN-001', name: 'Oak Shelf',      price: 89.0, category: 'Furniture'},
  {sku: 'FRN-002', name: 'Reading Chair',  price: 149.0, category: 'Furniture'},
  {sku: 'KIT-001', name: 'Kettle',         price: 32.0, category: 'Kitchen'},
  {sku: 'KIT-002', name: 'Teapot',         price: 18.5, category: 'Kitchen'}
] AS row
MERGE (p:Product {sku: row.sku}) SET p.name = row.name, p.price = row.price
WITH p, row
MATCH (c:Category {name: row.category})
MERGE (p)-[:IN_CATEGORY]->(c);

// 9007199254740993 = 2^53 + 1: the first integer a JavaScript number cannot hold.
UNWIND [
  {ref: 9007199254740993, id: 'O-1001', user: 1, total: 63.5,  placed_at: date('2025-03-02'), skus: ['LMP-001', 'LMP-002']},
  {ref: 1002, id: 'O-1002', user: 2, total: 39.5,  placed_at: date('2025-03-05'), skus: ['LMP-001']},
  {ref: 1003, id: 'O-1003', user: 3, total: 238.0, placed_at: date('2025-03-09'), skus: ['FRN-001', 'FRN-002']},
  {ref: 1004, id: 'O-1004', user: 1, total: 50.5,  placed_at: date('2025-03-11'), skus: ['KIT-001', 'KIT-002']}
] AS row
MERGE (o:Order {id: row.id}) SET o.reference = row.ref, o.total = row.total, o.placed_at = row.placed_at
WITH o, row
MATCH (u:User {id: row.user})
MERGE (u)-[:PLACED]->(o)
WITH o, row
UNWIND row.skus AS sku
MATCH (p:Product {sku: sku})
MERGE (o)-[:CONTAINS]->(p);

UNWIND [
  {user: 1, sku: 'LMP-001', qty: 1}, {user: 1, sku: 'LMP-002', qty: 1},
  {user: 2, sku: 'LMP-001', qty: 2}, {user: 3, sku: 'FRN-001', qty: 1},
  {user: 3, sku: 'FRN-002', qty: 1}, {user: 1, sku: 'KIT-001', qty: 1},
  {user: 1, sku: 'KIT-002', qty: 1}, {user: 4, sku: 'KIT-001', qty: 3}
] AS row
MATCH (u:User {id: row.user}), (p:Product {sku: row.sku})
MERGE (u)-[b:BOUGHT]->(p) SET b.qty = row.qty;

UNWIND [[1, 2], [2, 3], [3, 1], [4, 1]] AS pair
MATCH (a:User {id: pair[0]}), (b:User {id: pair[1]})
MERGE (a)-[:FOLLOWS]->(b);

MATCH (c:Category {name: 'Lighting'}) SET c.seeded = true;
