# Migration System

This project uses versioned migrations for both local SQLite and cloud Supabase schemas.

## Rules
- Never edit schema directly in production environments.
- Add a new migration for every schema change.
- Keep migration numbering strictly increasing.
- Include rollback script where safely reversible.

## Structure
- migrations/sqlite
- migrations/supabase

## Naming
- 001_initial_schema.up.sql
- 001_initial_schema.down.sql
- 002_add_x.up.sql
- 002_add_x.down.sql

## Execution
SQLite migrations run at app startup before services initialize.
Supabase migrations run in deployment pipeline before app release.
