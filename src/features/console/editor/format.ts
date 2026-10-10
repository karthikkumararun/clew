import { format } from "sql-formatter";
import { formatterLanguage } from "./dialects";

/** One sensible default: upper-case keywords, two-space indent. Throws when the SQL can't be parsed. */
export function formatSql(sql: string, driver: string): string {
  return format(sql, {
    language: formatterLanguage(driver),
    keywordCase: "upper",
    tabWidth: 2,
    linesBetweenQueries: 1,
  });
}
