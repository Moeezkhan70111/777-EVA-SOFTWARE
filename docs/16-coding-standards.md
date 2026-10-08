# Coding Standards

## Architecture Rules
- Enforce Clean Architecture boundaries.
- Domain layer contains no framework or database dependencies.
- Application layer orchestrates use-cases only.
- Infrastructure layer implements ports/adapters.

## Code Quality
- TypeScript strict mode.
- Small focused files and modules.
- Clear naming for events, entities, and use-cases.
- No hidden side effects.

## Dependency Rules
- No direct module-to-module data mutation across contexts.
- Cross-context communication via event bus or explicit application services.

## Data Rules
- No hard deletes on core business data.
- production_events and audit_log are immutable.
- All write operations require correlation_id and actor metadata.

## Reliability Rules
- All multi-step writes are transactional.
- Any retry operation must be idempotent.
- Error handling must return user-safe messages and structured logs.

## Testing Rules
- Unit tests for domain invariants and parsers.
- Integration tests for repositories, projections, and sync.
- Migration tests required for schema changes.
