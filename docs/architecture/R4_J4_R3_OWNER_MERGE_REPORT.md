# R4-J4-R3 — Aceptación del owner y merge de la integración sintética CIA–CP

| Campo | Valor |
|---|---|
| Mandato | `R4-J4-R3-OWNER-MERGE-01` |
| Fecha | 2026-10-21 |
| Para | Owner de R4 |
| PR de integración | [#12](https://github.com/mistergoliat/R4-agent-platform/pull/12): `feat/r4-j4-r3-cia-cp-synthetic` → `main` |
| Alcance | Solo sintético. **Sin despliegue, sin perfiles productivos, sin datos reales.** CIA, CP, el harness, el webhook y ChannelIngress no se modificaron |
| Informes previos | `R4_J4_R3_CIA_CP_INTEGRATION_REPORT.md`, `R4_J4_R3_SEC_OTP_FOLLOWUP.md` |

```text
R4_J4_R3_OWNER_ACCEPTED
R4_J4_R3_MERGED_TO_MAIN
R4_J4_R3_SYNTHETIC_INTEROP_PASS
R4_HARNESS_UNCHANGED
R4_LIVE_CUSTOMER_CAPABILITIES_DISABLED
SEC_OTP_01_PENDING
SEC_OTP_02_PENDING
G16_PENDING
D7_PENDING
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

---

## 1. Resultado del merge

| | SHA |
|---|---|
| `main` antes | `3e7b4eec6772ffd4f192a3c78fe89dbe39d4f05a` (merge del PR #11, R4-J4-R2) |
| Head autorizado de R3 | `f6d1d766aeee68eb9a4518e2f77b3fd2019b9409` |
| `main` después | `ad2c39b403f670c63d7e3c2e7dc91d022bf1826a` |

**Método:**
- PR #12, fusionado con merge commit normal mediante `gh pr merge 12 --merge --match-head-commit f6d1d766aeee68eb9a4518e2f77b3fd2019b9409`, el 2026-10-21 a las 15:03:33 UTC.
- Antes del merge se confirmó que el head del PR era exactamente el SHA autorizado. `--match-head-commit` habría abortado la operación si hubiera cambiado.
- Sin squash, rebase, force-push ni reescritura de historia.
- El primer intento fue bloqueado por el clasificador de permisos de la sesión. El merge se ejecutó tras la autorización expresa del owner, con aprobación del permiso y sin eludir el clasificador.

**Commit de merge `ad2c39b`:**
- Padres: `3e7b4ee` (primero) y `f6d1d76` (segundo).
- Su árbol es **idéntico** al de `f6d1d76` (`git rev-parse <commit>^{tree}`). El merge no introdujo ningún contenido distinto del árbol validado.

## 2. Decisiones del owner

| Decisión | Contenido aceptado |
|---|---|
| **OWNER-R3-01** `sessionRef` | Se añade `sessionRef` al puerto `ChannelSubject`. Su origen es exclusivamente `ProductionStore.bindingByTask(taskId).bindingId`. Ningún argumento del modelo puede establecerlo ni sustituirlo |
| **OWNER-R3-02** Tests R2 | Se aceptan los cambios de aserciones R2 necesarios para el transporte obligatorio del grant y el rechazo de `service_scope_only` en el flujo protegido. Los contratos y fixtures históricos rc1 se conservan íntegros (§3) |
| **OWNER-R3-03** Binding cerrado | Un binding cerrado se representa como `unavailable/anonymous`, sin consultar CIA ni CP. La clausura concurrente durante una invocación ya iniciada queda como riesgo residual separado (§6, RR-1). No se modificó el harness |
| **OWNER-R3-04** Interoperabilidad | Se aceptan los 23 escenarios con su clasificación E2E, FAULT y ADAPTER (informe R3 §11). **No se afirma** que un servicio desplegable de R4 ni WhatsApp haya ejecutado el flujo E2E: el lado R4 de la campaña corrió desde fuentes (vitest) |

## 3. Preflight e integridad

| Comprobación | Resultado |
|---|---|
| `origin/main` antes del merge | `3e7b4ee`, igual a la base conocida |
| SHA completo de R3 (local y remoto) | `f6d1d766aeee68eb9a4518e2f77b3fd2019b9409` |
| `main` ancestro de R3 | Sí. La historia es lineal: 7 commits sobre `3e7b4ee` |
| Cambios ajenos | Ninguno. Los 7 commits (`adaa413`, `f026059`, `6a7c117`, `1a3587e`, `d5885ae`, `26a77e8`, `f6d1d76`) son de R4-J4-R3, todos del mismo autor |
| Diff `26a77e8..f6d1d76` | Solo documentación: `R4_J4_R3_CIA_CP_INTEGRATION_REPORT.md` (+389) y `R4-J4-R1C_SHARED_DECISION_REGISTER.md` (+9) |
| Diff `d5885ae..f6d1d76` (último commit con código) | Solo documentación: los dos anteriores y `R4_J4_R3_SEC_OTP_FOLLOWUP.md` |
| Contrato CIA v1-D2 | Fijado a la CIA `7525395d14d72c36853add31b327c6ebd5fb9e73` (`SOURCE.json`, `revision: v1-d2`). Verificado byte a byte por `identity-http-contract.test.ts` |
| Contrato CP v1-rc2 | Fijado a CP `bbd766ef4b32c0ceb1065f9b7791f63f46798ef9`. `customer-http-v1-rc2-contract.test.ts` verifica sha256, hash de contenido y git blob de cada archivo, y su concordancia con `owner-SOURCE.json` y `MANIFEST` |
| Contrato y fixtures rc1 | `git diff 3e7b4ee f6d1d76 -- adapters/domains/customer/http/contract adapters/domains/customer/http/fixtures` vacío |
| CIA y CP | `origin/main` de la CIA sigue en `7525395` y el de CP en `bbd766e`: sin cambios desde las versiones fijadas |
| Worktrees y archivos sin seguimiento | Todos preservados. Solo se añadió el worktree documental de este informe |

## 4. Pruebas y regresiones

La funcionalidad no cambia desde `d5885ae` y el árbol de `main` es idéntico al de `f6d1d76`. Por eso **no se repitieron** la campaña de tres servicios ni las suites con PostgreSQL. Se conserva la validación funcional del informe R3.

**Ejecutado en este mandato, sobre `f6d1d76` (= árbol de `main`):**

| Comprobación | Resultado |
|---|---|
| `npm run build`, `typecheck`, `lint` (`--max-warnings=0`) | OK |
| `unit` | 79 archivos (1 omitido) · **1 271 PASS**, 4 skip, 0 FAIL |
| `contract` | 29 archivos · **397 PASS**, 0 FAIL |

Ambos conteos coinciden exactamente con el informe R3.

**Conservado del informe R3**, ejecutado sobre `d5885ae` y el clon limpio `26a77e8`:

| Comprobación | Resultado |
|---|---|
| `integration` (PostgreSQL) | **471 PASS**, 12 skip preexistentes |
| `sales` | **29/29** |
| `shadow` | **5/5** |
| Campaña R4 → CIA → CP | **23/23** en 3 ejecuciones. La tercera, sobre un clon limpio del remoto |

### GitGuardian

El check de GitGuardian del PR #12 falló con dos detecciones de tipo *JSON Web Token*:

| Incidente | Commit | Archivo |
|---|---|---|
| 38772495 | `6a7c117` | `tests/unit/customer-profile/support.ts:24` |
| 38772494 | `1a3587e` | `tests/unit/sales/customer-v2-capabilities.test.ts:25` |

**Ambos son constantes de test sintéticas `GRANT_TOKEN`, no credenciales.** Decodificados:
- header `{"synthetic":true}`;
- payloads `{"not":"a real grant"}` y `{"task":"a"}`;
- firma, el texto literal `synthetic-signature`.

Nada que revocar ni rotar. El owner los aceptó como falsos positivos sintéticos.

**Pendiente:** clasificar los incidentes 38772494 y 38772495 como falsos positivos en el dashboard de GitGuardian. **A la fecha de este informe no se han cerrado.** El check no es obligatorio en `main`, así que no bloqueó el merge.

## 5. Validación posterior al merge

| Comprobación | Resultado |
|---|---|
| `origin/main` | `ad2c39b403f670c63d7e3c2e7dc91d022bf1826a` |
| `main` local y remoto | Sincronizados (`git fetch origin main:main`, avance rápido `03080ed..ad2c39b`) |
| Commits R3 en `main` | Los 7 son ancestros de `origin/main` (`git merge-base --is-ancestor`) |
| Integridad de contratos | El árbol es idéntico a `f6d1d76`. Los tests de contrato pasaron sobre ese árbol (§4) |
| Capacidades Customer en perfiles productivos | **Ausentes.** Ver detalle abajo |
| `R4_CUSTOMER_MODE=real` | Rechazado con `customer_real_data_blocked` en ambos adaptadores (`adapters/domains/customer/http/src/config.ts`, `adapters/domains/identity/http/src/config.ts`). Cubierto por `tests/unit/customer-profile/config.test.ts` y `tests/unit/customer-identity/client.test.ts` |
| Harness, webhook, ChannelIngress | Sin cambios. `git diff 3e7b4ee ad2c39b` no toca `agents/sales/src/harness`, `agents/sales/src/production`, `apps/` ni `packages/`, y ningún archivo de webhook o ingress |
| CIA y CP | Sin cambios (§3) |
| Despliegue | Ninguno (§7) |

**Detalle de las capacidades Customer:**
- `customer.get_context@2` y `customer.get_purchase_history@1` solo se registran en `agents/sales/src/capabilities/customer-synthetic.ts`.
- No las referencian `agents/sales/src/production/`, `composition.ts`, `definition.ts`, ni la CLI.
- La composición productiva sigue declarando la identidad del cliente como no disponible (`customerRef: null`).
- `sales-production@8` (J4-R4) no existe.
- Lo protege el test de frontera de `customer-http-contract.test.ts`.

## 6. Riesgos pendientes

| # | Riesgo | Estado |
|---|---|---|
| RR-1 | Clausura concurrente de un binding durante una invocación ya iniciada (OWNER-R3-03). La invocación puede completar con el binding leído al inicio | Abierto, registrado por separado. Sin cambios al harness en este cierre |
| RR-2 | Revocación v1: un grant ya emitido sigue válido en CP hasta `exp` (≤ 300 s) (DM-06, L3) | Abierto, aceptado para sintético |
| RR-3 | Deuda L-1 de CP: expiración durante la composición → 500. R4 la clasifica como `temporarily_unavailable` (L6) | Abierto en CP |
| RR-4 | R4 no inicia verificaciones ni confirma OTP (L7) | SEC-OTP-01/02 pendientes |
| RR-5 | Incidentes GitGuardian 38772494 y 38772495 sin clasificar en el dashboard | Pendiente de acción del owner |
| — | G-16, AP-01 a AP-11, D7 y J4-R4 (`sales-production@8`) | Pendientes. Cada uno requiere su propio mandato |
| — | Acceso a datos reales de clientes | **Bloqueado** |

## 7. Ausencia de despliegue

- Ningún despliegue en EC2 ni en otro entorno.
- No se registró ninguna capacidad Customer en perfiles productivos ni se activó `sales-production@8`.
- No se modificaron la CIA, CP, el harness de R4, el webhook, ChannelIngress ni PrestaShop.
- No se incorporaron credenciales productivas ni se accedió a datos reales.
- No se inició SEC-OTP-IMPLEMENTATION.

## 8. Dictamen

```text
R4_J4_R3_OWNER_ACCEPTED
R4_J4_R3_MERGED_TO_MAIN                  (PR #12, merge commit ad2c39b)
R4_J4_R3_SYNTHETIC_INTEROP_PASS          (23/23; E2E, FAULT y ADAPTER; sin servicio R4 desplegable ni WhatsApp)
R4_HARNESS_UNCHANGED
R4_LIVE_CUSTOMER_CAPABILITIES_DISABLED
SEC_OTP_01_PENDING
SEC_OTP_02_PENDING
G16_PENDING
D7_PENDING
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```
