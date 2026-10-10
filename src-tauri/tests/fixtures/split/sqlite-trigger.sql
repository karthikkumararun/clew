CREATE TRIGGER log_insert AFTER INSERT ON orders
BEGIN
  INSERT INTO log(msg) VALUES ('new order');
  UPDATE stats SET n = n + 1;
END;
SELECT count(*) FROM orders;
