# ADR-036 — Procedencia contractual y orden causal de los mensajes de una conversación

- **Estado:** **Propuesto** (borrador de R4-J3E-C1, 2026-10-14). **No implementado.** No se modificó `packages/`, `apps/` ni `adapters/`.
- **Fecha:** 2026-10-14
- **Autoridad superior:**
  - Constitución: "model output is untrusted"; "writes require governed execution"; "durable state must survive process restart".
  - PRD; ADR-016/021/029/034/035.
- **Resuelve (si se acepta):**
  - el gate `single-input-producer` de ADR-035;
  - el gate `input-provenance` de `SALES_PRODUCTION_PROFILE_V7_GATE`;
  - el defecto de orden por relojes distintos (ADR-035:20 y J3E-B §1 afirman "mismo reloj"; es falso).
- **Evidencia:**
  - `docs/architecture/R4_J3E_PRODUCTION_GAP_CLOSURE_PLAN.md` §2;
  - `docs/architecture/R4-J3E_C1_IMPLEMENTATION_REPORT.md` §9.

## Contexto

`quote.create@4/@5` (Sales) autoriza una emisión leyendo el hilo de la conversación con `ProductionStore.thread(taskId)`. Exige que el último mensaje del cliente sea una confirmación explícita de la oferta inmediatamente anterior. Dos supuestos no están garantizados por contrato.

**1. Procedencia.**
- `ThreadEntry` expone para un `contact` solo `{inputId}` (`production-store.ts:554-555`).
- `task_inputs` sí guarda `actor_kind`, `actor_ref` y `source_ref`: son `not null` e inmutables (`migrations/0005_temporal_human_runtime.sql:145-158`).
- Hoy crean inputs:
  - `ChannelIngress`, después de autenticar al proveedor;
  - la API de plataforma `POST /v1/tasks/:id/inputs`;
  - el harness y shadow de Sales (en proceso);
  - el canary, con `ChannelIngress.ingest`, que es público y no autentica.
- La API acepta cualquier `sourceRef` del cuerpo, incluido `channel:whatsapp` (`apps/api/src/app.ts:167-174`). Por eso, aunque se expusiera, **un `sourceRef` libre no prueba autenticidad**.

**2. Orden.**
- `contact.at` sale del reloj de la base (`r4_now()` = `clock_timestamp()`, `temporal-runtime.ts:387`).
- `agent.at` es el `created_at` del paso, tomado del **reloj de la aplicación del worker** (`execution-runtime.ts:441`).
- La regla "la confirmación es posterior a la oferta" compara, por lo tanto, dos relojes.

## Decisión propuesta

### D1. Exponer el origen de cada input (aditivo)

`thread()` agrega a los `contact.refs`:

```
{ inputId, actorKind, actorRef, sourceRef }
```

- Es un `SELECT` más amplio en `production-store.ts:554`.
- `ThreadEntry.refs` ya es `Record<string, string | null>`: el tipo no cambia, y las claves se documentan en `ports.ts`.
- Con `noUncheckedIndexedAccess`, un consumidor que no encuentre la clave falla cerrado.

### D2. Reservar el espacio `channel:` para ChannelIngress

- `POST /v1/tasks/:id/inputs` rechaza con `422 reserved_source_ref` cualquier `sourceRef` que empiece con `channel:`.
- No va en `inputSubmissionSchema`, porque el propio ingress lo usa (`ingress.ts:209`).
- Cambia el comentario de la ruta ("any channel adapter", `app.ts:167`): un adaptador de canal entra por `ChannelIngress`, no por la API.
- **Seguridad de la API de inputs.** Además se propone:
  - que la ruta exija un principal autenticado distinto de `unauthenticated`;
  - o, como mínimo, que rechace inputs sobre una tarea ligada a un canal (`channel_conversation_bindings`) cuando el principal no es el ingress.

  Esta segunda parte **es la decisión de seguridad de mayor impacto** y puede separarse en otro ADR.

### D3. Orden causal: la frontera de contexto de cada respuesta

`thread()` agrega a los `agent.refs`:

```
{ stepId, runId, contextFrontierInputId }
```

- Es el último input que evaluó el contexto que produjo esa respuesta.
- Se calcula con la misma lógica de `context_snapshot_items` que ya usa `materializeResponses` (`production-store.ts:243-275`).
- Con D3, un consumidor exige que la confirmación **no** esté en el contexto de la oferta. Como el gate de despacho cancela una respuesta cuyo contexto no vio un input existente (`production-store.ts:336-343`), una oferta entregada y una confirmación no vista implican que la confirmación llegó **después** del despacho. No depende de ningún reloj.

**Alternativa D3′, rechazada:**
- registrar `agent_run_steps.created_at` con el reloj de la base;
- arregla el orden, pero cambia la semántica temporal de todos los pasos del Core (duraciones, leases, telemetría);
- es un cambio mayor que D3.

### D4. Uso en Sales (fuera del harness; versiones nuevas)

`quote.create@6`, en un perfil nuevo:
- amplía el lector estructural a `Pick<ProductionStore, 'thread' | 'bindingByTask'>` (ambos existen; `options.store` ya los cumple);
- exige que la tarea tenga binding;
- exige `confirmation.refs.actorKind === 'user'` y `confirmation.refs.sourceRef === 'channel:' + binding.channel`;
- exige que ningún `contact` posterior a la oferta tenga otro origen; si lo hay, se **rechaza**, no se filtra (`customer_confirmation_unverified_source`);
- exige que la confirmación no esté en el contexto de la oferta (`customer_confirmation_not_after_offer`).

Se compara siempre con `binding.channel`, **nunca** con `profile.channel.id`: en el canary el perfil declara `whatsapp` y los bindings son `r4-synthetic`.

## Lo que no se acepta como garantía

- Un `sourceRef` libre, sin D2: cualquier productor puede escribir `channel:*`.
- `actorKind === 'user'` sin D2: hoy la API produce `unauthenticated`, pero un `PrincipalResolver` futuro podría devolver `user`.
- Unir `inbound_events` para "probar" que el input vino del ingress.
  - `inbound_events.input_id` se completa en una transacción **posterior** (`ingress.ts:230` y `:237`).
  - Hay una ventana, y un caso de caída manejado por `resumeUnsettled`, en que un input legítimo no tiene vínculo.
  - Daría rechazos espurios.

## Compatibilidad

| Aspecto | Efecto |
|---|---|
| Implementadores de `ProductionStore` | Uno (`PostgresProductionStore`). Los dobles de test son casts y no se rompen. |
| Consumidores de `thread()` | `live-ops/src/operator.ts:37-56`, `GET /v1/tasks/:id/thread` (`app.ts:252-258`) y Sales `quote-v4`/`quote-v5`. Ven claves nuevas, que ignoran. Ningún test fija `refs` exactamente. |
| API | D2 rechaza un valor antes aceptado. Ningún productor conocido envía `channel:` por la API (tests: `api-test`, `test-channel`). |
| Migraciones | **Ninguna.** Los datos ya existen. Un `CHECK` sobre `actor_kind` sería opcional y movería `coreSchemaHead`. |
| Versionado | `live-ops` no tiene versión de puerto. Puerto y consumidor se despliegan en el mismo build (`cli/production.ts:243`). Lo que se versiona es la capacidad Sales que use los campos. |
| Rollback | Volver al build anterior quita las claves. Una capacidad que las exija falla cerrado (rechaza), nunca emite. |

## Consecuencias para otros agentes y para la plataforma

- **Genérico:** procedencia y orden causal de los mensajes son primitivas del Core (Observation/Input). No introducen conceptos de ventas.
- Cualquier agente que tome una decisión gobernada a partir de "lo que dijo el contacto" (aprobaciones conversacionales, consentimientos, bajas) puede usar el mismo contrato.
- La UI de operador del CRM (`OWNERSHIP_MATRIX.md:229`) podrá mostrar el origen de cada mensaje.
- D2 obliga a integraciones futuras a entrar por `ChannelIngress` y no por la API genérica.
- **Riesgo residual:** el código en proceso (harness, canary, cualquier composición que llame `ingest` o `submitInput` directamente) puede seguir creando inputs `channel:*`. Es la misma confianza que tener credenciales de la base. Se documenta; no se cierra con este ADR.

## Tests requeridos (cuando se implemente)

- **Integración Postgres** (`live-ops-reference`):
  - un input de ingress muestra `actorKind=user` y `sourceRef=channel:<canal>`;
  - un input de API sobre la misma tarea muestra `unauthenticated` y su propio `sourceRef`;
  - `contextFrontierInputId` cambia con un input nuevo.
- **API** (`temporal-api`): `sourceRef: 'channel:whatsapp'` → 422; `api-test` → 201.
- **Contrato:**
  - las claves de `refs` quedan fijadas;
  - fuera de tests, solo `ingress.ts` construye `channel:`;
  - `quote-v6` no lee tablas del Core.
- **Sales:** matriz offline con origen ajeno, confirmación vista por la oferta y binding ausente, y canary E2E con el `thread()` real.
- **Mutaciones:** quitar la comprobación de origen o de frontera debe romper la matriz.

## Pendiente de decisión del owner

1. Aceptar D1–D3 (cambio pequeño de harness) o mantener el gate de topología con verificación en el host.
2. Alcance de D2: solo reservar `channel:`, o además exigir un principal autenticado o prohibir inputs de API sobre tareas ligadas a un canal.
3. Si D2 se separa en un ADR de seguridad de la API.
