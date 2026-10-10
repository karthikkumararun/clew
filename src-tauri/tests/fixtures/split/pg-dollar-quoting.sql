-- create a helper, then use it
CREATE FUNCTION add_one(i int) RETURNS int AS $$
BEGIN
  RETURN i + 1; -- inner; semicolon
END;
$$ LANGUAGE plpgsql;

SELECT add_one(41);
