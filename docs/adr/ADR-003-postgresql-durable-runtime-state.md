# ADR-003 — PostgreSQL como estado durable del runtime

- **Estado:** Aceptado (R4-B)
- **Fecha:** 2026-09-22
- **Autoridad superior:** Constitución §25.12, §25.14; PRD §26–§28

## Contexto

Las tasks deben sobrevivir reinicios, ser reanudables y no duplicar efectos.
R3 dependía en parte de estado de sesión y summaries. El PRD recomienda
PostgreSQL y descarta Kafka/Redis como dependencias obligatorias del MVP.

## Decisión

- PostgreSQL (16 en local) es la **única** fuente autoritativa del estado de
  runtime. Ningún estado necesario para recuperar vive sólo en memoria.
- Acceso vía `pg` detrás de ports (`TaskRuntimeStore`, `AgentDefinitionStore`,
  `ObservationStore`) implementados sólo en `@r4/persistence-postgres`.
- Invariantes críticas duplicadas en el esquema, no sólo en código: una raíz por
  task, parent en la misma task, un run activo por task, unicidad de idempotencia,
  historia de transiciones sin ambigüedad, coherencia status/finished_at/failure.
- Concurrencia: row locks (`FOR UPDATE`) dentro de transacciones +
  `version` optimista expuesta a los llamadores (`expectedVersion`).
- Migraciones SQL forward-only propias (sin framework): checksum, advisory lock,
  una transacción por migración. La API nunca migra implícitamente.
- Historia suficiente para reconstruir transiciones (tabla append-only) sin
  event sourcing.
- JSONB sólo para documentos genuinamente extensibles.
- IDs UUIDv7 (ordenados por tiempo, sin coordinación).

## Alternativas descartadas

- **Event sourcing / framework de workflows:** sin necesidad demostrada (PRD §26).
- **Redis como fuente de verdad, Kafka:** fuera del MVP.
- **ORM:** oculta locking y SQL; el volumen actual no lo justifica.
- **Herramienta de migraciones externa:** 90 líneas cubren la necesidad actual.

## Consecuencias

- El outbox durable y el catálogo público de eventos quedan diferidos; hoy los
  eventos son sólo telemetría.
- Worker futuro: reclamación con `FOR UPDATE SKIP LOCKED` sobre el índice
  `(status, updated_at)` sin cambiar el modelo.

## Verificación

`tests/integration/migrations.test.ts` (BD vacía, idempotencia, concurrencia,
checksum, constraints), `tests/integration/restart-persistence.test.ts`
(reinicio de proceso), `tests/recovery/database-restart.test.ts` (reinicio del
servidor PostgreSQL con el proceso vivo).
