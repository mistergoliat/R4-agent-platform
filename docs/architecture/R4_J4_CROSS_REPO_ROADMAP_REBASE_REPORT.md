---
title: R4-J4 — Auditoría cruzada y rebase del roadmap (R4 · CP · CIA)
status: for-owner-review
mandate: R4-J4-CROSS-REPO-ROADMAP-REBASE-08
date: 2026-10-22
---

# R4-J4 — Auditoría cruzada y rebase del roadmap

Mandato `R4-J4-CROSS-REPO-ROADMAP-REBASE-08`. Auditoría de **solo lectura** de los tres
repositorios, merge autorizado del PR #17 y actualización documental del roadmap.

En este mandato **no** se implementó código. **No** se tocaron el harness, CIA ni CP. **No** hubo
despliegues, datos reales ni envíos de correo u OTP.

```text
SEC_OTP_PR17_MERGED            (main caa392642117ee0cf40be3b7bf91b3eea153afbb)
R4_J4_ROADMAP_AUDITED
CP_J4_READINESS_AUDITED
CIA_J4_DEPENDENCIES_AUDITED
J4_R4_R5_R6_BACKLOG_DEFINED
J5_SCOPE_SEPARATED
CHECKOUT_PARALLEL_UNCHANGED
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
J4_ROADMAP_READY_FOR_OWNER_REVIEW
```

**Convención.** Un estado **DONE** exige código en `main`. Nada se marca DONE solo porque exista un
documento o una rama sin integrar. "Sintético" significa que no se probó con servicios desplegados
ni con datos reales.

---

## 1. Baselines (2026-10-22)

| Repositorio | `origin/main` | HEAD local / worktrees | PR / CI |
|---|---|---|---|
| **R4-agent-platform** | `caa392642117ee0cf40be3b7bf91b3eea153afbb` (merge PR #17; padres `38e19fd` + `89d8342`) | Checkout principal en `feat/r4-j4-customer-adapter-r2` `3f2b216` (ya fusionada), con un archivo sin seguimiento ajeno a este mandato. 11 worktrees, todos limpios. El de este mandato es `dev/r4-j4-roadmap-rebase` | PR #1–#17 fusionados. CI: solo GitGuardian |
| **MS-pesaschile-customer-profile** | `bbd766ef4b32c0ceb1065f9b7791f63f46798ef9` (PR #27) | Checkout principal en `feat/cp-j4-context-02c-synthetic` `6801a90`: 0 adelante y 18 atrás, obsoleto. Worktree `cp-j4-s5-d2-alignment` en `9a1e27e`: **sin fusionar y sin PR**. Worktree `cp-j4-s5-grant-verifier` en `a137961`: fusionado | PR #23–#27 fusionados; ninguno abierto. **Sin `.github/workflows`.** Solo GitGuardian. Tag `cp-sales-context-v1-rc1` → `47db415` |
| **MS-pesaschile-customer-identity-authority** | `7525395d14d72c36853add31b327c6ebd5fb9e73` | Checkout en `feat/cia-s4-grant-issuance` `df66f92`, limpio. El `main` local va 2 commits atrás de origin. Worktree `cia-d2-contract-revision` en `7525395`, limpio | **Ningún PR en la historia** (push directo). **Sin CI** |

El runtime de CIA (`src/`, `migrations/`) es idéntico entre `df66f92` (S4) y `7525395`. Los dos
commits D2 solo agregan contrato, documentación y `tests/contract-d2.test.ts`.

Producción de CP: la última evidencia disponible es `23a2ef3`, anterior a J4. Proviene del informe
de la rama sin fusionar `9a1e27e`. **No se verificó en este mandato** (no se accedió a EC2).

---

## 2. Resultado del PR #17

| Condición del preflight | Resultado | Evidencia |
|---|---|---|
| Historia SEC-S3 → S7 | S3 `f0dd38d`, S4 `9d555cd`, merge explícito de S6 `993388d` (padres S4 y `1d6e26a`), S5 `7805a91`, S7 `129586c`, docs `13d4990` y `89d8342` | `git log --graph` |
| HEAD completo | `89d8342bff2d8786317d5eb65301d6c6a66e3b5d`, el mismo antes y después de la triage | `gh pr view 17` |
| Harness | `git diff --stat` vacío en `agent-kernel`, `task-runtime`, `capability-runtime`, `context-compiler`, `model-gateway`, `policy-engine`, `agent-registry`, `contracts`, `evaluation`, `observability`, `shadow`, `apps/{worker,api,scheduler}` | diff contra `38e19fd` |
| Cambios fuera de adaptadores | `live-ops` (puerto `InboundInspector`, aditivo, ADR-040, OA-01: fuera del kernel) y `persistence-postgres` (`recordInboundInspected`) | diffstat |
| Contratos CIA | **48/48** archivos fijados en `SOURCE.json` coinciden en blob con el owner `7525395:<sourcePath>` | script de verificación por `git rev-parse` |
| Contrato CP | Sin cambios en `adapters/domains/customer/http/contract*` | diff |
| Evidencia S7 | Los sha256 de `campaign.log`, `r3-evidence.json` y `sec-otp-evidence.json` (runs 1–3) coinciden con el informe S7. `head.txt` = `129586c` en los 3 runs, 41/41 | `sha256sum` sobre `git show` |
| Commits posteriores a S7 | Solo `docs/` | `git diff --name-only 129586c 89d8342` |
| Secretos | Único hallazgo: `GRANT_TOKEN` sintético (`{"synthetic":true}.{"task":"a"}.synthetic-signature`), idéntico a la constante que ya estaba en `main` | barrido de patrones sobre el diff |
| GitGuardian | 1.ª lectura: **FAILURE** (incidente 38772494). Se suspendió el merge. El owner etiquetó el incidente como falso positivo. 2.ª lectura: `skipped`, «You tagged this GitGuardian alert as a false positive»; `mergeStateStatus=CLEAN` | API de check-runs |
| Regresión y mutaciones | Unit 1519, contract 414, integration 579, sales 29, shadow 5. Mutaciones S1 23/23, S2 16/16, S3 13/13, S4 11/11, S5 9/9, RR-1 5/5. **Valores tomados de los informes del PR: no se re-ejecutaron.** El árbol fusionado es idéntico al validado | informe consolidado SEC-OTP |

**Merge.** Se ejecutó `gh pr merge 17 --merge --match-head-commit 89d8342bff2d8786317d5eb65301d6c6a66e3b5d`,
como merge commit normal: sin squash, rebase ni force-push. Ocurrió el 2026-10-22T16:07:33Z.

**Integridad.**
- `main` = `caa392642117ee0cf40be3b7bf91b3eea153afbb`.
- Tree `1c36ac8de372bec08784851ff98f41844edec7dd`, idéntico al tree de `89d8342`.
- El diff entre `89d8342` y `main` está vacío.

El merge **no cierra** ningún gate. Siguen abiertos RR-1, RS-01..04, BA-01..06, OA-10, G-16, AP-* y D7 (§5).

---

## 3. Matriz J4-R1 a J4-R6 (R4)

Fuentes de la definición:
- `R4-J4-R1_DESIGN_REPORT.md` §5 (plan revisado);
- `R4_J4_R0_INTEGRATION_PREFLIGHT_REPORT.md` §8;
- ADR-039 §8–§10.

**Deriva detectada.** Ambos planes nombran `get_context@2` y `get_purchase_history@1` y no mencionan
`identity.*`. Tras SEC-S5 y S6, las versiones vigentes son `@3`, `@2`, `identity.start_verification@1`
e `identity.verification_status@1` (§3.1).

| ID | Owner | Entregable | Evidencia | Estado | Integración | Gate | Dependencias | Siguiente acción | Hito |
|---|---|---|---|---|---|---|---|---|---|
| J4-R1A | R4 | ADR-039, especificación del consumidor, D1–D8 | ADR-039 `ACCEPTED_INTERNAL_R4` (2026-10-15); `R4-J4-R1_*` | DONE (diseño) | main | — | — | Actualizar el bloque de estado de `R4-J4-R1_DESIGN_REPORT.md` §6 (D1/D2 obsoletos) | J4 |
| J4-R1B | CIA, CP, R4 | Contratos externos versionados | CIA v1-d2 aceptado **solo para interop sintética** (CIA `V1_D2_ACCEPTANCE.md`, owner commit `35528b9`). D1 designado: CIA-D1-01. CP `sales-context` v1-rc2 `contractStatus: candidate`, `publishedApi: false` | PARTIAL | main (contratos candidatos) | G-16; AP-01..11; contratos `approved` | CP owner, CIA owner | Pronunciamiento formal de CP (G-16, AP-*) | J4 |
| J4-R2 | R4 | Adaptador CP (`CustomerProfilePort`, HTTP, fixtures del owner) | `adapters/domains/customer/http` (`b858fe2`, `15af63e`); pin v1-rc2 → CP `bbd766e` (`ad2c39b`); `R4_CUSTOMER_MODE=real` rechazado | DONE (alcance sintético) | main | Real: G-16, contrato `approved` | — | Ninguna en J4 sintético | J4 |
| J4-R3 | R4 | Resolver CIA, grant hacia CP, resolución perezosa | `adapters/domains/identity/http` (PR #12 `ad2c39b`); interop 23/23 ×3 | DONE (alcance sintético) | main | — | — | — | J4 |
| SEC-S1..S7 | R4 | Protección OTP: clasificador, estado sellado, inspección de ingress (ADR-040), confirm diferido, capacidades comerciales, RR-1 V(task, binding) | PR #15, #16, #17 (`caa3926`); campaña S7 41/41 ×3 | DONE (alcance sintético) | main | RR-1 R-1..R-3; RS-01..04; BA-01..06; OA-10 (§5) | Owner | Decisiones del owner (§5) | J4 |
| J4-R4.a | R4 | Bloques de capacidad `customer.get_context@3`, `customer.get_purchase_history@2`, `identity.start_verification@1`, `identity.verification_status@1` | `customer-v3.ts`, `identity-verification.ts`. Los registra solo `customer-synthetic.ts` (test de frontera `customer-http-contract.test.ts`) | DONE (bloques) | main, sintético | — | — | — | J4 |
| J4-R4.b | R4 | Perfil `sales-production@8` + definición v8 | **No existe.** Último perfil `@7` (`profile-v7.ts`). `SALES_DOMAINS` sin dominio `identity` (`profile.ts:7`); `@1`–`@7` declaran `customer: UNAVAILABLE` | BLOCKED (sin autorización) | — | Autorización J4-R4 | D6 cerrada o diferida (está diferida con `catalogKey: null`) | Ver §3.1 | J4 |
| J4-R4.c | R4 | Composición productiva fail-closed de `@8` | `composeSalesProductionWorker` no registra Customer (`composition.ts`). `assertProductionComposition` rechaza capacidades de dominios no disponibles | BLOCKED | — | Composición rechaza config incompleta | J4-R4.b | Ver §3.1 | J4 |
| J4-R4.d | R4 | Degradación de Customer (ADR-039 §9, I7) | Capacidades de solo lectura opcionales; `quote.create@5` usa `guest`. Probado solo en sintético; falta la prueba de composición `@8` | PARTIAL | main (bloques) | I7 en `@8` | J4-R4.c | Prueba de integración «CP caído → quote `guest` emitida» | J4 |
| J4-R4.e | R4 | Compatibilidad worker/modelo de `@8` | Precedente `@7` (J3E-C1 §7–§8) | BLOCKED | — | §3.2 | J4-R4.b–c | Ejecución mínima pareada `@7`/`@8` (§3.2) | J4 |
| J4-R5 | R4, CP, CIA, Operación | Canary aislado con servicios de prueba desplegados, solo datos sintéticos | Tooling canary `agents/sales/src/cli/canary/*` limitado a `@4`–`@7` (`runtime.ts`). Campaña S7 **local** | BLOCKED | — | I4 e I7 con servicios desplegados; 0 clientes reales verificados; evidencia etiquetada | R4-R4; CIA y CP desplegables (§4); autorización EC2; decisiones §3.3 | Ver §3.3 | J4 |
| J4-R6 | R4, Operación | Ensayo de rollback del canary `@8 → @7`, recuperación, observabilidad, registro de aceptación | Precedente: gate `rollback-runbook` de `@7`. Protocolo de protección durante rollback (SEC plan §5; S7 escenario C) | BLOCKED | — | R5 PASS; §3.4 | J4-R5 | Ver §3.4 | J4 |

### 3.1 J4-R4 — brecha hacia una composición versionada de Sales

El identificador vigente propuesto sigue siendo `sales-production@8` con la definición v8. **No hay
reserva de código:** `@8` aparece solo en comentarios. El identificador queda a confirmar por el
owner al autorizar J4-R4.

| # | Trabajo | Detalle |
|---|---|---|
| 1 | Perfil `@8` | `@7` más un dominio `customer` disponible (con `contractRef` de CP v1-rc2) y un **nuevo dominio `identity`**. Agrega las entradas `customer.get_context`, `customer.get_purchase_history`, `identity.verification_status` (lectura) e `identity.start_verification` (escritura). Catalog, Shipping y Quote se mantienen como en `@7` |
| 2 | Versiones de capacidad | Las entradas de perfil no llevan versión. Las versiones (`@3`, `@2`, `@1`, `@1`) solo existen en el código de composición. Hace falta un test de contrato que fije el mapa id → versión, porque la huella no lo captura |
| 3 | Definición v8 y pin | `SALES_PRODUCTION_AGENT_VERSIONS['sales-production@8'] = 8`; v3–v7 sin cambios |
| 4 | Política de acción | Unir `sales-production-autonomous-policy@1` (`@7`) con `identity.start_verification: allow` (OA-05). Hoy esa regla vive solo en la política sintética |
| 5 | Composición fail-closed | Rama `@8` que exige la config de CIA y CP, `taskState`, `thread` y el pool `identity_verification`. Con config incompleta, rechazo; con config completa, registra exactamente las capacidades del perfil (especificación §9.2). Los adaptadores mantienen el rechazo de `real` |
| 6 | Acoplamiento con el gateway | `identity.start_verification` exige que el gateway componga `VerificationInspector` en modo `full` (ADR-040) y que estén aplicadas las migraciones 0012–0014. Sin el inspector, el código OTP llegaría al texto persistido |
| 7 | Límites y config | Tope de 8 KiB en la proyección (ADR-039 Cond. 5); frescura D5; reenvío CIA ≥ 60 s y 5 correos por día; `R4_EXEC_MAX_WRITE_ACTIONS` debe cubrir la escritura de identidad; decisión `R4_CONTEXT_EXPIRED_EVIDENCE` (Cond. 2) |
| 8 | Permisos | CP: scope `customer.sales_context.read`, sin `pii.read` ni `analytics.read`. CIA: credencial de agente `r4-sales` (OA-06). La credencial `confirm` y el keyring quedan solo en el gateway |
| 9 | No regresión | Huellas de `@1`–`@7` y definiciones v3–v7 fijadas como en J3E-C1. El test de frontera se amplía para admitir solo la composición `@8`. Inventarios: `sales-boundaries`, `sales-profile-v3`, `loader`, `agent-registry`, `api`, `production-bootstrap`, `sales-canary` |

### 3.2 Pruebas mínimas de worker/modelo para J4-R4 (no son evaluación comercial)

**Determinísticas:**
- contract: huella de `@8`, mapa de versiones y hash de política;
- integración de composición: rechazo por cada dependencia faltante;
- casos verified / anonymous / provisional / owner caído;
- I7 (quote `guest` con CP caído);
- reutilización de RR1-T01..T09;
- mutaciones: quitar la guarda de config de `@8` y quitar la revalidación V.

**Con modelo real.** Ejecución exploratoria pareada `@7` vs `@8` con la configuración de modelo
fija y el método de J3E-C1. Mide solamente:
1. tasa de decisiones válidas en la primera llamada;
2. ausencia de `invalid_decision` atribuible a los nuevos esquemas;
3. fidelidad de copia de `@7` sin cambio;
4. el modelo nunca repite código, ref ni grant (proyección D4).

No es aprobación de rollout. Las evaluaciones de estrategia comercial son **J5/J6** (§8).

### 3.3 J4-R5 — pendiente para el canary aislado

| Área | Pendiente |
|---|---|
| R4 | `@8` (R4-R4). Extender el tooling canary a `@8`. Permitir red, con opt-in explícito, hacia los hosts de prueba: hoy la composición sintética es solo loopback (`allowNetwork: false`). Plan de limpieza de la BD canary |
| CIA | `validateConfig` y `src/isolation.ts` **rechazan todo lo que no sea loopback**: host, BD, egress, emisor `.test` y sender falso. No existe artefacto de despliegue ni aceptación del runtime (solo del contrato). Un canary desplegado requiere un mandato de CIA (§4.2) |
| CP | Despliegue de S5 no autorizado. Sin CI, contenedor ni configuración de proceso versionados. `enforce` y el principal `r4-sales` no están configurados en ningún entorno. Contención de red de `:3010` (D3/H-1, X7). X6 (correlation id, 503/504 tipados, rate limit) **no implementado** |
| Decisiones | `R4_CONTEXT_EXPIRED_EVIDENCE`; lista de identidades sintéticas aprobada por el owner; D7 limitado a datos sintéticos; procedimiento contra réplicas mixtas (R3-04) |
| Autorización | EC2 explícita y separada de producción (precedente J3E: checkout aislado y BD `:55434`) |

### 3.4 J4-R6 — rollback, recuperación, observabilidad y aceptación

- **Rollback de J4:** únicamente `@8 → @7` **en el runtime canary**. Requiere:
  - que no queden ejecuciones huérfanas de Customer ni de `identity.start_verification`;
  - `@7` intacto;
  - regresión completa, incluido GAP-15.
- **Protección durante el rollback** (SEC plan §5): primero se detienen los `start`. Después se pasa
  a `protect_only` y se espera a que `protectionActive()` sea falso (≈20 min). Solo entonces se pasa
  a `absent`. No hay `FORCE_OFF`. El gateway sin inspector rechaza el arranque (S7 escenario C, AT-27/27b).
- **Recuperación:** reinicio del worker y del gateway a mitad de una verificación. Reanudación del
  dispatcher (lease y fencing). Un `confirm` en vuelo durante el cambio de perfil se descarta y queda
  trazado (migración 0013).
- **Observabilidad:** la telemetría del inspector va sin texto ni identificadores (S3 §6). Falta el
  correlation id extremo a extremo con CP (X6, CP).
- **Aceptación:** un registro de aceptación del canary con evidencia etiquetada como sintética.
- **J7 es otro rollback.** Producción sigue en `sales-production@3` (`ef5a354`). Un rollout productivo
  de `@8` partiría de `@3`, con su propio rollback, y pertenece a J7 (no autorizado). Ver ADR-039 §10.

---

## 4. Dependencias de CP y CIA

### 4.1 Customer Profile (`bbd766e`)

| Área | Ítem | Estado | Evidencia | Bloquea |
|---|---|---|---|---|
| A | Registro de principals; modos off/observe/enforce; familias de rutas fail-closed | Implementado en main. **Default `off`** | `src/http/auth/*`, PR #23; `src/config.ts:118` | canary (enforce) |
| A | Scope `customer.sales_context.read`; ruta bajo `enforce` y flag (default deshabilitado → 404) | Implementado en main | `route-families.ts`, PR #25; `config.ts:277-292` | — |
| A | Verificador de grants CIA: ES256, JWKS fijado, emisor `.test`, kids `cia-synthetic-*`, binding `sub`/`azp`/`purpose` antes del productor | Implementado en main. **Default `disabled`** | PR #26 `fff8ac7`; `customer-sales-context.ts:133-137` | — |
| A | Emisor o claves reales | Ausente; rechazado por diseño | `config.ts` | datos reales |
| A | Contención de red (D3/H-1), `enforce` en producción, migración del CRM-agent | Solo documentado | Informe SECURITY-01 | canary / datos reales |
| B | Productor de facts | Solo `kind: 'synthetic'`. **No existe lector PrestaShop real** para sales-context | `facts-source.ts`; `src/index.ts` (`realDataAccess:false`) | datos reales |
| B | Política de compra válida `ps_orders.valid=1_current_state`, variantes, cantidad bruta, fecha sin zona, `policyVersion cp-sales-facts-v1-candidate` | Constantes declaradas (sintético) | `compose-sales-context.ts:58-74` | datos reales (AP-09, AP-10, D6, D13, D14) |
| B | Provenance y frescura (`validUntil = min(asOf+15m, exp)`) | Implementado en main | README v1-rc2 | — |
| C | `POST /v1/capabilities/customer/sales-context`; límites (req 1 KiB, resp 64 KiB, limit ≤ 10, offset ≤ 40); semántica `available`/`not_found`/`not_applicable`/`degraded`→503; `grant_rejected` 403 | Implementado en main | `contract.ts`; esquemas rc2 | — |
| C | Contrato `approved` | Ausente (`candidate`) | `SOURCE.json` | datos reales |
| C | G-16 y AP-01..11, AP-04-H | **PENDIENTE** | informe de merge S5 §6 | cierre formal de R1B; datos reales |
| C | L-1: grant que expira durante la composición → 500 en vez de 403 | **ABIERTA** | `CP_J4_S5_DEBT_L1_GRANT_EXPIRY_DURING_COMPOSITION.md` | datos reales (aceptada como bajo riesgo en sintético) |
| D | Despliegue | Producción en `23a2ef3` (pre-J4, sin verificar hoy). Despliegue de S5 no autorizado. Sin CI ni contenedor | informe en rama `9a1e27e` | canary |
| D | Presupuesto 2500 ms, 4 en vuelo, AbortSignal; logs con correlation id sin PII; auditoría `kidObserved`/`kidAuthenticated` | Implementado en main | `config.ts:151,175`; `3b43664` | — |
| D | Gate de resiliencia con proveedor real (`queueLimit`, timeout); p95; credenciales de solo lectura | Abierto / sin verificar | informe 02C §8/§12 | datos reales |
| D | Rollback | Solo por flag (sales-context off → 404; grant `disabled`) | informe en rama | — |
| E | Snapshot Set, RFM V2, Commercial Signals | Solo documentado | grep `src` | **No es dependencia de J4** |
| E | Clustering, CLV, affinity, audiences, RFM v1 | Módulos legados en main, fuera del camino sales-context | PR #10–#22 | **No es dependencia de J4** |

**Área E.** Ningún contrato exige E para J4. PRD CP §3 J4-04 y §5 lo excluyen. El roadmap CP §6
marca RFM y Signals como opcionales, y affinity, clustering y CLV como «No, explícitamente». La
descripción del esquema rc2 excluye datos predictivos.

**PrestaShop.** El código de CP asume el esquema estándar (`ps_customer`, `ps_orders`,
`ps_order_detail`, `ps_order_history`, …) sin detectar la versión. La única referencia de versión es
`docs/design/CP-R1-T04-customer-orders-read-model.md:81`: «PrestaShop 1.7.8.x», **no confirmado**.
La cadena 8.2.3 no aparece en CP. CIA y Checkout apuntan a 8.2.3 (contrato del proveedor CIA línea 6;
Checkout ADR-0001). **Ninguna versión está validada**: ni la de producción (1.7.8.3 según evidencia
operacional) ni el objetivo de migración (8.2.3). Esto es un gate de datos reales para CP y CIA.

**Documentos CP sin aprobar.**
- `CP_R4_J4_MINIMUM_READINESS_PRD.md`: «DRAFT v0.1 — pendiente de aprobación».
- `CP_V2_INTEGRATED_ROADMAP.md`: «PROPOSED».
- El informe de readiness `9a1e27e` sigue sin fusionar.
- El merge 02C (`de6c04a`) está registrado pero no regularizado.

**Ambigüedad D7.** En el roadmap CP, «D7» es la semántica de not-found (G00). En R4 (ADR-039 y la
alineación CP), D7 es la retención y purga de observaciones (PB-4). Este informe usa **D7 (R4)**.

### 4.2 CIA (`7525395`)

| Ítem | Estado | Evidencia | Bloquea |
|---|---|---|---|
| Contrato normativo | `contract/cia/v1-d2/`, `v1-d2-candidate`, aceptado **solo para interop sintética** (CIA-D2-ACC-01..03, 2026-10-20). Hashes de MANIFEST, contrato, grant schema y SOURCE coinciden con el registro de aceptación | `V1_D2_ACCEPTANCE.md` | datos reales |
| Endpoints | `verifications` (start), `verifications/confirm`, `links/revoke`, `resolve` (que emite el grant), `/.well-known/jwks.json`, `/health` (`mode:'synthetic'`) | `src/adapters/http/server.ts:55-65` | — |
| Aceptación y publicación del servicio | **Ausente.** Se aceptó solo el contrato (`CIA_S4_RUNTIME_UNCHANGED`) | ACCEPTANCE §4 | canary |
| Desplegabilidad | `validateConfig` y `isolation.ts` rechazan todo lo que no sea loopback. Sin Dockerfile, CI/CD ni material de EC2 | `src/config.ts`; README:116 | **canary** |
| Emisor vs verificador CP | Compatibles en alg/typ, kid, iss `.test`, aud, 15 claims `cv=1` y TTL ≤ 300 s | `grant-signer.ts`; CP `customer-grant/config.ts` | — (sintético) |
| Claves | P-256 derivada por HKDF desde una semilla sintética. **Sin KMS** (DEP-6, «S8») | README:22,116 | datos reales |
| Adaptador de cuentas PrestaShop | Implementado; **solo sintético** (loopback, doble de prueba). Contrato del proveedor `CANDIDATE`, «no autorizado ni implementado en la tienda real». Asume PS 8.2.3 | `account-provider.ts`; `ACCOUNT_PROVIDER_V1_CONTRACT.md:5-6` | datos reales (DEP-2, DEP-3, OD-CIA-2) |
| Correo transaccional | Solo stub (`fake/email-sender.ts`) | DEP-5 | datos reales |
| Owner | Felipe Porte (CIA-D1-01). Sin owner operacional ni de guardia documentado | ACCEPTANCE §1 | canary (operación) |
| OA-10 | Definido en R4 (custodia de claves productivas, roles de BD, nginx y PM2), no en CIA | `R4_J4_SEC_OTP_ARCHITECTURE_DECISION.md:662` | datos reales |
| Gates externos | DEP-2/3/5/6/10, DEP-11, OD-CIA-2..5, riesgo residual de revocación (≤ 300 s) no aceptado por el owner de datos, G-16, AP-* | contrato v1-d2 §11 | datos reales |
| Gobernanza | Sin PR ni CI. `main` local desfasado | `gh pr list` vacío | — (brecha, no gate) |

**Onboarding y Checkout.** CIA nunca crea cuentas: para invitados responde `no_eligible_account` o
`ineligible_account` (contrato v1-d2:185). La creación de cliente PrestaShop y el flujo de compra
autorizado son la decisión OD-08 (PROPUESTO) del PRD de Checkout (`CHECKOUT_SERVICE_PRD_v0.1.md:278`).
**No son dependencias de J4.** EXT-05 (landing de onboarding) solo condiciona `onboarding.available=true`.

---

## 5. Gates abiertos por hito

La campaña S7 en verde **no cierra** ninguno de estos gates.

| Gate | Definición | Cierre técnico sintético de J4 | Canary aislado (R5) | Datos reales / J7 |
|---|---|---|---|---|
| RS-01..04 (cobertura textual residual; correos con 4–8 dígitos redactados durante la protección) | S3 §4; S1 §9 | No | No (datos sintéticos) | **Sí**: el owner elige la opción 1, 2 o 3 |
| RR-1 R-1..R-3 (residuos; requieren aceptación escrita) | `R4_J4_RR1_BINDING_RACE_ANALYSIS.md` §7–§8; S6 §7 | No | No | **Sí** |
| RR-1 R-4 / inmutabilidad de bindings (sin trigger) | RR-1 §8; S4 R4-05; S2 R2-06 | No | Recomendado antes del canary (es precondición de la idempotencia de `confirm`) | **Sí** |
| BA-01..06 (entradas alternativas E-2..E-9) | S3 §5 | No | No, si el canary no conecta canal real ni shadow con tráfico real | **Sí** |
| OA-10 (claves, roles de BD, nginx/PM2) | SEC decisión :662 | No | No, con claves sintéticas | **Sí** |
| D7 (R4): retención y purga | ADR-039 §8; R0 :300 («definir antes de J4-R5») | No | **Sí**, como decisión que limita el canary a datos sintéticos y define su purga | **Sí** |
| G-16, AP-01..11, AP-04-H (conformidad formal del owner CP) | R1C :245,:262 | **Sí, para declarar cerrado J4-R1B** (no impide el código de R4-R4) | Sí | **Sí** |
| L-1 (CP: expiración del grant → 500) | Deuda L-1 de CP | No | No (aceptada en sintético) | **Sí** |
| X5–X7 (enforce, X6, red `:3010`) | R0 :254-256 | No | **Sí** | Sí |
| CIA solo loopback, sin despliegue ni aceptación de runtime | §4.2 | No | **Sí** | Sí |
| `R4_CONTEXT_EXPIRED_EVIDENCE` | ADR-039 Cond. 2 | No | **Sí** | Sí |
| Réplicas mixtas (R3-04) | S3 §7 :150 | No | **Sí**: procedimiento de despliegue (la guarda de arranque no detecta una réplica vieja que ya corre) | Sí |
| Protección durante el rollback | SEC plan §5 | No | **Sí**: forma parte del ensayo J4-R6 | Sí |
| DEP-2/3/5/6/10, OD-CIA-2..5, revocación residual | CIA v1-d2 §11 | No | No | **Sí** |
| Versión real de PrestaShop (1.7.8.3 vs 8.2.3) sin validar | §4.1 | No | No | **Sí** |
| EXT-02/03 (credenciales CIA productivas, correo real), EXT-07 | SEC plan :198-203 | No | No | **Sí** |
| Gates de `@7` (fidelidad de copia, límites, ADR-036, kill switch por canal) | `profile-v7.ts` V7_GATE | No | No | **J7** |

---

## 6. Trabajo pendiente priorizado

**P0** — necesario para el cierre técnico sintético de J4 y para habilitar R5.

| # | Owner | Trabajo |
|---|---|---|
| P0-1 | Owner R4 | Autorizar J4-R4 y confirmar el identificador `sales-production@8` y la definición v8 |
| P0-2 | R4 | J4-R4: perfil `@8` con dominio `identity`, definición v8, política, composición fail-closed y acoplamiento con el inspector (§3.1). Pruebas §3.2 |
| P0-3 | CP owner | G-16 y AP-01..08, AP-11: pronunciamiento formal. Regularizar el merge 02C. Decidir si se fusiona el informe de readiness `9a1e27e` |
| P0-4 | Owner R4 | Decidir `R4_CONTEXT_EXPIRED_EVIDENCE` y D7 (R4) para el canary sintético |
| P0-5 | R4 | Actualizar `R4-J4-R1_DESIGN_REPORT.md` §5–§6 con las versiones vigentes (`@3`, `@2`, `identity.*`) y el estado de D1/D2. Mandato documental |

**P1** — canary aislado (R5) y aceptación (R6).

| # | Owner | Trabajo |
|---|---|---|
| P1-1 | CIA | Mandato de desplegabilidad sintética: configuración no-loopback controlada, artefacto de despliegue, sender falso y aceptación de runtime |
| P1-2 | CP | Desplegar S5 en un entorno de **prueba** con `enforce`, el principal `r4-sales`, el grant `synthetic` y contención de red (X5, X7). X6 (correlation id, 503/504, rate limit) |
| P1-3 | R4 | Extender el tooling canary a `@8`. Opt-in de red hacia los hosts de prueba. Plan de limpieza. Procedimiento contra réplicas mixtas. Inmutabilidad de bindings (R-4) |
| P1-4 | Operación | Autorización EC2 separada de producción; identidades sintéticas aprobadas |
| P1-5 | R4 + Operación | J4-R5 (E2E desplegado) y luego J4-R6 (ensayo `@8 → @7` con protocolo de protección y registro de aceptación) |

**P2** — datos reales y J7; no bloquean el cierre sintético.

| # | Owner | Trabajo |
|---|---|---|
| P2-1 | Owner R4 | RR-1 R-1..R-3; RS-01..04; BA-01..06; OA-10 |
| P2-2 | CP | L-1; lector PrestaShop real; contrato `approved`; gate de resiliencia; p95; credenciales de solo lectura; AP-09, AP-10, D13, D14, D6 |
| P2-3 | CIA / Operación | DEP-2/3/5/6/10, OD-CIA-2..5, KMS, correo transaccional, aceptación de la revocación residual |
| P2-4 | PrestaShop / Operación | Validar la versión real (1.7.8.3 vs 8.2.3) y el esquema |
| P2-5 | CIA, CP | Gobernanza: PRs y CI mínimos (hoy push directo en CIA y sin workflows en CP) |

---

## 7. Plan de ejecución paralelo recomendado

```text
Carril R4      : P0-1 → P0-2 (J4-R4) ───────────────┐
Carril CP owner: P0-3 (G-16/AP-*) ──┐                ├─► P1-3 → P1-5 (R5 → R6) → J4_RELEASE_CANDIDATE
Carril CP      :                   └─► P1-2 (deploy ─┤
                                       de prueba)    │
Carril CIA     : P1-1 (desplegabilidad sintética) ───┤
Carril Owner   : P0-4 (D7, EXPIRED_EVIDENCE) ────────┤
Carril Ops     : P1-4 (autorización EC2) ────────────┘
Fuera de J4    : P2-* (gates de datos reales) en paralelo, sin bloquear el carril anterior
Checkout       : en paralelo, sin cambios (§8)
```

- P0-2, P0-3, P1-1 y P1-2 son independientes y pueden comenzar a la vez.
- R5 necesita que converjan los cinco carriles.
- No se recomienda iniciar J5 antes de J4-R4: necesita `@8` como base de capacidades.

---

## 8. Alcance diferido explícitamente

| A | Alcance |
|---|---|
| **J5 — Sales Autonomy** | Comportamiento del modelo con Customer: cuándo pedir verificación, uso del historial en la recomendación, personalización, estrategia comercial, prompts y goals. J4 solo exige compatibilidad mínima (§3.2) |
| **J6 — Benchmark** | Evaluación comercial amplia, comparaciones A/B de estrategia, benchmark de proveedores o modelos con Customer |
| **J7 — Production Rollout** | Rollout de `@8` desde `@3` con su propio rollback; datos y clientes reales; gates P2; RR-1, RS, BA, OA-10, D7 productivo; CRM-agent y `enforce` en producción; versión de PrestaShop; gates de `@7` |
| **Checkout** (hoy registrado como J5.5 en la rama sin fusionar `docs/r4-j55-roadmap-registration`) | Creación de cliente y onboarding (OD-08), carrito, pago, orden. Avanza en paralelo; **no bloquea J4**. Este mandato no lo cambia |
| **CP-V2** | Área E: Snapshot Set, RFM V2, affinity, clustering, CLV, audiences, Commercial Signals. **No es dependencia de J4** |

**Nota para el owner.** El roadmap vigente no define J5 ni J6. La rama sin fusionar `d8a6b94`
afirma que «no los hay» y usa J5.5 como identificador provisional de Checkout dentro de R4-L. Este
mandato registra J5, J6 y J7 tal como los enuncian sus principios. La relación con J4.5 (Catalog) y
con J5.5 queda **como propuesta pendiente de conciliación por el owner** (ver roadmap §1.1).

---

## 9. Condiciones para declarar `J4_RELEASE_CANDIDATE_ACCEPTED`

Las nueve condiciones son objetivas y deben cumplirse todas.

1. `sales-production@8` y la definición v8 están en `main`:
   - registran exactamente `customer.get_context@3`, `customer.get_purchase_history@2`,
     `identity.start_verification@1` e `identity.verification_status@1`, más Catalog, Shipping y Quote de `@7`;
   - el mapa de versiones está fijado por un test de contrato.
2. Las huellas de `@1`–`@7` y de las definiciones v3–v7 no cambiaron (test de contrato).
3. La composición `@8` rechaza cada dependencia faltante (CIA, CP, `taskState`, inspector `full`, pool). Hay mutaciones que lo demuestran.
4. Regresión completa en verde sobre el commit candidato. Los fallos preexistentes se documentan uno por uno.
5. La ejecución pareada `@7`/`@8` (§3.2) no muestra regresión en decisiones válidas ni en fidelidad de copia, y el modelo nunca repite secretos.
6. J4-R5 en verde con CIA y CP **desplegados en prueba**, en modo `synthetic`:
   - cliente verificado → ve su historial;
   - anónimo, provisional o con grant ajeno → `unavailable`;
   - 401 o 403 → `unauthorized`;
   - CP caído → la quote `guest` se emite igual;
   - 0 clientes reales procesados (verificado);
   - evidencia etiquetada como sintética.
7. J4-R6 en verde:
   - rollback `@8 → @7` en el canary siguiendo el protocolo de protección (sin `FORCE_OFF`);
   - sin ejecuciones huérfanas;
   - `@7` intacto;
   - recuperación del dispatcher tras un reinicio.
8. G-16 y AP-01..08, AP-11 con pronunciamiento formal del owner de CP. D7 (R4) y `R4_CONTEXT_EXPIRED_EVIDENCE` decididos.
9. Registro de aceptación firmado por el owner. Lista explícita de gates P2 que siguen abiertos y que J7 hereda.

`J4_RELEASE_CANDIDATE_ACCEPTED` **no** habilita datos reales ni producción: eso es J7.

---

## 10. Límites respetados

- **Código Git:** el único cambio fue el merge del PR #17.
- **Este PR:** solo documentación (`docs/roadmap/R4_DELIVERY_ROADMAP.md` y este informe).
- **Otros repositorios y worktrees:** CIA, CP y los worktrees ajenos no se modificaron. La auditoría usó solo lectura y `git fetch`.
- **Lo que no se hizo:** no hubo despliegue, acceso a EC2, RDS ni PrestaShop, correos u OTP, ni datos reales.
- **Lo que no se inició:** J4-R4, R5, R6 y J5.
