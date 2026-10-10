/** Common functions every SQL dialect understands, with the signature shown in the popup. */
export interface Builtin {
  name: string;
  signature: string;
  kind: "aggregate" | "function";
}

const agg = (name: string, signature: string): Builtin => ({ name, signature, kind: "aggregate" });
const fn = (name: string, signature: string): Builtin => ({ name, signature, kind: "function" });

export const BUILTINS: Builtin[] = [
  agg("count", "(expr)"),
  agg("sum", "(expr)"),
  agg("avg", "(expr)"),
  agg("min", "(expr)"),
  agg("max", "(expr)"),
  fn("coalesce", "(a, b, …)"),
  fn("nullif", "(a, b)"),
  fn("cast", "(expr AS type)"),
  fn("lower", "(text)"),
  fn("upper", "(text)"),
  fn("length", "(text)"),
  fn("substring", "(text, from, len)"),
  fn("trim", "(text)"),
  fn("replace", "(text, from, to)"),
  fn("concat", "(a, b, …)"),
  fn("abs", "(n)"),
  fn("round", "(n, digits)"),
  fn("floor", "(n)"),
  fn("ceil", "(n)"),
  fn("now", "()"),
  fn("current_date", ""),
  fn("current_timestamp", ""),
  fn("extract", "(field FROM source)"),
  fn("date_trunc", "(field, source)"),
];

/** Dialect-specific additions, by driver id. */
export const BUILTINS_BY_DRIVER: Record<string, Builtin[]> = {
  postgres: [
    fn("make_interval", "(…)"),
    fn("to_char", "(value, format)"),
    fn("generate_series", "(start, stop)"),
    agg("string_agg", "(expr, delimiter)"),
    agg("array_agg", "(expr)"),
  ],
  mysql: [
    fn("ifnull", "(a, b)"),
    fn("date_format", "(date, format)"),
    agg("group_concat", "(expr)"),
  ],
  mariadb: [
    fn("ifnull", "(a, b)"),
    fn("date_format", "(date, format)"),
    agg("group_concat", "(expr)"),
  ],
  sqlite: [fn("ifnull", "(a, b)"), fn("strftime", "(format, time)"), agg("group_concat", "(expr)")],
  sqlserver: [fn("isnull", "(a, b)"), fn("getdate", "()"), fn("datediff", "(part, a, b)")],
};
