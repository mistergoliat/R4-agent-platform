# R4-J4 SEC-S2 — Informe de validación: estado transitorio y cifrado

| Campo | Valor |
|---|---|
| Mandatos | `R4-J4-SEC-S1-OWNER-MERGE-05` (merge de SEC-S1 y autorización) · `R4-J4-SEC-S2-STATE-AND-ENCRYPTION-01` |
| Fecha | 2026-10-21 |
| Para | Owner de R4 |
| Rama | `feat/r4-j4-sec-s2-state-encryption`, desde `origin/main` `b0b5297` |
| Alcance | **Solo SEC-S2:** esquema `identity_verification`, migración propia, stores de expectativas y respuestas, `SecretBox` (AES-256-GCM), identificadores de clave y rotación sintética, transiciones, `protect_until`, expiración, purga, leases y fencing. **Sin** integración con `ChannelIngress`, cambios en `live-ops`, webhook, despachador, llamadas a la CIA, capacidades, onboarding ni despliegue |

```text
SEC_S1_OWNER_ACCEPTED
SEC_S1_MERGED_TO_MAIN
SEC_S2_STATE_ENCRYPTION_IMPLEMENTED
SEC_S2_SYNTHETIC_VALIDATION_PASS
SEC_S2_READY_FOR_OWNER_REVIEW
SEC_OTP_TEXT_COVERAGE_REVIEW_PENDING
R4_HARNESS_UNCHANGED
GATE_RR1_PENDING
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

---

## 1. Merge de SEC-S1 (PR #15)

| Comprobación (preflight) | Resultado |
|---|---|
| Head del PR | `d817feda5218156535353f5aa3caf094dacfc797`, igual al autorizado |
| Baseline remoto | `main` `c4c2ff8048289eb09ee7aa790225ea6e71df1e1a`, igual al reportado |
| Commits | `4ff7a47`, `3cb5686` y `d817fed`, todos de la serie SEC-S1 |
| Contenido | Clasificador, pruebas (unit, contract, mutation), configuración del workspace (`package.json`, `package-lock.json`, `tsconfig*.json`, `vitest.config.ts`), informe SEC-S1. Además el registro de decisiones de ACCEPTANCE-03 en la decisión §13 y en RR-1, ya reportado en su momento |
| Harness, `live-ops`, webhook, CIA y CP | Sin cambios: el diff contra `packages`, `apps`, `agents`, `adapters/channels`, `adapters/models`, `adapters/domains/src` e `identity/http` está vacío |
| Checks y seguridad | GitGuardian Security Checks **pass**. Sin alertas nuevas. Estado `MERGEABLE` y `CLEAN` |
| Regresión reportada | Unit 1 399, contract 403, integration 471, sales 29, shadow 5; mutaciones 23/23 (informe S1) |
| Método | `gh pr merge 15 --merge --match-head-commit d817fed…`: merge commit normal. Sin squash, rebase ni force-push |
| **`main` después** | **`b0b5297d8f3fb2b0194918db520277457dae972f`**. Padres: `c4c2ff8` y `d817fed`. Su árbol es idéntico al de `d817fed`. Los tres commits de SEC-S1 son ancestros de `main` |
| Otros worktrees y archivos | Conservados |

---

## 2. Qué implementa SEC-S2

Todo vive en el paquete `@r4-adapters/identity-verification`, fuera del Core.

| Archivo | Contenido |
|---|---|
| `migrations/0011_identity_verification_state.sql` | Esquema `identity_verification`: tablas `expectations` y `responses`, CHECK, índices y 3 triggers. Lo aplica el migrador genérico de la plataforma, igual que el pack Sales con `sales.*` |
| `src/migrate.ts` | `migrateIdentityVerification(pool)`, `identityVerificationSchemaIsCurrent(pool)` |
| `src/secret-box.ts` | `Keyring` (identificadores, orden, rotación) y `SecretBox` (AES-256-GCM, AAD) |
| `src/keys.ts` | `conversationLockKey` (clave del lock consultivo por conversación) y `confirmIdempotencyKey` |
| `src/state-store.ts` | `IdentityVerificationStore`: expectativas, captura, reclamo con lease, resultado con fencing, liberación, fallo, notificación, barrido y purga. `lockConversation` |

**Registro:**
- dependencia `@r4/persistence-postgres` (manifest, `tsconfig` y lock);
- regla eslint propia del paquete;
- script `test:mutation:identity-verification-state`.

**Fuera de SEC-S2:** el clasificador SEC-S1 no cambió. Tampoco cambiaron ningún paquete de `packages/` ni `apps/` ni el pack Sales.

---

## 3. Esquema y migración

### 3.1 `identity_verification.expectations` (sin secretos)

| Columna | Restricción |
|---|---|
| Identidad | `expectation_id`, `channel`, `conversation_key` (hex64), `account_ref`, `binding_id`, `task_id`, `consumer_id`, `start_idempotency_key` (único) |
| Desafío | `verification_id` (solo identificador; inútil sin el código), `challenge_expires_at`, `cia_outcome`, `attempts_remaining` (0–4) |
| Estado | `created`, `awaiting_code`, `processing`, `confirmed`, `rejected`, `expired`, `cancelled`, con `closed_at`, `closed_reason` y `version` |
| Protección | `protect_until NOT NULL` |

**CHECK (corrección rev. 02 incluida):**
- `created_has_no_challenge`;
- `issued_states_have_challenge` (`awaiting_code`, `processing`, `confirmed` y `rejected` exigen `verification_id`). **`cancelled` y `expired` se admiten sin él**;
- `challenge_has_expiry`;
- `terminal_iff_closed`;
- `closed_has_reason`;
- `confirmed_has_consumed_outcome`;
- `rejected_has_rejecting_outcome`;
- `protection_covers_challenge`.

**Índices:**
- único parcial `expectations_one_live`: una expectativa viva por `(channel, conversation_key)`;
- `expectations_protection`.

### 3.2 `identity_verification.responses` (código solo cifrado)

| Columna | Restricción |
|---|---|
| Identidad | `response_id`, `expectation_id` (FK), `channel`, `provider_event_id` con `unique (channel, provider_event_id)`, `received_seq` (identity), `confirm_idempotency_key` (único, gramática de la CIA) |
| Material sellado | `code_ciphertext bytea`, `code_iv` (12 bytes), `code_tag` (16 bytes), `key_id`. **Nunca la clave** |
| Lease | `lease_owner`, `lease_generation` (monótona), `lease_expires_at`, `attempts`, `next_attempt_at` |
| Ciclo de vida | `state` (`pending`, `dispatching`, `resolved`, `notified`, `cancelled`, `failed`, `expired`), `cia_outcome`, `failure_code`, `deadline_at`, `purge_after` |

**CHECK:**
- `secret_only_while_open`: hay cifrado **si y solo si** el estado es `pending` o `dispatching`;
- `sealed_fields_together`: los 4 campos sellados existen juntos o faltan juntos;
- `lease_only_while_dispatching`;
- `resolved_has_outcome`;
- `purge_after_deadline`.

### 3.3 Triggers

| Trigger | Garantía |
|---|---|
| `expectations_guard` (BEFORE UPDATE/DELETE) | Expectativa terminal inmutable. Identidad inmutable (incluido `verification_id` una vez fijado). `protect_until` solo crece. `version` +1 por cada cambio. Solo transiciones de la máquina de estados. **No se puede borrar** una expectativa viva o con `protect_until > now` |
| `expectations_erase_on_close` (AFTER UPDATE) | Al pasar a un estado terminal, **todas** sus respuestas `pending` o `dispatching` pasan a `cancelled(expectation_closed)` y se borra su cifrado. Cubre el reemplazo, la cancelación, la expiración y la confirmación (los códigos posteriores) |
| `responses_guard` (BEFORE INSERT/UPDATE/DELETE) | Se inserta solo en `pending` y bajo una expectativa **viva**. Respuesta terminal inmutable. Identidad inmutable. **Material sellado de una sola escritura:** no se puede reemplazar, solo borrar al cerrar. Generación de lease monótona. Transiciones válidas. Solo se borran respuestas terminales |

### 3.4 Transiciones

| | Permitidas | Prohibidas (probadas) |
|---|---|---|
| Expectativa | `created → awaiting_code / cancelled / expired` · `awaiting_code → processing / expired / cancelled` · `processing → awaiting_code / confirmed / rejected / expired / cancelled` | Cualquier cambio desde un estado terminal. `created → confirmed`, `created → processing`. `awaiting_code` sin desafío. `confirmed` sin resultado de consumo. `rejected` con `linked`. Estado vivo con `closed_at` |
| Respuesta | `pending → dispatching / cancelled / expired / failed` · `dispatching → pending / resolved / cancelled / expired / failed` · `resolved → notified` | Cualquier cambio desde `notified`, `cancelled`, `failed` o `expired`. `pending → resolved`. Insertar en un estado distinto de `pending` |

---

## 4. Invariantes criptográficos

| Invariante | Implementación | Evidencia |
|---|---|---|
| El código nunca se almacena en claro | El store solo recibe `SealedCode`. El sellado y la apertura son del titular de la `SecretBox`. El esquema no tiene columna de texto plano (prueba de frontera) | Volcado `row_to_json` de ambas tablas sin el código (ni en ASCII ni en hex) |
| IV aleatorio único por registro | `randomBytes(12)` en cada `seal` | 500 sellados: 500 IV distintos y 500 pares ciphertext+tag distintos. Mutación S2-M1 (IV constante) detectada |
| AAD ligada a la identidad de la respuesta | `JSON.stringify(['r4.identity-verification.code.v1', responseId, expectationId, channel, providerEventId])` | Abrir con otra respuesta, expectativa, canal o evento da `decrypt_failed`. Mutación S2-M2 detectada |
| Integridad | GCM con tag de 128 bits. El texto descifrado debe ser `^[0-9]{6}$` | Alterar el ciphertext (primer y último byte), el IV, el tag o truncar el tag da `decrypt_failed` |
| Identificadores de clave y rotación | `Keyring` ordenado (`id:base64(32)`, el primero sella, todos abren). Se persiste solo `key_id` | Sellado con `k0`, se rota a `k1,k0`: abre y sella con `k1`. Con `k1` solo: `unknown_key`. Mismo id con otra clave: `decrypt_failed` |
| Claves separadas de los datos | Las claves llegan de la composición, nunca del entorno del paquete. El material es privado del módulo (`WeakMap`) y `Keyring` no tiene accesor | Volcado de la base sin el material (base64 ni hex). `JSON`, `String` e `inspect` de `Keyring` y `SecretBox` sin material. Mutación S2-M3 detectada |
| Material terminal inexistente | CHECK `secret_only_while_open` y trigger `erase_on_close` | AT-20 y S2-M4/M5 |
| Solo la `SecretBox` descifra | Prueba de frontera: `createDecipheriv` y `createCipheriv` solo en `secret-box.ts` | S2-M16 detectada |

---

## 5. Requisitos del mandato (§5) y evidencia

| Requisito | Evidencia |
|---|---|
| El código nunca se almacena en claro | §4 y la prueba de volcado |
| IV único y AAD ligada a la respuesta | §4 |
| Los estados terminales no conservan material cifrado | CHECK `secret_only_while_open`. Resuelto, fallido y expirado por plazo, todos sin cifrado (pruebas). S2-M4 |
| Desafíos cancelados o reemplazados borran el material pendiente | `erase_on_close`: el reemplazo cancela y borra en la misma transacción. Un código posterior a una confirmación se cancela sin despacho. S2-M5 |
| La ventana de protección sobrevive al cierre | `protectionActive` sigue verdadero tras confirmar, cancelar y expirar. `protect_until` solo crece (S2-M7). `markIssued` la extiende a la expiración + 10 min (S2-M13) |
| Ningún borrado o rollback elimina una obligación de protección vigente | El `DELETE` de una expectativa viva o protegida falla (`protection_active`). La purga las omite (S2-M6, S2-M14). La purga solo procede tras `protect_until` + retención |
| La recuperación ante reinicios preserva integridad e idempotencia | Un lease vencido se vuelve a reclamar con `generation` mayor, `attempts` +1 y la **misma** `confirm_idempotency_key`. El dueño anterior queda excluido (`stale`) en resultado, liberación y fallo. Un segundo resultado del mismo reclamo es `stale` (S2-M10). Un `openExpectation` repetido es idempotente por clave de inicio |
| Errores de SQL, cifrado y validación sin secretos | `IdentityVerificationError` y `SecretBoxError` llevan solo `code` y `name`. Sin `detail`, valores de fila, código, ciphertext, claves ni AAD (pruebas con PK duplicada, expectativa inexistente y CHECK de formato). S2-M15 |
| Claves sintéticas separadas de los datos | §4 |
| Agente y harness sin acceso al descifrado | Ningún archivo de `packages/`, `apps/` ni `agents/` referencia el paquete, `SecretBox` ni `R4_PROD_VERIFICATION_CODE_KEYS`. Eslint prohíbe al paquete importar runtimes, kernel, `live-ops`, apps o packs |
| Preparar S3 sin dependencias inversas | `captureResponse(client, …)` corre **dentro de la transacción del llamador** (la del inbound en S3) y toma el lock de la conversación, que es reentrante en la transacción. El paquete depende solo de `@r4/persistence-postgres`; nadie depende de él |

---

## 6. Pruebas

| Archivo | Proyecto | Pruebas | Contenido |
|---|---|---|---|
| `tests/unit/identity-verification/secret-box.test.ts` | unit | 32 | Keyring (formato, rechazos y no impresión), sellado y apertura, IV únicos, manipulación (5 casos), AAD (4 casos), rotación y claves inexistentes, errores sin secretos, vectores fijados de `conversationLockKey` y `confirmIdempotencyKey` |
| `tests/integration/identity-verification-state.test.ts` | integration (PostgreSQL local) | 38 | AT-TR-01 a 13, AT-20, AT-15 (almacenamiento), rotación sobre datos persistidos, reemplazo y expiración, borrado de material, `protect_until`, purga, concurrencia, leases y fencing, errores |
| `tests/contract/identity-verification-boundaries.test.ts` | contract | 9 (antes 6) | Dependencias, importaciones permitidas por archivo, pureza del clasificador, sin entorno, logs ni red, solo la `SecretBox` descifra, sin nombres de canal, sin columna de texto plano, nadie fuera del paquete lo usa, `live-ops` intacto |

**Cobertura por identificador del plan:**

| ID | Prueba |
|---|---|
| AT-TR-01 | `created → awaiting_code`, protección hasta la expiración + 10 min, idempotente |
| AT-TR-02 | `created → cancelled` **sin** `verificationId` (la corrección del CHECK) |
| AT-TR-03 | `created → expired` sin `verificationId` (nunca emitido) |
| AT-TR-04 / 05 | Reclamo → `processing`; liberación e `invalid_code` (quedan intentos) → `awaiting_code` |
| AT-TR-06 | `processing → confirmed` con los 5 resultados de consumo |
| AT-TR-07 | `processing → rejected` (`locked`, `invalid_code` sin intentos) |
| AT-TR-08 | `processing → expired` (resultado `expired`; expiración en vuelo, y el reclamo queda `stale`) |
| AT-TR-09 | `awaiting_code → expired` por el barrido |
| AT-TR-10 | `awaiting_code → cancelled` (cierre y reemplazo) |
| AT-TR-11 | `processing → cancelled` por reemplazo: reclamo `stale` y cifrado borrado |
| AT-TR-12 | Expectativa y respuesta terminales inmutables |
| AT-TR-13 | Transiciones ilegales, estados incoherentes, identidad, versión y protección |
| AT-20 | Terminal con cifrado rechazado; material de una sola escritura (no se puede manipular en la base); campos sellados juntos; código y claves ausentes del volcado; apertura solo con la clave y la vinculación correctas |
| AT-15 (almacenamiento) | Una transacción de captura que falla no deja filas; el reintento crea una vez y luego es idempotente. Sin captura bajo una expectativa cerrada |
| Concurrencia | 6 aperturas simultáneas dejan **una** viva. 5 capturas simultáneas del mismo evento dejan **una** fila. 4 reclamos simultáneos dan **un** reclamo por expectativa. El orden de llegada se respeta y el backoff de una expectativa **no bloquea** otras |

---

## 7. Resultados de validación

| Comprobación | Resultado |
|---|---|
| `npm run build` | OK |
| `npm run typecheck` | OK |
| `npm run lint` (`--max-warnings=0`) | OK |
| `unit` | 82 archivos (1 omitido) · **1 431 PASS**, 4 skip, 0 FAIL. Antes 1 399; +32 |
| `contract` | 30 archivos · **406 PASS**, 0 FAIL. Antes 403; +3 |
| `integration` (PostgreSQL local) | 38 archivos (1 omitido) · **509 PASS**, 12 skip preexistentes, 0 FAIL. Antes 471; +38 |
| `sales` | **29/29** |
| `shadow` | **5/5** |
| Mutaciones SEC-S1 (`test:mutation:identity-verification`) | **23/23** detectadas |
| Mutaciones SEC-S2 (`test:mutation:identity-verification-state`) | **16/16** detectadas, fuentes restauradas byte a byte |
| Estabilidad | La integración de SEC-S2 se ejecutó 3 veces seguidas en verde, además de las ejecuciones dentro de las suites de mutación |
| Caracteres | Sin caracteres invisibles literales en las fuentes nuevas (escaneo) |

Para las suites con base de datos se arrancó el contenedor local `r4-agent-platform-postgres` y se detuvo al terminar. Todos los datos son sintéticos y las claves se generan en cada prueba.

**Mutaciones SEC-S2:**

| # | Mutación |
|---|---|
| S2-M1 | IV constante |
| S2-M2 | AAD sin la respuesta |
| S2-M3 | `Keyring` serializa las claves |
| S2-M4 | Sin `secret_only_while_open` |
| S2-M5 | El cierre conserva los códigos pendientes |
| S2-M6 | Se puede borrar una expectativa protegida |
| S2-M7 | `protect_until` puede encogerse |
| S2-M8 | La expectativa terminal es mutable |
| S2-M9 | Captura bajo una expectativa cerrada |
| S2-M10 | Sin fencing |
| S2-M11 | Se despacha primero lo más nuevo |
| S2-M12 | Un inicio nuevo no reemplaza el anterior |
| S2-M13 | `markIssued` no extiende la protección |
| S2-M14 | La purga ignora la protección |
| S2-M15 | Errores crudos de la base se escapan |
| S2-M16 | Un segundo módulo descifra |

---

## 8. Defectos encontrados y corregidos durante la validación

| # | Defecto | Corrección |
|---|---|---|
| D-1 | Los CHECK `confirmed_has_consumed_outcome` y `rejected_has_rejecting_outcome` aceptaban `cia_outcome = NULL`: un CHECK cuyo resultado es NULL pasa | Se exige `cia_outcome is not null and …`. Lo detecta AT-TR-13 |
| D-2 | **Bloqueo en cabeza de cola** en `claimNextResponse`: si la respuesta más antigua de una expectativa estaba en backoff, el reclamo devolvía `null` aunque **otras** expectativas tuvieran trabajo | La selección exige que la respuesta abierta **más antigua** de la expectativa sea reclamable. Lo cubre una prueba dedicada y S2-M11 |

---

## 9. Fronteras arquitectónicas

- **Harness sin cambios:** `git diff --stat b0b5297` sobre `packages/{agent-kernel,task-runtime,capability-runtime,context-compiler,model-gateway,policy-engine,contracts,observability}` está vacío.
- **Sin cambios** en `live-ops`, `persistence-postgres`, `apps/` (incluidos el gateway y el webhook), `agents/`, `adapters/channels`, `identity/http`, CIA ni CP: el diff está vacío para esas rutas.
- **El paquete solo depende de `@r4/persistence-postgres`** (migrador genérico, `withTransaction`, tipos `Pool` y `PoolClient`). Nada depende de él, así que no hay dependencias inversas. Lo prueban el contrato y la regla eslint.
- **Sin llamadas a la CIA, red, correo, entorno ni logging** en el paquete.
- **No se registró ninguna capacidad productiva.** `R4_CUSTOMER_MODE=real` sigue rechazado.

---

## 10. Riesgos residuales

| # | Riesgo | Estado |
|---|---|---|
| R2-01 | La custodia de claves es solo sintética: no hay KMS, gestor de secretos ni separación de roles de base de datos | OA-10. Gate de datos reales |
| R2-02 | Rol de base de datos único: un proceso con acceso a la base puede **leer** el cifrado, aunque no descifrarlo sin la clave | Mitigado por la clave fuera de la base y el TTL ≤ 20 min. La separación de roles es OA-10 |
| R2-03 | El resultado en vuelo de un desafío reemplazado se **descarta** (`stale`). El texto anterior decía "se registra" | Es más estricto: el material se borra en el mismo reemplazo. Decisión §6.4 y modelo RX-07 actualizados en esta rama |
| R2-04 | `conversationLockKey` vive en el paquete. La transacción del inbound de S3 tendrá que usar exactamente el mismo algoritmo | Vector fijado por prueba. Dependencia S3-DEP-01 |
| R2-05 | `protectionGraceMs`, `unissuedTtlMs` y `retentionMs` son configurables (las pruebas usan 0) | La composición de S3 debe usar los valores por defecto de OA-07 (S3-DEP-03) |
| R2-06 | Las expectativas usan referencias lógicas a binding y tarea, sin FK hacia tablas de la plataforma | Validación `V` (RR-1) en S3/S4. Trigger de inmutabilidad del binding pendiente (RR-1 R-4) |
| R2-07 | Las pruebas de expiración esperan 1–2 s de reloj real | Estables en 3 ejecuciones. Sin temporizadores en la lógica |
| R2-08 | Cobertura textual del clasificador | `SEC_OTP_TEXT_COVERAGE_REVIEW_PENDING` (§11) |

---

## 11. Dependencias para SEC-S3

| ID | Dependencia |
|---|---|
| **`SEC_OTP_TEXT_COVERAGE_REVIEW_PENDING`** | Los formatos numéricos que SEC-S1 no detecta (informe S1 §9) deben evaluarse **antes** de conectar el inspector a tráfico real. **No se declara `OTP_LEAKAGE_IMPOSSIBLE`.** Con una obligación de protección y contenido no determinable con seguridad, la inspección **falla cerrada**. SEC-S2 no se amplió para resolverlo. Registrado también en el plan §8 |
| S3-DEP-01 | El inbound toma `pg_advisory_xact_lock(conversationLockKey(channel, conversationKey))` **antes** de la comprobación de duplicado y de la inspección. Si el helper pasa a `live-ops` como función genérica, este paquete debe usarlo (vector fijado) |
| S3-DEP-02 | `captureResponse` se llama con el cliente de la transacción del inbound, después de `protectionActive` y `liveExpectation` en la misma transacción |
| S3-DEP-03 | La composición usa los valores por defecto (gracia 10 min, desafío no emitido 600 s, retención 24 h) |
| S3-DEP-04 | La `SecretBox` y `R4_PROD_VERIFICATION_CODE_KEYS` solo en el proceso gateway. Modos `full` y `protect_only`; arranque en `protect_only` sin clave; guardia sin override basada en `protectionActive` |
| S3-DEP-05 | ADR-040 (R4-I.1) y la prueba de frontera de `live-ops` (solo un puerto genérico) |

---

## 12. Baseline y commits

| | Valor |
|---|---|
| Baseline | `origin/main` `b0b5297d8f3fb2b0194918db520277457dae972f` (merge del PR #15) |
| CIA / CP | `7525395` / `bbd766e`, sin cambios |
| Commits SEC-S2 | El de implementación y el de documentación de esta rama (SHAs en el PR) |
| Autor | `MisterGoli <joaqutorres@alumnos.uai.cl>` |
| Publicación | PR abierto. **Sin merge** |

---

## 13. Pendiente

- **SEC-S3 no se inicia** sin un mandato.
- SEC-OTP-01 y SEC-OTP-02 incompletos (S3 a S7).
- `GATE_RR1` pendiente. BA-01 a BA-06, G-16, AP-*, D7 y OA-10 pendientes.
- Datos reales **bloqueados**.
