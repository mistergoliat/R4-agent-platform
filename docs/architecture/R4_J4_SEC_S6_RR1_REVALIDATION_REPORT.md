# R4-J4 SEC-S6 — Informe de implementación: revalidación RR-1 en las capacidades `customer.*`

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-SEC-OTP-ACCELERATED-IMPLEMENTATION-06` (Front B: solo SEC-S6) |
| Fecha | 2026-10-21 |
| Para | Owner de R4 |
| Rama | `feat/r4-j4-sec-s6-rr1-revalidation`, desde `origin/main` `38e19fd` (merge del PR #16, SEC-S2) |
| Autoridad | `R4_J4_RR1_BINDING_RACE_ANALYSIS.md` §4, §5.1, §6, §7, §8 · `R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md` §13 OA-09 · `AGENTS.md` |
| Alcance | **Solo SEC-S6:** `customer.get_context@3` y `customer.get_purchase_history@2` con revalidación de `V`, registro en la composición sintética, pruebas unit, integración RR1-T06, mutaciones y ajuste mínimo de la campaña interop. **Sin** cambios en el harness, `live-ops`, `persistence-postgres`, `apps/`, adaptadores, CIA ni CP. **Sin** despachador (RR1-T07/T08, SEC-S4/S5) ni `identity.verification_status` (RR1-T09) |

```text
SEC_S6_RR1_REVALIDATION_IMPLEMENTED
GATE_RR1_PENDING
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

`GATE_RR1_PENDING`: **SEC-S6 no cierra RR-1.** Cubre el punto 1 del gate (§7 del análisis) y la parte de RR1-T01…T06 del punto 3. Siguen pendientes: el punto 2 y RR1-T07…T09 (SEC-S4/S5), y la aceptación **por escrito** de los residuos R-1…R-3 por el owner (punto 4).

---

## 1. Qué se implementó

| Archivo | Cambio |
|---|---|
| `agents/sales/src/capabilities/customer-v3.ts` (nuevo) | `customerContextV3Capability` (`customer.get_context@3`) y `customerPurchaseHistoryV2Capability` (`customer.get_purchase_history@2`). Mismos esquemas de entrada y salida, mismas descripciones, mismo propietario, scopes y TTL que @2/@1. La proyección es la misma: reutiliza `readCustomerContextV2` y `readCustomerPurchaseHistoryV1` sin cambiarlos. Dependencias: `bindings: Pick<ProductionStore, 'bindingByTask' \| 'taskState'>` |
| `agents/sales/src/capabilities/customer-synthetic.ts` | `composeSyntheticCustomerCapabilities` devuelve **exactamente** `customer.get_context@3` y `customer.get_purchase_history@2`. Su opción `bindings` pasa a `Pick<ProductionStore, 'bindingByTask' \| 'taskState'>` |
| `tests/contract/customer-http-contract.test.ts` | La prueba de frontera incluye `customer-v3` y sus constructores: solo `customer-synthetic.ts` puede referenciarlos |
| `tests/interop/cia-cp-campaign.test.ts` | Ajuste mínimo: invoca `customer.get_context` versión 3 y el historial versión 2; `withResolver` construye las capacidades v3. **No se ejecutó** (`npm run test:interop` necesita los checkouts externos; corresponde a SEC-S7) |
| `tests/unit/sales/customer-v2-capabilities.test.ts` | Solo la parte que comprueba qué devuelve la composición sintética (ahora @3/@2) y el doble de `bindings` que se le pasa (con `taskState`). Las pruebas de los constructores @2/@1 no cambiaron |
| `tests/unit/sales/customer-v3-capabilities.test.ts` (nuevo) | 30 pruebas (§3) |
| `tests/integration/customer-rr1-revalidation.test.ts` (nuevo) | RR1-T06 y un caso sin carrera, contra PostgreSQL real (§3) |
| `tests/mutation/rr1-revalidation-mutations.mjs` (nuevo) + `npm run test:mutation:rr1` | 5 mutaciones (§5) |

**Versiones publicadas intactas.** `customer-v2.ts` y `customer-profile-outputs.ts` no cambiaron (diff vacío contra `38e19fd`). Los constructores @2/@1 siguen exportados con la misma definición y el mismo comportamiento, pero **ninguna composición los registra ya**.

**Sin registro productivo.** Ningún perfil, definición, CLI, bootstrap ni composición de producción referencia las versiones nuevas. Lo comprueba el contrato `customer-http-contract.test.ts`.

---

## 2. `V` y dónde se comprueba

```text
V(taskId, b₀) ≡ bindingByTask(taskId).bindingId = b₀ ∧ status = 'open'
              ∧ taskState(taskId).status ∉ {completed, cancelled, failed}   (TERMINAL_TASK_STATUSES)
              ∧ ¬ terminalIntent
              ∧ ¬ humanOwned                                                  (OA-09)
Un taskState ausente (null) hace fallar V.
```

`associationValid` lee `bindingByTask` y `taskState` en cada comprobación, sin caché.

| Punto | Qué hace `revalidatedRead` | Si `V` falla |
|---|---|---|
| T1 | `b₀ ← bindingByTask`; sin binding o cerrado → `anonymous` (comprobación de @2); después exige `V(taskId, b₀)` | `unavailable/anonymous`, **sin** llamada a la CIA ni a CP |
| T2 | `identity.resolve` con el sujeto del binding y solo el propósito de la capacidad | — |
| T2' | Exige `V(taskId, b₀)` | Descarta la resolución y el grant: `anonymous`, **sin** llamada a CP |
| T4 | El lector de frontera C (`readCustomerContextV2` / `readCustomerPurchaseHistoryV1`) lee CP y proyecta | — |
| T4' | Exige `V(taskId, b₀)` | Descarta los datos: `anonymous` |

Coste: en el camino feliz, 4 lecturas de `bindingByTask` y 3 de `taskState` por invocación, todas indexadas (la prueba del camino feliz lo fija).

Errores: un fallo de la CIA o de CP sigue siendo una observación `failed`, igual que en @2/@1. La revalidación solo convierte una asociación inválida en `anonymous`; nunca convierte un fallo en ausencia de cliente.

**Composición (AG-2).** Los constructores y la composición sintética lanzan `CustomerCapabilityCompositionError` si falta `taskState` (además de `bindingByTask`, la CIA o CP).

---

## 3. Pruebas por ID

Todas las carreras usan **barreras de promesas**, sin temporizadores. Las pruebas unitarias marcadas con (×2) se ejecutan para las dos capacidades.

| ID | Nivel | Montaje | Aserción | Estado |
|---|---|---|---|---|
| RR1-T01 (×2) | Unit | La CIA espera en la barrera; el binding pasa a `closed` | CP no se llama; salida `anonymous` | PASS |
| RR1-T02 (×2) | Unit | La CIA espera; `taskState` pasa a `cancelled` con el binding `open` | CP no se llama; `anonymous` | PASS |
| RR1-T03 (×2) | Unit | CP espera; el binding pasa a `closed` | `anonymous`; los datos de CP no aparecen en la observación | PASS |
| RR1-T04 (×2) | Unit | `terminalIntent = true` antes de T1 | Ni CIA ni CP | PASS |
| RR1-T05 (×2) | Unit | En T2' la tarea tiene otro `bindingId` (corrupción de `one_per_task`) | `anonymous`; sin CP | PASS |
| — (×2) | Unit | Tarea `cancelled`, `completed` o `failed` antes de T1 | `anonymous`; sin llamadas externas | PASS |
| OA-09 T1 / T2' / T4' (×2 cada una) | Unit | `humanOwned = true` antes de T1, durante la CIA o durante CP | `anonymous`; sin CIA (T1), sin CP (T2') o datos descartados (T4') | PASS |
| — (×2) | Unit | `taskState` ausente | `anonymous`; sin llamadas externas | PASS |
| — | Unit | Sin binding o binding cerrado | `anonymous`; sin CIA | PASS |
| — | Unit | Camino feliz | `verified` (contexto e historial); la CIA recibe el sujeto del binding; 3 lecturas de `taskState` y 4 de `bindingByTask` | PASS |
| — (×5) | Unit | El modelo pasa `customerRef`, teléfono, sujeto, `bindingId` o grant | `rejected/invalid_arguments` antes de leer nada (entrada estricta) | PASS |
| — | Unit | Constructores sin `taskState` u otro dueño | `CustomerCapabilityCompositionError` | PASS |
| — | Unit | Composición sintética | Devuelve exactamente `customer.get_context@3` y `customer.get_purchase_history@2` | PASS |
| — | Unit | Composición sintética sin `taskState` | `CustomerCapabilityCompositionError` | PASS |
| — | Integración | Webhook firmado → tarea y binding reales; invocación sin carrera | `verified`; `V` pasa con el estado real de una tarea nueva | PASS |
| **RR1-T06** | Integración (`LiveOpsTestbed`, PostgreSQL real, `PostgresProductionStore` real, `CapabilityInvoker` real, dobles de CIA y CP en proceso) | Webhook firmado crea tarea y binding; la CIA queda bloqueada en la barrera; `api.temporal.cancelTask(taskId, OPERATOR)` y luego un webhook nuevo del mismo cliente | El doble de CP **no recibe peticiones**; salida `anonymous`; el binding original queda `closed (task_cancelled)`; el inbound nuevo abrió un **binding nuevo** con una tarea nueva | PASS |
| RR1-T07…T09 | — | Despachador y `identity.verification_status@1` | **Fuera de SEC-S6** (SEC-S4/S5, Front A) | — |

**Lo que RR1-T06 no demuestra.** La fila del análisis pide además "ninguna observación de la invocación en la base". Esa garantía depende del `recordObservation` cercado por lease del worker. Como ningún perfil registra la capacidad, **la ruta del worker no se ejecuta** en esta prueba: la observación va a un store en memoria. **No se afirma esa garantía aquí.**

---

## 4. Resultados de validación

| Comprobación | Resultado |
|---|---|
| `npm run build` | OK |
| `npm run typecheck` | OK |
| `npm run lint` (`--max-warnings=0`) | OK |
| `unit` | 82 archivos (1 omitido) · **1 461 PASS**, 4 skip, 0 FAIL. Antes 1 431 (informe S2); +30 |
| `contract` | 30 archivos · **406 PASS**, 0 FAIL. Sin cambio de número (solo se amplió una aserción existente) |
| `integration`, ejecución completa (una vez) | 39 archivos (1 omitido) · **507 PASS**, 4 FAIL, 12 skip. Los 4 fallos son `Test timed out in 30000ms` en archivos no tocados: `sales-deterministic-offer-canary` (1), `production-control` (2) y `live-ops-reference` (1), más 1 error no manejado `Connection terminated unexpectedly` originado en `sales-deterministic-offer-canary`. `customer-rr1-revalidation` pasó (2/2). La máquina estaba compartida con otras ejecuciones pesadas (duración 703 s) |
| `integration`, reejecución de esos 3 archivos (`--no-file-parallelism`) | 3 archivos · **50/50 PASS** (9 + 27 + 14), 0 FAIL, sin errores no manejados (520 s). Los fallos de la ejecución completa son timeouts por carga, no regresiones. Combinando ambas ejecuciones: 511 PASS, 12 skip, 0 FAIL reales (S2: 509; +2 de `customer-rr1-revalidation`) |
| `sales` | **29/29** |
| `shadow` | **5/5** |
| `test:mutation:rr1` | **5/5** detectadas, fuente restaurada byte a byte |
| `customer-rr1-revalidation` aislado | 2/2 PASS |
| Caracteres | Sin caracteres invisibles en las fuentes nuevas (escaneo) |

El contenedor `r4-agent-platform-postgres` ya estaba en marcha y **no se detuvo** (lo usa Front A). No se ejecutó `npm run test:recovery` ni `npm run test:interop`.

---

## 5. Mutaciones (`npm run test:mutation:rr1`)

Cada mutación quita una comprobación de `customer-v3.ts`. Cada prueba listada se ejecuta **por separado** (filtro por nombre) y **todas** deben fallar. La línea base exige que cada filtro seleccione pruebas y pase en verde.

| # | Mutación | Pruebas que deben fallar | Resultado |
|---|---|---|---|
| RR1-M1 | Quitar T2' | RR1-T01, RR1-T02 | DETECTADA (2 y 2 fallos) |
| RR1-M2 | Quitar la comprobación de `taskState` (estado terminal y `terminalIntent`) | RR1-T02, RR1-T04 | DETECTADA (2 y 2) |
| RR1-M3 | Quitar T4' | RR1-T03 | DETECTADA (2) |
| RR1-M4 | Quitar la comprobación de `humanOwned` | humanOwned en T1, T2' y T4' | DETECTADA (2, 2 y 2) |
| RR1-M5 | Quitar la `V` de T1 (queda solo la comprobación de estado del binding de @2) | RR1-T04 | DETECTADA (2) |

La mutación del despachador (RR1-T07) corresponde a Front A y no se añadió.

---

## 6. Fronteras

- **Harness sin cambios:** `git diff --stat 38e19fd` sobre `packages/{agent-kernel,task-runtime,capability-runtime,context-compiler,model-gateway,policy-engine,contracts,observability}` está vacío.
- **Sin cambios** en `packages/` (incluidos `live-ops` y `persistence-postgres`), `apps/` ni `adapters/`. La CIA y CP no se tocaron.
- **Contratos aceptados intactos:** las versiones nuevas reutilizan los esquemas y la proyección de @2/@1. `customer-v2.ts` y `customer-profile-outputs.ts` no cambiaron.
- **Sin conceptos de dominio en el Core:** todo vive en el pack Sales. Solo se usan los puertos ya existentes `bindingByTask` y `taskState`, y la constante `TERMINAL_TASK_STATUSES` de `@r4/contracts`.
- **Sin registro productivo** (contrato). `R4_CUSTOMER_MODE=real` sigue rechazado por los adaptadores.

---

## 7. Riesgos residuales (análisis RR-1 §8)

| # | Residuo | Estado tras SEC-S6 |
|---|---|---|
| R-1 | Una lectura en la CIA o en CP en vuelo cuando la sesión termina | **Acotado, no eliminado.** T2' impide la llamada a CP tras un `resolve` en vuelo; T4' descarta los datos de una lectura de CP en vuelo. La CIA sigue emitiendo el grant (≤ 300 s, sin portador fuera del proceso) y CP sigue auditando `accepted`. Eliminarlo exige H-ALT-1 (cambio de harness, no autorizado). **Pendiente de aceptación escrita del owner** |
| R-2 | Correo de verificación enviado durante un `start` en vuelo | Fuera de SEC-S6 (SEC-S4/S5). **Pendiente de aceptación** |
| R-3 | Vínculo creado por un `confirm` en vuelo tras el cierre | Fuera de SEC-S6 (despachador). **Pendiente de aceptación** |
| R-4 | Sin trigger de inmutabilidad de las columnas de identidad del binding | Sin cambios. RR1-T05 prueba que un `bindingId` distinto en T2' da `anonymous`, pero un cambio de `account_ref`/`recipient_ref` sobre el **mismo** `bindingId` no lo detecta `V`. Requiere el trigger de ADR-038:312 en un mandato propio |

---

## 8. Limitaciones

- RR1-T06 no ejercita el worker ni el `recordObservation` cercado (§3). La garantía "nada llega a la base" sigue apoyándose en el fencing existente, no en esta prueba.
- La detección es por relectura: entre T2' y el inicio de la llamada a CP, y durante cada llamada externa, queda la ventana de una llamada (R-1). La cancelación no se propaga a la `signal` de la capacidad (H-ALT-1, no recomendada ahora).
- La campaña interop se adaptó para compilar y apuntar a @3/@2, pero **no se ejecutó** en SEC-S6 (SEC-S7).
- Bajo carga compartida, la suite de integración completa mostró timeouts preexistentes en archivos no tocados (§4).

---

## 9. Baseline y commits

| | Valor |
|---|---|
| Baseline | `origin/main` `38e19fd5dbe84548ccaea28545946c0ef7905265` (merge del PR #16) |
| CIA / CP | Sin cambios |
| Commit de implementación | `11abbc637792f934a1dc91ffa79d1bb018e29880` |
| Commit de documentación | El que añade este informe |
| Autor | `MisterGoli <joaqutorres@alumnos.uai.cl>` |
| Publicación | Rama publicada. **Sin PR ni merge:** Front A la integra con un merge commit explícito |
