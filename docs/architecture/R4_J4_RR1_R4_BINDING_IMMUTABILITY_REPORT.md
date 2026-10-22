---
title: R4-J4 RR-1 R-4 — Inmutabilidad de la identidad del binding (implementación y validación sintética)
status: for-owner-review
date: 2026-10-22
---

# RR-1 R-4: inmutabilidad de la identidad de `channel_conversation_bindings`

```text
RR1_R4_TRIGGER_IMPLEMENTED            (rama feat/r4-j4-rr1-r4-binding-immutability, base main 3e04b4f; sin push ni PR)
RR1_R4_SYNTHETIC_VALIDATION_PASS
RR1_R4_MUTATIONS_5_OF_5_DETECTED
R4_HARNESS_UNCHANGED
NO_DEPLOYMENT
```

**Límites respetados:** solo local y sintético; sin despliegue, sin datos reales; sin cambios de TypeScript fuera de tests; sin tocar el harness (agent-kernel, task-runtime, capability-runtime, context-compiler, model-gateway, policy-engine, contracts, observability) ni `apps/worker`, `apps/api`, `apps/scheduler`.

## 1. Propósito

Volver irrepresentable el cambio de la identidad de un binding de conversación. Hoy ningún código cambia `channel`, `conversation_key`, `account_ref`, `recipient_ref` ni reasigna `task_id`; el trigger lo garantiza en la base. Es una precondición de la idempotencia del `confirm` de SEC-OTP (plan §4.4): el contexto que el dispatcher envía a la CIA (`channel`, `channelAccountRef`, `subjectRef`, `sessionRef`) sale del binding, y su `idempotency-key` (`confirmIdempotencyKey(channel, providerEventId)`) debe corresponder siempre al mismo contexto.

## 2. Fuente del contrato

- ADR-038 (`docs/adr/ADR-038-governed-document-outbound.md`, punto 5 de la migración): «`channel_conversation_bindings`: trigger que inmoviliza `task_id`, `channel`, `account_ref`, `recipient_ref` y `conversation_key`». ADR-038 sigue PROPOSED/DEFERRED; solo se implementa este punto, por el residuo R-4.
- `R4_J4_RR1_BINDING_RACE_ANALYSIS.md` §8, R-4.
- Única escritura legítima de identidad: `PostgresProductionStore.attachTask` (`set task_id = $2 where binding_id = $1 and (task_id is null or task_id = $2)`): asignación única desde null, o la misma.

**Numeración:** la `0011` del Core no estaba reservada (`R4_J3F_DOCUMENTARY_MERGE_RECONCILIATION.md` §3: «La primera migración Core que se autorice usa el siguiente número libre; si J3F se retoma después, renumera»). Las migraciones `0011_identity_verification_state`…`0014_*` viven en otro directorio con ids distintos; el ledger `r4_schema_migrations` es por id, y `migrate`/`migrationStatus` filtran por directorio, así que no hay choque ni dependencia de orden.

## 3. Implementación

Archivo nuevo: `packages/persistence-postgres/migrations/0011_binding_identity_immutability.sql` (Core, hacia adelante, sin reescritura de datos).

```sql
create function channel_conversation_bindings_identity_immutable() returns trigger language plpgsql as $$
begin
  if new.channel is distinct from old.channel then raise exception 'conversation binding % identity is immutable (channel)', old.binding_id using errcode = '55000'; end if;
  if new.conversation_key is distinct from old.conversation_key then raise exception 'conversation binding % identity is immutable (conversation_key)', old.binding_id using errcode = '55000'; end if;
  if new.account_ref is distinct from old.account_ref then raise exception 'conversation binding % identity is immutable (account_ref)', old.binding_id using errcode = '55000'; end if;
  if new.recipient_ref is distinct from old.recipient_ref then raise exception 'conversation binding % identity is immutable (recipient_ref)', old.binding_id using errcode = '55000'; end if;
  if old.task_id is not null and new.task_id is distinct from old.task_id then raise exception 'conversation binding % identity is immutable (task_id is assigned once)', old.binding_id using errcode = '55000'; end if;
  return new;
end $$;

create trigger channel_conversation_bindings_identity_immutable
  before update on channel_conversation_bindings
  for each row execute function channel_conversation_bindings_identity_immutable();
```

- SQLSTATE `55000` (`object_not_in_prerequisite_state`), el mismo de los triggers de inmutabilidad existentes (`action_ledger_immutable`, `memory_entries_append_only`, `action_executions_guard`…).
- `status`, `closed_at`, `closed_reason`, `last_inbound_at` y el resto de columnas no cambian de reglas.
- Sin cambio en el store: `attachTask` ya filtra la reasignación en su `where` (responde `binding_task_mismatch` antes de llegar al trigger), y ningún camino de producción provoca el error nuevo; no hace falta mapearlo a `PlatformError`.
- Compatibilidad worker/gateway: `coreSchemaHead()` pasa a `0011_binding_identity_immutability`, por lo que la compatibilidad declarada es `0011_binding_identity_immutability:sales-production@1`. Se actualizaron (con comentario) los inventarios/pins: `tests/integration/migrations.test.ts`, `migration-upgrade.test.ts`, `migration-upgrade-c2.test.ts`, `worker-readiness.test.ts`, `tests/recovery/worker-presence-process.test.ts`. Un despliegue requiere migrar antes de arrancar (como cualquier migración Core: gateway/worker/api/scheduler rechazan migraciones pendientes).

## 4. Pruebas

`tests/integration/binding-identity-immutability.test.ts` (PostgreSQL real, `LiveOpsTestbed` fresco, store e ingress reales):

| Test | Cubre |
|---|---|
| R4-T01 ×5 | `channel`, `conversation_key`, `account_ref`, `recipient_ref`, `task_id`: un UPDATE que conserva `binding_id` falla con 55000; la fila queda igual |
| R4-T02 | `task_id`: null→valor una vez; mismo valor de nuevo (`attachTask` idempotente y SQL directo); valor→otro y valor→null rechazados; `attachTask` con otra tarea sigue respondiendo `binding_task_mismatch` |
| R4-T03 ×2 | `touchBinding` y `closeBinding` funcionan; ingress real: mensaje → binding + tarea; cancelación cierra; nuevo mensaje abre un binding NUEVO |
| R4-T04 | `customer.get_context@3` con barrera dentro del doble de la CIA (patrón RR1-T06): con `resolve` en vuelo, reescribir `recipient_ref`/`account_ref` se rechaza; la capacidad termina `verified` y el sujeto enviado y el binding leído son los originales |
| R4-T05 | `VerificationConfirmDispatcher` real con `confirm` en vuelo (barrera): la reescritura se rechaza; el reintento envía exactamente la misma `idempotencyKey` y el mismo contexto; la expectativa queda `confirmed` |
| R4-T06 | Base migrada hasta `0010` (directorio temporal) con un binding abierto y uno cerrado escritos por el store real; `0011` se aplica sin error, las filas quedan idénticas, y después el trigger rige sobre ellas (cierre sigue permitido) |

Resultados (worktree `r4-j4-rr1-r4`, `npm ci` + `npm run build`):

| Suite | Resultado |
|---|---|
| build / typecheck / lint | OK |
| test:unit | 85 archivos ok (1 omitido); 1519 pasan, 4 omitidos |
| test:contract | 32 archivos; 443 pasan |
| test:integration | 41 ok, 2 fallaron, 1 omitido; 590 pasan, 3 fallan, 12 omitidos. Las 3 fallas (`run-failure-recovery.test.ts` ×2, `sales-deterministic-offer-canary.test.ts` ×1) son de tiempo/presupuesto bajo carga (corrían en paralelo con `test:mutation:rr1`); al re-ejecutar esos dos archivos con `--no-file-parallelism`: 26/26 pasan. Ninguno toca la identidad del binding |
| archivo nuevo aislado | 11/11 |
| test:sales | 4 archivos; 29 pasan |
| test:shadow | 1 archivo; 5 pasan |
| test:recovery (solo, al final) | 10 archivos ok, 1 falla: `production-bootstrap-process.test.ts` espera `registered: sales@3` y recibe `sales@3 … sales@8`. **Preexistente:** falla igual en `main` 3e04b4f (sin `0011`). `worker-presence-process.test.ts` (pin actualizado) pasa |
| test:mutation:rr1 | 5/5 detectadas |

## 5. Mutaciones

`tests/mutation/binding-immutability-mutations.mjs` (`npm run test:mutation:binding-immutability`): cada mutación elimina una regla del trigger en la migración; cada test se corre solo, por nombre; cada `LiveOpsTestbed`/base es nueva, así que se aplica la migración mutada (checksum nuevo). El original se restaura y se verifica byte a byte.

| Mutación | Tests que fallan |
|---|---|
| R4-M1 sin `channel` | R4-T01 channel |
| R4-M2 sin `conversation_key` | R4-T01 conversation_key |
| R4-M3 sin `account_ref` | R4-T01 account_ref, R4-T04, R4-T05 |
| R4-M4 sin `recipient_ref` | R4-T01 recipient_ref, R4-T04, R4-T05, R4-T06 |
| R4-M5 `task_id` reasignable | R4-T01 task_id, R4-T02, R4-T06 |

Resultado: **5/5 detectadas; fuentes restauradas.**

## 6. Residuos

- `binding_id` (PK) no está cubierto: el contrato no lo nombra. Un UPDATE de la PK lo impediría hoy solo la FK de `inbound_events`/`outbound_messages` cuando hay filas hijas.
- DELETE no está cubierto: el contrato no lo nombra; no se agregaron reglas de borrado.
- `confirmIdempotencyKey` deriva de `(channel, providerEventId)`, no de todo el binding; la integridad del contexto (`channelAccountRef`, `subjectRef`, `sessionRef`) la aporta el trigger (R4-T05).
- Fallas preexistentes/ambientales anotadas en §4 (no causadas por este cambio).
- Sin evidencia en base real ni despliegue.

## 7. Preguntas al owner

1. ¿Se congela también `binding_id` (PK)?
2. ¿Se prohíbe DELETE en `channel_conversation_bindings` (hoy ningún código borra)?
3. ¿Se congelan otras columnas fijadas al abrir (`autonomy`, `eligibility_reason`, `rollout_fingerprint`, `profile`, `profile_fingerprint`, `created_at`)? ADR-038 no las incluye.
4. Numeración: esta rama toma la `0011` del Core; si J3F/ADR-038 se retoma, renumera según la reconciliación J3F §3. Confirmar.
5. Despliegue: la nueva cabeza cambia la compatibilidad worker/gateway a `0011_binding_identity_immutability:…`; gateway y workers deben desplegarse junto con la migración.
