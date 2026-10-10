# Clew

*by ADK*

**Clew** (an old English word for a ball of thread used to guide someone out of a labyrinth) is an open-source database IDE in the spirit of DataGrip, for macOS and Windows.

- SQL: PostgreSQL, MySQL, MariaDB, SQLite, SQL Server, ClickHouse, DuckDB
- NoSQL: MongoDB, Redis
- Saved connections with environments, SSH tunnels, TLS and keychain-stored secrets
- SQL console with schema-aware completion, data grid with staged editing, document and key browsers
- Production safeguards: read-only by default, confirmed writes, blocked dangerous statements
- AI assistant, bring your own model: GitHub Copilot, Claude, OpenAI/Codex, any compatible endpoint, or a local model; edits land as a reviewable diff, and AI never runs SQL

> Status: designed and specified, implementation not started. See `openspec/changes/` for the plan and `design/` for the UX.

## Project layout

| Path | What |
|---|---|
| `design/` | UX source of truth: tokens, visual language, screen sources |
| `openspec/` | Specs and change proposals (OpenSpec) |
| `CLAUDE.md` | Build order and rules for coding agents |

## License

MIT (to be added with the first release).
