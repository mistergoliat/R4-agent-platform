---
title: R4-J4 RR-1 R-4 — Inmutabilidad de la identidad del binding (implementación y validación sintética)
status: owner-decisions-applied
date: 2026-10-22
mandate: R4-J4-R5-OWNER-REVIEW-AND-MERGE-11
---

# RR-1 R-4: inmutabilidad de la identidad de `channel_conversation_bindings`

```text
RR1_R4_TRIGGER_IMPLEMENTED            (rama feat/r4-j4-rr1-r4-binding-immutability, rebasada sobre main 485df2b)
RR1_R4_OWNER_DECISIONS_APPLIED        (mandato R4-J4-R5-OWNER-REVIEW-AND-MERGE-11)
RR1_R4_SYNTHETIC_VALIDATION_PASS
RR1_R4_MUTATIONS_12_OF_12_DETECTED
R4_HARNESS_UNCHANGED
NO_DEPLOYMENT                         (el merge no aplica la migración en ningún entorno; §3.3)
```

**Límites respetados:** solo local y sintético; sin despliegue, sin datos reales; sin cambios de TypeScript fuera de tests; sin tocar el harness (agent-kernel, task-runtime, capability-runtime, context-compiler, model-gateway, policy-engine, contracts, observability) ni `apps/worker`, `apps/api`, `apps/scheduler`.

## 1. Propósito y decisiones del owner

Volver irrepresentable el cambio de la identidad de un binding de conversación. Es una precondición de la idempotencia del `confirm` de SEC-OTP (plan §4.4): el contexto que el dispatcher envía a la CIA (`channel`, `channelAccountRef`, `subjectRef`, `sessionRef`) sale del binding, y su `idempotency-key` (`confirmIdempotencyKey(channel, providerEventId)`) debe corresponder siempre al mismo contexto.

Decisiones del owner (mandato R4-J4-R5-OWNER-REVIEW-AND-MERGE-11), todas aplicadas:

| Decisión | Regla del trigger |
|---|---|
| `binding_id` inmutable desde el INSERT | `new.binding_id is distinct from old.binding_id` → 55000 |
| `channel`, `conversation_key`, `account_ref`, `recipient_ref`, `created_at` inmutables | una regla por columna, `is distinct from` |
| `task_id`: de NULL a un valor exactamente una vez; después no cambia ni vuelve a NULL | `old.task_id is not null and new.task_id is distinct from old.task_id` (repetir el mismo valor es un no-op) |
| Ciclo de vida solo por sus transiciones monótonas | `closed` es final (`status`, `closed_at`, `closed_reason` no cambian una vez cerrado); `closed_reason` solo lo escribe el cierre; `last_inbound_at` no retrocede ni vuelve a NULL |
| DELETE ordinario prohibido; la purga histórica requiere una política D7 aprobada aparte | `before update or delete`; `tg_op = 'DELETE'` → 55000 |

Todas las comparaciones son NULL-safe (`is distinct from`; la de `last_inbound_at` trata NULL explícitamente).

## 2. Fuente del contrato y numeración

- ADR-038 (punto 5 de la migración): «`channel_conversation_bindings`: trigger que inmoviliza `task_id`, `channel`, `account_ref`, `recipient_ref` y `conversation_key`». ADR-038 sigue PROPOSED/DEFERRED; solo se implementa este punto, ampliado por las decisiones del owner (§1).
- `R4_J4_RR1_BINDING_RACE_ANALYSIS.md` §8, R-4.
- Escrituras legítimas (únicas en el código, `PostgresProductionStore`): `attachTask` (asignación única), `closeBinding` (`where status = 'open'`), `touchBinding` (`greatest(...)`). Ninguna borra.

**Auditoría de numeración (2026-10-22, sobre `main` `485df2b`).**
- Core en `main`: `0001`–`0005`, `0007`–`0010` (la `0006` es del pack Sales, `agents/sales/migrations`, otro ledger por directorio).
- Ramas remotas: ninguna otra rama define `packages/persistence-postgres/migrations/0011_*` ni superior; las únicas migraciones nuevas en ramas pendientes son esta.
- J3F: `R4_J3F_DOCUMENTARY_MERGE_RECONCILIATION.md` §3 — la `0011` no está reservada; «la primera migración Core que se autorice usa el siguiente número libre; si J3F se retoma después, renumera». ADR-038 y el diseño J3F lo repiten.
- Las migraciones `0011_identity_verification_state`…`0014_*` viven en `adapters/domains/identity/verification/migrations`, con ids distintos; el ledger `r4_schema_migrations` es por id y `migrate`/`migrationStatus` filtran por directorio: sin choque.
- Conclusión: `0011_binding_identity_immutability` es válida; no se renumera. La migración nunca se fusionó ni se aplicó fuera de bases de prueba efímeras, así que modificarla antes del merge no rompe ningún ledger.

## 3. Implementación

### 3.1 Migración

`packages/persistence-postgres/migrations/0011_binding_identity_immutability.sql` (Core, hacia adelante, sin reescritura de datos):

```sql
create function channel_conversation_bindings_identity_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'conversation binding % cannot be deleted (a historical purge needs an approved D7 policy)', ...;
  if new.binding_id is distinct from old.binding_id then raise exception '... identity is immutable (binding_id)', ...;
  -- channel, conversation_key, account_ref, recipient_ref, created_at: igual
  if old.task_id is not null and new.task_id is distinct from old.task_id then raise exception '... (task_id is assigned once)', ...;
  if old.status = 'closed' and (new.status, new.closed_at, new.closed_reason) is distinct from (old.status, old.closed_at, old.closed_reason) then raise exception '... lifecycle is monotonic (closed is final)', ...;
  if new.status = 'open' and new.closed_reason is distinct from old.closed_reason then raise exception '... (closed_reason is set only by the closure)', ...;
  if old.last_inbound_at is not null and (new.last_inbound_at is null or new.last_inbound_at < old.last_inbound_at) then raise exception '... (last_inbound_at never moves back)', ...;
  return new;
end $$;

create trigger channel_conversation_bindings_identity_immutable
  before update or delete on channel_conversation_bindings
  for each row execute function channel_conversation_bindings_identity_immutable();
```

- SQLSTATE `55000`, el mismo de los triggers de inmutabilidad existentes (`memory_entries_append_only`, `context_snapshots_immutable`, …).
- Columnas de cohorte (`autonomy`, `eligibility_reason`, `rollout_fingerprint`, `profile`, `profile_fingerprint`): sin cambio de reglas (el owner no las incluyó; ningún código las actualiza).
- Sin cambio en el store: sus tres escrituras ya cumplen las reglas, y ningún camino de producción provoca los errores nuevos.
- **TRUNCATE.** No es una operación de fila y el trigger de fila no lo intercepta (mismo comportamiento que `context_snapshots`). El único TRUNCATE del repositorio es la purga verificada del canary sintético aislado (`purgeCanary`, D7 del canary, decisión del owner 2026-10-22, PR #22), que rechaza cualquier base que no sea ese canary. No es una purga histórica de datos de producción; esa sigue requiriendo su política D7.
- Compatibilidad worker/gateway: `coreSchemaHead()` pasa a `0011_binding_identity_immutability`. Se actualizaron los inventarios/pins: `tests/integration/migrations.test.ts`, `migration-upgrade.test.ts`, `migration-upgrade-c2.test.ts`, `worker-readiness.test.ts`, `tests/recovery/worker-presence-process.test.ts`.

### 3.2 Rebase

La rama se rebasó sobre `main` `485df2b` (PR #20, solo documentos): sin conflictos.

### 3.3 El merge no aplica la migración

- El repositorio no tiene CI/CD (`.github/workflows` no existe; el único check es GitGuardian).
- `migrate()` solo se invoca desde el CLI explícito `npm run db:migrate` (`apps/api/src/migrate.ts`), desde `sales:canary init` (base del canary aislado) y desde las bases de prueba.
- worker, api, scheduler y gateway **no migran**: con migraciones pendientes se niegan a arrancar (`schema_not_current`, `apps/worker/src/platform.ts`). Desplegar código nuevo sin migrar no arranca; migrar exige una orden explícita del operador.
- Por lo tanto, el merge no aplica `0011` en EC2 ni en ninguna base persistente. No se desplegó.

## 4. Pruebas

`tests/integration/binding-identity-immutability.test.ts` (PostgreSQL real, `LiveOpsTestbed` fresco, store e ingress reales):

| Test | Cubre |
|---|---|
| R4-T01 ×7 | `binding_id`, `channel`, `conversation_key`, `account_ref`, `recipient_ref`, `created_at`, `task_id`: un UPDATE que conserva `binding_id` en el `where` falla con 55000; la fila queda igual |
| R4-T02 | `task_id`: null→valor una vez; mismo valor de nuevo (`attachTask` idempotente y SQL directo); valor→otro y valor→null rechazados; `attachTask` con otra tarea sigue respondiendo `binding_task_mismatch` |
| R4-T03 ×2 | `touchBinding` y `closeBinding` funcionan; ingress real: mensaje → binding + tarea; cancelación cierra; nuevo mensaje abre un binding NUEVO |
| R4-T04 | `customer.get_context@3` con `resolve` de la CIA en vuelo: reescribir `recipient_ref`/`account_ref` se rechaza; la capacidad lee la identidad original |
| R4-T05 | `VerificationConfirmDispatcher` real con `confirm` en vuelo: la reescritura se rechaza; el reintento envía la misma `idempotencyKey` y el mismo contexto; la expectativa queda `confirmed` (**confirmación CIA idempotente**) |
| R4-T06 | **Upgrade**: base migrada hasta `0010` con un binding abierto y uno cerrado escritos por el store real; `0011` se aplica, las filas quedan idénticas, y después rigen `binding_id`, `recipient_ref`, `task_id`, DELETE y «closed es final» sobre ellas; el cierre sigue permitido |
| R4-T07 ×3 | Ciclo de vida: reabrir, otro `closed_at` y otro/NULL `closed_reason` en un binding cerrado se rechazan y un segundo `closeBinding` es no-op; `closed_reason` en un binding abierto se rechaza; `last_inbound_at` hacia atrás o a NULL se rechaza, hacia adelante (incluso cerrado) se acepta |
| R4-T08 | DELETE de un binding abierto y de uno cerrado, sin filas dependientes (ninguna FK responde antes): 55000, la fila queda |
| R4-T09 ×2 | **Concurrencia**: cuatro asignaciones de `task_id` SQL concurrentes y sin la guarda del store → exactamente una confirma, las otras reciben 55000 del trigger; cierres y `touch` concurrentes → un cierre gana y queda final, `last_inbound_at` termina en el máximo |

Resultados: ver §7.

## 5. Mutaciones

`tests/mutation/binding-immutability-mutations.mjs` (`npm run test:mutation:binding-immutability`): cada mutación elimina una regla del trigger; cada test se corre solo, por nombre; cada base es nueva, así que se aplica la migración mutada. El original se restaura y se verifica byte a byte.

| Mutación | Tests que deben fallar |
|---|---|
| R4-M1 sin `channel` | R4-T01 channel |
| R4-M2 sin `conversation_key` | R4-T01 conversation_key |
| R4-M3 sin `account_ref` | R4-T01 account_ref, R4-T04, R4-T05 |
| R4-M4 sin `recipient_ref` | R4-T01 recipient_ref, R4-T04, R4-T05, R4-T06 |
| R4-M5 `task_id` reasignable | R4-T01 task_id, R4-T02, R4-T06, R4-T09 (asignaciones) |
| R4-M6 sin `binding_id` | R4-T01 binding_id, R4-T06 |
| R4-M7 sin `created_at` | R4-T01 created_at |
| R4-M8 sin la regla de DELETE | R4-T08, R4-T06 |
| R4-M9 un binding cerrado puede cambiar | R4-T07 closed is final, R4-T06 |
| R4-M10 `closed_reason` en un binding abierto | R4-T07 closed_reason |
| R4-M11 `last_inbound_at` puede retroceder | R4-T07 last_inbound_at |
| R4-M12 el trigger no se dispara en DELETE | R4-T08, R4-T06 |

Resultado: ver §7.

## 6. Residuos

- `confirmIdempotencyKey` deriva de `(channel, providerEventId)`, no de todo el binding; la integridad del contexto la aporta el trigger (R4-T05).
- TRUNCATE queda fuera del trigger de fila (§3.1); su único uso es la purga del canary sintético aislado.
- Una purga histórica de bindings de producción necesita una política D7 aprobada y su propia migración o procedimiento; hoy no existe.
- Sin evidencia en base real ni despliegue. Cuando se despliegue, la migración se aplica explícitamente (`db:migrate`) antes de arrancar gateway y workers.

## 7. Resultados

Corrida del candidato `081e4f1` (rebasado sobre `main` `485df2b`), worktree `r4-j4-rr1-r4`, PostgreSQL local, en serie (recovery al final y solo):

| Suite | Resultado |
|---|---|
| build / lint / typecheck | OK |
| test:unit | 1519 pasan, 4 omitidos |
| test:contract | 443/443 |
| test:integration | 43 archivos ok (1 omitido); **601 pasan**, 12 omitidos, 0 fallos |
| archivo nuevo aislado | 19/19 |
| test:sales / test:shadow | 29/29, 5/5 |
| test:mutation:binding-immutability | **12/12 detectadas**; fuentes restauradas |
| test:mutation:rr1 | 5/5 detectadas |
| test:recovery | 10 archivos ok; 17 pasan, **1 falla**: `production-bootstrap-process.test.ts` |

**Clasificación del fallo de recovery (no se dispensa en silencio).** El mismo test, corrido en un worktree limpio de `main` `485df2b` (sin `0011`), falla con la misma aserción: espera `registered: sales@3` y recibe `sales@3, sales@4, … sales@8`. Es un inventario desactualizado desde J2D (`sales@4`), no relacionado con bindings ni migraciones: **preexistente, no es regresión de este PR**. Queda como deuda de test fuera de alcance.
