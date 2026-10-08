# Deployment Guide

## Target Environment
- Windows desktop endpoints for factory workstations
- Central Supabase project for sync and analytics

## Release Workflow
1. Build signed desktop binary.
2. Run SQLite migration chain in staging.
3. Run Supabase migration chain in staging.
4. Execute smoke tests (scan, duplicate rejection, offline sync queue).
5. Promote Supabase migrations to production.
6. Roll out desktop release in waves by factory.

## Rollout Strategy
- Pilot factory first
- Canary workstation group
- Full factory rollout after stability window

## Rollback Strategy
- Keep previous installer available.
- If release issue occurs, roll back binary and retain DB compatibility window.
- Never roll back by deleting data.

## Post-Deploy Verification
- startup time
- scanner readiness
- local write transaction success
- pending sync queue behavior
- cloud sync and dashboard reflection
