---
title: R4-J4-R7 — G1 — Revisión independiente de R7-1 (Runtime Contingency & Recovery)
status: R4_J4_R7_G1_APPROVED
mandate: «R4-J4-R7 — G1 Closure & R7-2 Implementation», Parte A (owner, 2026-10-29)
date: 2026-10-29
reviewed: feat/r4-j4-r7-1-runtime-contingency @ 665b50c (base 0356388 = main d0bb7a7 + docs R7)
---

# G1 — Revisión independiente de R7-1

```text
DECISION        G1_PASS
CODE REVIEW     sin defecto material (G1-A, G1-B, G1-C); 3 observaciones no bloqueantes (§6)
REPRODUCTION    build limpio, typecheck, lint, unit, contract, integration (serie), sales, shadow, recovery: VERDE
MUTATIONS       67/67 detectadas (runtime-contingency 11, run-failure-fallback 6, recovery 14, production 23, production-control 13)
FLAKES          reproducidos bajo saturación de CPU, iguales en la base d0bb7a7; 0 fallos sin carga (4/4 paralelo, 1/1 serie)
SCOPE           revisión del código real de la rama, no del informe; sin cambios a la rama revisada
```

## 1. Método

- Se revisó el diff completo `0356388..665b50c`: 44 archivos, +1664/−80. Incluye los dos commits de PR #27
  integrados por cherry-pick (`e25b6f8`, `1b2cefd`), el código (`6577c5c`) y los documentos (`665b50c`).
- Cada afirmación del informe de R7-1 se contrastó con el código que la sostiene. El código circundante también se
  leyó: el bucle del kernel, `finishExecution`, `claimNext`, `handOffAfterRunFailureWithin`, el gate de entrega, la
  clasificación de errores de PostgreSQL, el estado de migraciones y los índices únicos de `0005`.
- La reproducción corrió en el worktree aislado de la rama, sobre un build **reconstruido desde cero**. Se borraron
  `dist` y `*.tsbuildinfo` de todo el árbol, sin seguir junctions de `node_modules`. `npm run clean` deja 10 `dist`
  de adaptadores y del pack, que se borraron aparte. Se usó sólo el PostgreSQL local de pruebas
  (`127.0.0.1:55432`), sin servicios externos.
- La rama revisada **no se modificó**. Este informe vive en la rama de R7-2.

## 2. G1-A — Recuperación

| Punto | Verificación | Resultado |
|---|---|---|
| `runFailureDisposition` | `contracts/src/run.ts:195-202`. Toda razón con estado `failed`/`abandoned` (`model_failure`, `invalid_decision`, `capability_failure`, `budget_exhausted`, `internal_failure`, `lease_lost`) da `human`, salvo `invalid_decision` no filtrada y `model_failure` reintentable (`recoverable`). Las razones `suspended`, `completed` y `cancelled` dan `null`. Tabla unitaria: `run-failure-recovery.test.ts` | Correcto |
| Fallas recuperables ⇒ handoff | `finishExecution` (`execution-runtime.ts:628-680`): `continued` ⇒ task `running` sin run; `exhausted`/`handed_off` ⇒ `handOffAfterRunFailureWithin` con la razón de `runFailureHandoffReason`. Telemetría `task.run_failure.contingency` | Correcto |
| Transiciones task/run | La run termina `failed`/`abandoned` con `details.runFailureRecovery`. La task pasa `running → blocked` con razón `run_*`, handoff de plataforma `requested` y `WAIT_FOR_HUMAN` (`temporal-runtime.ts:871-891`) | Correcto (S08, S11–S13) |
| Atomicidad | Todo ocurre dentro de la tx de `finishExecution` o de `claimNext` (abandono), bajo el lock de fila de la task. S57 inyecta una falla después de que el handoff escribió todo: ninguna escritura sobrevive y la reintentada aplica una vez | Correcto (S57) |
| Idempotencia | Ningún camino nuevo crea propuestas, ejecuciones ni claves. El aviso es único por `human_request_id` (`unique` + `on conflict do nothing`) | Correcto (S08/S53, S54, `reconciliation`) |
| Ciclos infinitos | Recuperación ADR-028 acotada por `maxRunFailureRecoveries`. Las contingencias no inician runs. Las validaciones rechazadas (`expiry_in_past`, `unknown_evidence`) continúan la run dentro de su presupuesto, cuyo agotamiento es contingencia. Si el final es irregistrable, el kernel registra `internal_failure` y, si también falla, deja la run para recuperación por lease, acotada por `maxRunRecoveries` (`kernel.ts:332-351`) | Correcto |
| Reinicio | El abandono por lease pasa a handoff en la tx del claim (S13). La suite `recovery` (SIGKILL reales) da 18/18 | Correcto |
| Sin HumanRuntime | `FORMERLY_TERMINAL` (`execution-runtime.ts:76`, `:795`): las cuatro razones que antes eran terminales vuelven a `failed`. `content_filter` y `model_failure` no reintentable lanzan `run_failure_handoff_unavailable`, igual que antes para `model_failure`; quedan acotados por la recuperación de lease. Los workers productivos siempre componen el Temporal Runtime (`apps/worker/src/platform.ts:117`) | Correcto (S15) |

## 3. G1-B — ADR-041

| Punto | Verificación | Resultado |
|---|---|---|
| Integración de PR #27 | `e25b6f8` y `1b2cefd` son cherry-picks `-x` de `387b720` y `93fe35a`. El PR no se tocó | Correcto |
| `human_request_id` | `0012`: columna `uuid unique references human_requests`, más el check `(origin = 'platform') = (human_request_id ∧ body ∧ ¬response_step_id ∧ ¬human_ref)`. Las filas `agent` y `operator` existentes lo cumplen | Correcto |
| Unicidad de avisos | `materializeRunFailureFallbacks`: select de handoffs `requested` de plataforma con razón en `RUN_FAILURE_HANDOFF_REASONS` y sin outbound, luego `insert … on conflict (human_request_id) do nothing`. Una carrera con un operador que toma el handoff entre el select y el insert produce un outbound que el gate cancela (`handoffPending = false`) | Correcto |
| Persistencia del Outbox | Mismo ciclo de vida que el outbound del agente (lease, fencing, sweep) | Correcto |
| Envíos inciertos | El aviso usa el mismo dispatcher: `unknown` nunca se reenvía (`delivery.test.ts:92`) | Correcto |
| WhatsApp | `decidePlatformDispatch` (`delivery.ts:116-126`) aplica kill switch, deny y rollout (hold), luego handoff pendiente, task terminal, binding cerrado, edad y ventana de servicio (cancel). Fuera de ventana ⇒ `window_closed` y `attention().undeliveredOutbound` | Correcto |
| Compatibilidad de `0012` | `origin/main` llega a `0011` y el PR #32 (Quote A10) no agrega migraciones: no hay colisión de número. `0012` nunca se aplicó fuera de BD de prueba. **Rollback:** `migrationStatus` (`migrations.ts:92-109`) no trata una migración aplicada y desconocida como `pending` ni `modified`, así que el código de `main` arranca sobre una BD con `0012`, y su gate cancela las filas `platform` por `humanOwned` (`delivery.ts:107`). Las pruebas `migration-upgrade*` y `migrations` cubren el upgrade | Correcto |

## 4. G1-C — Kernel

| Punto | Verificación | Resultado |
|---|---|---|
| KC-0 | `visibleCapabilities` (`agent-kernel/src/context.ts:150-153`) usa `limits.maxWriteActions - usage.writeActions`. `usage.writeActions` es durable y de alcance task (`countActionExecutions`, `execution-runtime.ts:427`), coherente con D-7 | Correcto |
| KC-2 | `DecideOutcome.invalid.finishReason`, registrado en `termination.details`. `finishReason` es obligatorio en `ModelResponse` y el gateway lo valida con zod (`model-gateway/src/gateway.ts:27`): nunca `undefined`. Sólo metadatos, nunca texto del modelo | Correcto |
| Protocolo v5 | `decision.ts`, `decision-parser.ts` y `request.ts` no cambian | Sin cambios |
| `KernelSession` | `agent-kernel/src/session.ts` no aparece en el diff | Sin cambios |

## 5. G1-D — Reproducción

Árbol `665b50c`, 2026-10-29, en serie y en un solo proceso por suite. Bitácoras en
`docs/architecture/evidence/j4-r7-g1/`.

| Suite | Resultado | Informe R7-1 |
|---|---|---|
| build limpio (`tsc -b`) | OK (54 s) | OK |
| typecheck | OK | OK |
| lint (`--max-warnings=0`) | OK | OK |
| unit | 1529 passed, 4 skipped | 1529 / 4 |
| contract | 452 / 452 | 452 |
| integration (`--no-file-parallelism`) | **642 passed, 12 skipped, 0 failed** (1046 s) | 642 / 12 / 0 |
| sales | 29 / 29 | 29 |
| shadow | 5 / 5 | 5 |
| recovery (sola, build de la rama) | **18 / 18** | 18 / 18 |
| mutaciones `runtime-contingency` | **11 / 11** | 11 / 11 |
| mutaciones `run-failure-fallback` | **6 / 6** | 6 / 6 |
| mutaciones `recovery` | **14 / 14** | 14 / 14 |
| mutaciones `production` | **23 / 23** | 23 / 23 |
| mutaciones `production-control` | **13 / 13** | 13 / 13 |

Todas las mutaciones restauraron sus fuentes byte a byte; el worktree revisado quedó limpio (`git status` vacío).

**Aislamiento.**
- `node_modules` de la rama es un directorio real. Sus dependencias de terceros son junctions al worktree
  `r4-j4-r6-closure`; los scopes `@r4`, `@r4-adapters` y `@r4-sales` apuntan a la propia rama. Se verificó con
  `Get-Item … .Target`.
- `recovery` y `build` resuelven `@r4/*` por `node_modules`, así que ejecutan el código de la rama.
- Vitest resuelve por alias a los fuentes.

### 5.1 Fallos intermitentes en paralelo

El informe de R7-1 registró 1–2 fallos intermitentes por corrida en paralelo: GAP-16 en
`sales-deterministic-offer-canary`, un timeout de 30 s en `production-control` y el heartbeat de `worker-kernel`. Se
investigaron en tres pasos, siempre alternando la rama con la base `d0bb7a7` (worktree `r4-j4-r6-closure`, sin
cambios de R7-1). Evidencia en `g1-parallel-comparison.txt` y `g1-stress-comparison.txt`.

**1. Paralelo sin otra carga** (paralelismo por archivo por defecto, 8 núcleos):

| Corrida | R7-1 `665b50c` | Base `d0bb7a7` |
|---|---|---|
| 1 | 642 passed, 0 failed (449 s) | 615 passed, 0 failed (315 s) |
| 2 | 642 passed, 0 failed (409 s) | 615 passed, 0 failed (452 s) |

Ningún fallo en 4 de 4. Los fallos del informe no son deterministas, y no aparecen sin carga externa.

**2. Bajo saturación de CPU** (los 3 archivos; 8 procesos de espera activa ocupan los 8 núcleos):

| Ronda | R7-1 | Base | Comentario |
|---|---|---|---|
| 1 | 20 / 55 fallan (production-control 11, deterministic-offer 8, worker-kernel 1) | 19 / 55 (9, 9, 1) | Misma distribución |
| 2 | 14 / 55 (5, 9, 0) | 38 / 55 (26, 9, 11) | La base coincidió con una regresión de Checkout ajena (más carga): se reporta, no se compara |
| 3 | 55 / 55 | 55 / 55 | Empezó después del tope de 1 h de la saturación: control sin carga |

**3. Clases de error** (iguales en ambas ramas):
- `Test timed out`: arranque de la CLI como proceso, BD migradas y canary completo bajo CPU saturada.
- `Connection terminated unexpectedly` del cliente PostgreSQL.
- Observaciones de una escritura congelada «en vuelo» que llegan fuera del instante esperado (`executions: ['executing']`).
- El heartbeat con lease de 1,5 s que no alcanza a renovar (`interrupted`).
- Una carrera de limpieza de un archivo de captura (`ENOENT`).

**Conclusión (con evidencia):**
- Los tres fallos del informe son **sensibilidad a tiempos del entorno, preexistente**: se reproducen a voluntad
  saturando la CPU, con la misma magnitud y las mismas clases de error en la base sin R7-1.
- Desaparecen sin carga.
- Ninguno ejercita código modificado por R7-1. Los timeouts de `production-control` ocurren al arrancar la CLI; el
  heartbeat y el lease no se tocaron.

**No es una regresión.** Recomendación (fuera de alcance):
- correr `integration` con `--no-file-parallelism` en las corridas de cierre, o con la máquina libre;
- en una fase de higiene, ampliar los plazos de esas pruebas.

## 6. Observaciones no bloqueantes

| # | Observación | Por qué no bloquea | Seguimiento |
|---|---|---|---|
| O-1 | Si una task tuviera un handoff `requested`/`active` y a la vez una run activa, el handoff de contingencia chocaría con `human_requests_one_handoff`. En el abandono, eso haría fallar la tx del claim en cada intento | No es alcanzable: todo camino que abre un handoff suspende la run activa y libera el lease (`holdForHumansWithin`, `decide` de `request_handoff`, el propio handoff de contingencia), y un `running` con handoff abierto no existe | Endurecimiento opcional: `handOffAfterRunFailureWithin` reutiliza un handoff abierto |
| O-2 | `npm run clean` (`tsc -b --clean`) no borra los `dist` de adaptadores ni del pack | Sólo afecta la higiene del worktree; el build desde cero se hizo borrándolos aparte | Documentado en el procedimiento |
| O-3 | El aviso sin entrada pendiente (presupuesto agotado en una run despertada por timer) | Declarado en la enmienda de ADR-041 | Lo resuelve `UNANSWERED` (R7-2/R7-3) |

## 7. Decisión

**`G1_PASS` → `R4_J4_R7_G1_APPROVED`.**

Fundamento:
- La revisión del código real no encontró defectos materiales en recuperación, ADR-041 ni kernel (§2–§4).
- La reproducción desde un build limpio coincide con el informe en todas las suites.
- Las 67 mutaciones se detectaron.
- Los fallos intermitentes están explicados con evidencia y son preexistentes (§5.1).
- No se corrigió nada en R7-1 (no hubo defecto material). Las observaciones O-1..O-3 no bloquean.

Con G1 aprobado se inició R7-2 en la rama `feat/r4-j4-r7-2-turn-completion-guard`.
