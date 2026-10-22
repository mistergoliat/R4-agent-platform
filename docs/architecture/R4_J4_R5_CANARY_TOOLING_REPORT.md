---
title: R4-J4-R5 — Preparación del tooling del canary de sales-production@8 (sin ejecución)
status: for-owner-review
mandate: R4-J4-R4-OWNER-ACCEPTANCE-AND-R5-PREPARATION-10
date: 2026-10-22
---

# R4-J4-R5: tooling del canary de `sales-production@8`

```text
J4_R5_CANARY_TOOLING_READY_FOR_REVIEW
J4_R5_NOT_RUN                        (no se ejecutó el canary; nada desplegado)
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

Base: `main` `3e04b4f` (PR #19). Rama `feat/r4-j4-r5-canary-tooling`. **Preparación solamente:** esta rama no autoriza ni ejecuta el canary.

## 1. Qué se preparó

| Requisito del mandato | Implementación | Prueba |
|---|---|---|
| Habilitar `@8` en la configuración del canary | `CANARY_PROFILES` incluye `@8`. `loadCanaryEnvironment` exige `R4_CANARY_CONTEXT_EXPIRED_EVIDENCE=exclude` para `@8` | contrato `sales-canary-j4` |
| Hosts de prueba con allowlist cerrada, sin relajar el default | Lista `R4_CANARY_TEST_HOSTS`: nombres DNS exactos en minúscula, sin IP, comodín, puerto ni nombre loopback, máximo 4, solo para `@8`. Los loaders de CIA (`resolve`, `start`, `confirm`) y de CP aceptan un host no-loopback solo si está listado y usa `https`. **Por defecto la lista está vacía**: loopback, igual que antes. Ningún camino productivo la pasa | contrato `sales-canary-j4` (incluye una búsqueda de fuente: solo el canary lee la variable) |
| `exclude` solo en el worker del canary; misma configuración en comparaciones pareadas | `sales:canary run` fija `R4_CONTEXT_EXPIRED_EVIDENCE` del worker al valor declarado del canary. `startCanaryRuntime` rechaza un worker con otro valor (`canary_expired_evidence_mismatch`). Un brazo `@7` pareado declara el mismo valor. La herramienta J4-R4 de comparación pareada ya lo usa en ambos brazos. Producción no cambia | integración «guards», contrato |
| Un único gateway con inspector `full`; ausencia de réplicas incompatibles antes de iniciar | Nuevo comando `sales:canary gateway`, solo para `@8`. Compone la inspección exactamente como el gateway productivo (`salesGatewayInspection`: keyring y cliente `confirm`) y corre el dispatcher. Antes de arrancar, `pg_stat_activity` debe mostrar **cero** otros gateways (del canary o de plataforma `r4-gateway:*`) en la base del canary; si no, `canary_gateway_replica`. El worker y la ingesta de `@8` no corren sin ese gateway (`canary_gateway_not_running`). Las réplicas mixtas **se rechazan**: no se detectan después | integración «single canary gateway» |
| Ingesta protegida | La ingesta sintética de `@8` (`sales:canary send`) es un proceso con rol de gateway. Usa el inspector en el modo durable que escribió el gateway y **nunca** lo escribe (un `protect_only` del breaker o de un rollback no se deshace). El canal sintético se atesta como 1:1 (`SYNTHETIC_INBOUND_ADAPTER`) | integración «OTP flow»: el código no queda en ningún texto persistido; el hash del inbound es el del marcador |
| Purga verificable de datos sintéticos | `sales:canary purge --confirm <canaryId>` | integración «rollback … purge» |
| Pruebas de reinicio y recuperación del dispatcher | Un `confirm` interrumpido por el reinicio del gateway (CIA 503 → reinicio → CIA disponible) se reanuda con **la misma clave de idempotencia y el mismo cuerpo**, enlaza la cuenta y reanuda la tarea con el marcador sin resultado | integración «OTP flow» |
| Rollback `@8 → @7` con `full → protect_only → absent` y `protect_until` | `sales:canary rollback-status` y la guarda `assertUninspectedCanaryAllowed`: un perfil sin inspector (`@4`–`@7`) no corre ni ingiere en la base del canary mientras el modo sea `full`, haya ventanas abiertas, haya `identity.start_verification` abiertos o haya un gateway conectado | integración «rollback» |
| Limitación conocida de `@7` ante Customer | Tras el rollback, una solicitud Customer en `@7` produce `failed:unknown_capability` y luego una run nueva (`suspended:waiting`, ADR-028). La tarea no se pierde | integración «rollback» |
| Nada habilita identidades reales ni rutas productivas | `R4_CUSTOMER_MODE=real`, credenciales no sintéticas, hosts fuera de la allowlist y credenciales del gateway en el worker se rechazan | integración «guards», contrato |

**Topología de procesos del canary `@8`.** Las credenciales siguen la regla de SEC-S4: el keyring y la credencial `confirm` solo en procesos con rol de gateway.

| Proceso | Rol | Recibe |
|---|---|---|
| `sales:canary gateway [--mode full\|protect_only]` | Gateway único: inspector y dispatcher `confirm`; escribe el modo durable | keyring, `R4_CHANNEL_IDENTITY_CONFIRM_BEARER_TOKEN` |
| `sales:canary send` | Ingesta sintética inspeccionada; sigue el modo durable | keyring (sella los códigos capturados) |
| `sales:canary run` | Worker y scheduler | `R4_CUSTOMER_*` del agente. **Rechaza** el keyring y `confirm` |

**Esquema.** `sales:canary init` migra siempre el esquema `identity_verification`. La misma base sirve a `@8` y a su rollback a `@7`, cuya guarda lo lee; sin gateway, el esquema es inerte.

## 2. Procedimiento (cuando J4-R5 se autorice; no se ejecutó)

1. Base dedicada cuyo nombre contenga `canary`. Correr `sales:canary init` con `R4_PROD_POLICY_PROFILE=sales-production@8` y `R4_CANARY_CONTEXT_EXPIRED_EVIDENCE=exclude`. Si la CIA y CP de prueba no corren en loopback, declarar `R4_CANARY_TEST_HOSTS` con sus nombres exactos.
2. **Un** proceso `sales:canary gateway`, con el entorno de gateway: keyring sintético y credencial `confirm` sintética.
3. `sales:canary run`, con el entorno del worker: `R4_CUSTOMER_*` sintéticos, sin keyring ni `confirm`.
4. Conversaciones sintéticas con `sales:canary send` (entorno con keyring). La evidencia se etiqueta como sintética.
5. **Rollback `@8 → @7`:**
   1. detener `run`;
   2. reiniciar el gateway con `--mode protect_only`;
   3. esperar hasta que `rollback-status` muestre `openProtections: 0` y `openStarts: 0`;
   4. detener el gateway (`ready: true`);
   5. `run` con `@7` y la misma política de evidencia.
6. **Cierre (D7 del canary):**
   1. detener todos los componentes;
   2. correr `sales:canary purge --confirm <canaryId>`;
   3. archivar la evidencia JSON: conteos antes y después, `rowsRemaining: 0`, `realCustomers` en cero, sha256.

## 3. Validación (rama local, PostgreSQL local)

- Contrato `sales-canary-j4`: 7/7.
- Integración `sales-canary-j4`: 4/4. Escenarios:
  - gateway único y réplicas;
  - OTP con reinicio del dispatcher;
  - rollback, limitación de `@7` y purga;
  - guardas.
- `sales-profile-v8` (J4-R4) se adaptó al flujo real: el entorno `@8` sale de `loadCanaryEnvironment` y corre detrás del gateway del canary. Sigue en verde.
- Inventarios ajustados:
  - `sales-canary-boundaries`: 7 archivos; una única sentencia de purga, dentro de `purgeCanary`;
  - `identity-verification-boundaries`: nuevos usuarios del paquete y de `identity.start_verification`.
- Mutaciones `test:mutation:canary-j4`: ver §5.
- La regresión completa del candidato está en §5.

**Simulación de tiempo (solo en las pruebas).** Para no esperar la gracia de protección (≤ 20 min), la prueba de rollback retrocede la línea de tiempo de las expectativas en una única transacción con `session_replication_role = replica`, porque el trigger `protection_cannot_shrink` impide acortar una ventana. El código del canary no hace esto. Sin la simulación, el procedimiento real espera el vencimiento.

## 4. Límites y residuos

- **No se ejecutó J4-R5:** sin despliegue, EC2, CIA/CP desplegados ni modelo real. El tooling solo se probó en local con stubs.
- **Réplicas mixtas.** El canary las rechaza al arrancar (gateway, worker, ingesta). Un gateway que se conecte **después** no se detecta de forma continua. Para producción el residual R3-04 sigue abierto y bloquea los despliegues mixtos (ADR-040).
- **Detección por `application_name`.** El nombre lo declara el propio cliente. Un proceso que se conecte a la base del canary con otro nombre no se detecta. La base del canary es dedicada y su acceso lo controla Operación.
- **Purga.** Vacía todas las tablas de datos de los esquemas `public`, `sales` e `identity_verification`; conserva el ledger de migraciones, las definiciones y el marcador. Rechaza si hay componentes conectados, si el `--confirm` no coincide o si existen bindings fuera de la cuenta sintética del canary: los datos ajenos se investigan, no se borran.
- **Harness sin cambios** (`packages/*`, `apps/worker`, `apps/api`, `apps/scheduler`). Cambios fuera del pack de Sales: solo los loaders de los adaptadores CIA y CP (opción de allowlist, por defecto vacía).

## 5. Resultados (candidato `36a58cc` y el commit de cierre; PostgreSQL local)

| Suite | Resultado |
|---|---|
| build, typecheck, lint | ✓ |
| unit | 1519 passed, 4 skipped |
| contract | **450** passed (+7 de `sales-canary-j4`) |
| integration | 584 passed y 2 fallos en la corrida completa (ver abajo); tras el ajuste, 0 fallos reales |
| sales, shadow | 29, 5 |
| `test:mutation:canary-j4` (nueva) | **10/10** |
| `test:mutation:profile-v8` | 8/8 |
| S3 ingress, S4 dispatch, S5 commercial, RR-1 | 13/13, 11/11, 9/9, 5/5 |

**Los dos fallos de la corrida completa de integración:**
- `sales-canary.test.ts`: un inventario del mensaje de error (la lista de perfiles del canary ahora incluye `@8`). Se corrigió en el commit de cierre y pasa 15/15.
- `worker-readiness.test.ts`: un fallo de tiempo bajo carga. Al re-ejecutarse solo (`--no-file-parallelism`) pasa 18/18 sin cambios.

**Primera corrida de mutaciones.**
- CJ4-M9 sobrevivió: la prueba de rollback nunca observaba el estado «gateway detenido con ventana abierta». Se agregó ese estado y quedó 10/10.
- PV8-M5 quedó sin ancla porque cambió la firma de `salesGatewayInspection`. Se actualizó y quedó 8/8.

**Fallo preexistente, fuera del alcance:** `tests/recovery/production-bootstrap-process.test.ts:48` (suite `recovery`, que no corre en `npm test`) espera que se registre solo `sales@3`. Falla desde `sales@4` (J2D) y ya figuraba en el informe J3E-C1.
