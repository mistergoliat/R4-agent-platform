# R4-J3 — Registro de cierre

Documento único de cierre administrativo de J3. **No reemplaza** la evidencia: la consolida y la enlaza. Las fuentes son [`R4_J3_FINAL_ACCEPTANCE.md`](R4_J3_FINAL_ACCEPTANCE.md) (§15–§17), [`R4_J3_FINAL_EC2_CANARY_REPORT.md`](R4_J3_FINAL_EC2_CANARY_REPORT.md) (§20) y [`R4_J3_CUSTOMER_JOURNEY_GAP_REGISTER.md`](R4_J3_CUSTOMER_JOURNEY_GAP_REGISTER.md). Los estados históricos (`CONDITIONAL`, `BLOCKED`, `FAIL`) se conservan en esos documentos como cronología y no son vigentes.

Etiquetas: **GIT** = verificado en el repositorio durante esta auditoría (2026-10-15) · **EC2-DOC** = evidencia EC2 registrada en el informe del canary; no se repitió · **DOC** = afirmación documentada o del owner, sin verificación propia.

## 1. Hito

**R4-J3 — Quote Integration & Autonomous Issuance** (re-delimitado por el owner el 2026-10-14; aceptación §15). Forma parte de R4-J, *Sales Autonomy*.

## 2. Fecha de cierre

**2026-10-15.** Aprobación formal del owner (aceptación §17). Merge a `main` el mismo día, 14:53:59 −03:00 (GIT).

## 3. SHA de `main`

```text
main = origin/main = b5fd2882903851e5f11aa65a2ff76452c3130edf   (GIT, tras git fetch)
```

Merge `--no-ff` de `r4-j3e-c-deterministic-commercial-offer` (`b9fac24`) sobre `092715e`.

## 4. Alcance aceptado (ACCEPTED)

| Capacidad | Evidencia |
|---|---|
| Integración con Catalog (real) | Canary §20.4–§20.5 |
| Integración con Shipping (real) | Canary §20.5 (Blue Express a San Bernardo) |
| Integración con Quote V2 (integración real) | Canary §20.5; PC-000004/5 (`@5`/`@6`) y PC-000006 (`@7`) |
| Construcción de ofertas comerciales | Aceptación §3–§4; canary §20.5 |
| Presentación determinista (`r4-sales-offer-es-v1`) | C1; canary §20.5 (SHA-256 del texto capturado = render Sales) |
| Verificación de la oferta entregada | `offer_text_sha256` (`0009`) = `offerMessageSha256` (`0008`) |
| Confirmación explícita del cliente | "Sí." rechazado (`customer_confirmation_not_explicit`); "Sí, emítela." autorizado (canary §20.5) |
| Autorización autónoma gobernada | 4 decisiones `allow/autonomous`, 0 solicitudes humanas (canary §20.5); ADR-034/035 aceptados solo para canary |
| Emisión real de cotizaciones | PC-000006, una sola emisión |
| Integridad comercial (liquidación estricta) | Owner = snapshot por línea y despacho (canary §20.5) |
| Idempotencia | 1 `execution_key` = `Idempotency-Key`; 1 binding; 1 operación; recibo `replayed: false` |
| Reconciliación | Aceptación §14 (GAP-16) |
| Corrección GAP-16 | `ab6f55d`, `quote.create@5`; 9/9 LOCAL (aceptación §16) |
| Validación E2E contra servicios reales de integración | Canary §20 |
| Verificación documental (SHA-256 del PDF) | Manifiesto = artefacto = recibo, `1913c9d9…`, 31 669 bytes |

**No se probó la entrega real del PDF al cliente.** El canary verificó el documento generado; no hubo envío (0 WhatsApp, 0 email).

## 5. Evidencia final del canary (EC2-DOC, informe §20)

```text
Fecha/hora        2026-10-15, 15:42–17:12 UTC
Perfil            sales-production@7 (sales@7), commit del canary c46d6c3
Modelo            DeepSeek real (deepseek-v4-flash, thinking enabled)
Owners            Catalog real, Shipping real, Quote V2 de integración
Cotización        PC-000006 (quote_id 1d2d66e9-f05b-4f75-80f1-798c03ad0761), cliente guest
Totales           neto 179 516 · IVA 34 108 · bruto 213 624 CLP
Emisiones         1 (owner: cotizaciones 6 → 7; entregas 1 → 1)
PDF               SHA-256 1913c9d93b2156ce99814d97f48b81e2098b311db01e444eb0cd460c905ca2e2, verified
Mensajes reales   0 WhatsApp, 0 Gmail (todo el outbound en el canal sintético)
Producción        ef5a354, sales-production@3, sin cambios antes y después (solo lectura)
```

Configuración autorizada solo para el canary: `R4_MODEL_TIMEOUT_MS=180000`, `R4_EXEC_MODEL_CALL_TIMEOUT_MS=195000` (§20.1–§20.2). Historia: 2026-10-14 BLOCKED (SSH) → FAIL (límite de 60 s por llamada) → 2026-10-15 FAIL (misma causa) → PASS.

**Observaciones conservadas, sin defecto asociado:**
- **Shipping:** la tarifa de $1 de "Despacho Directo" es una política comercial legítima de marketing (owner, §17). No es un defecto.
- **Catalog / agente:** 56 llamadas al modelo y 44 lecturas; dos runs recuperadas por ADR-028 tras agotar el presupuesto de 10 min. Esto **no bloquea J3**.
  - El owner reporta una optimización de Catalog de 320 a 8 consultas SQL para 40 productos en el escenario probado (97,5 %), pendiente de despliegue.
  - La eficiencia del agente se reevalúa después del despliegue de J4.5.
  - Esa reducción **no se extrapola** a las llamadas del agente, a sus tokens ni a la latencia total.

## 6. Excepciones documentadas

1. **Merge sin PR.** La aceptación §13.5 y §17 previeron una revisión mediante PR. El merge se hizo localmente con `--no-ff` y se publicó en `origin/main` sin abrir un PR (GIT: commit de merge `b5fd288` con dos padres; no hay referencia a un PR).
   - Es una excepción de procedimiento, **no un bloqueo retroactivo** del cierre técnico.
   - La revisión previa al merge está registrada en el mensaje del commit: sin cambios en `packages/`, `apps/` ni `adapters/`, sin migraciones nuevas, sin cambios de paquetes y sin secretos.
2. **Sin CI.** El repositorio no tiene CI (GIT: no existe `.github/`). La regresión fue local.
3. **Regresión local no completamente verde** (mensaje del merge; aceptación §14.5):

| Suite | Resultado |
|---|---|
| build, lint, typecheck | PASS |
| unit | 1 025 PASS |
| contract | 329 PASS |
| shadow | 5 PASS |
| sales | 29 PASS |
| integration | 471 PASS, 12 SKIP (preexistentes) |
| recovery | 17 PASS, **1 FAIL** histórico: `tests/recovery/production-bootstrap-process.test.ts:48` (GAP-15, preexistente desde J2D) |

   En la corrida completa de §14.5, integration y sales tuvieron timeouts por CPU saturada de la estación. Al re-ejecutar los archivos afectados, pasaron. **No se afirma que todas las suites estuvieran verdes.**
4. **Timeouts del canary.** Los timeouts de 180 s y 195 s se autorizaron solo para el canary. Los defaults de producción no cambiaron.

## 7. Funcionalidades diferidas

**J3F — Quote Document Delivery → R4 Media & Communications.**

```text
J3F_DISPOSITION=DEFERRED_TO_R4_MEDIA
ADR_038_STATUS=PROPOSED_DEFERRED
```

- **Rama:** `r4-j3f-document-delivery-design` (`19928db`, local = `origin`).
  - Contiene ADR-038, el diseño arquitectónico y el plan de implementación.
  - Tiene 1 commit por delante de `main` y **no está fusionada** (GIT).
- **Naturaleza:** el envío de PDFs será una capability de plataforma (del harness), no una implementación particular del agente Sales.
- **Alcance futuro:** R4 Media podrá incorporar, en fases independientes:
  - recepción de audios, imágenes y documentos;
  - envío de medios.
- **Requisito antes de cualquier rollout que prometa PDFs:** GAP-01 (roadmap §4.2).
- **No autorizado:** la migración `0011`, los cambios de harness y las versiones Sales propuestas por J3F.

## 8. Gates de producción pendientes (J7, abiertos)

El cierre de J3 **no resuelve** ninguno de estos gates:

| Gate | Referencia |
|---|---|
| Autenticidad y procedencia de inputs | ADR-036 (propuesto), GAP-06 |
| Integridad determinista del mensaje final (Sales Response Integrity), P0 | GAP-03 |
| Atención efectiva de handoffs | GAP-17, GAP-10 (OIDC real) |
| Kill switch por canal y retenciones | GAP-07, GAP-08 |
| Rollback y drenaje de ejecuciones | GAP-09 |
| Límites comerciales de producción | GAP-12 |
| Observabilidad de decisiones autónomas | GAP-11 |
| Gates de `@7` aplicados en código / seguridad operacional | GAP-13 |
| Entrega documental, antes de un recorrido que prometa PDFs | GAP-01 (R4 Media) |
| Validación E2E sobre WhatsApp real | GAP-14 |
| Política definitiva de reconciliación y retenciones | ADR-037 (propuesto; debe aceptarse antes de J7) |

ADR-034 y ADR-035 siguen aceptados **solo para experimentación y canary**.

## 9. Estado de Git y despliegues

| Verificación | Resultado (GIT, 2026-10-15) |
|---|---|
| `origin/main` = SHA aprobado | `b5fd2882…` = local `main`. Árbol limpio antes de esta rama documental |
| Merge de J3E-C1 en `main` | `b5fd288`, `--no-ff`, padres `092715e` y `b9fac24` |
| Commits de J3E-C1 incorporados | 10 commits, de `7783a08` a `b9fac24`. `main..origin/r4-j3e-c-deterministic-commercial-offer` está vacío |
| J3F no incorporada | `r4-j3f-document-delivery-design` no es ancestro de `main`; ADR-038 no está en `main` |
| Alcance del merge | 44 archivos: `agents/sales/`, tests, docs, `scripts/experiments/`. 0 en `packages/`, `apps/` o `adapters/`; 0 migraciones; 0 cambios en `package.json` o lockfile |
| Archivos sensibles | Ninguno. Las salidas de experimentos van a `artifacts/` (ignorado; 0 archivos versionados). La única credencial en los scripts es la de desarrollo local de `docker-compose.yml` (`r4_local_only`). `git fsck` limpio |
| CI | No existe |

**Despliegues (EC2-DOC, canary §20.3/§20.5):**
- **Producción:** `ef5a354`, `sales-production@3`, rollout 0 %.
  - 11 migraciones, sin las Sales `0008`/`0009`.
  - Sin despliegue de J3.
  - Esta auditoría no accedió a EC2.
- **Canary:**
  - runtime detenido;
  - PC-000006 queda en Quote V2 de integración.

## 10. Línea base de J4 (handoff)

J4 **no se inicia automáticamente**. Requiere autorización explícita. Esta sección es una transición, no una auditoría de Customer Profile.

| Tema | Estado |
|---|---|
| SHA base | `main` `b5fd2882903851e5f11aa65a2ff76452c3130edf` |
| Capacidades comerciales en `main` | `sales-production@7`: `catalog.search`, `catalog.get_product_context`, `shipping.quote`, `quote.preview@3`, `quote.create@5`, `sales.workspace.update@2`. Oferta `r4-sales-offer-es-v1`, gramática `r4-sales-confirmation-es-v1` y política `sales-production-autonomous-policy@1` |
| Producción frente a `main` | Producción en `@3` / `ef5a354`. `main` contiene además `@4`–`@7` y las migraciones Sales `0008`/`0009`, sin desplegar. `J3_PRODUCTION_ROLLOUT=NOT_AUTHORIZED` |
| Quote V2 | Solo el despliegue **de integración** emitió (PC-000004/5/6; Gmail deshabilitado). Ningún perfil productivo emite |
| Customer Profile | `UNAVAILABLE` para Sales (`agents/sales/src/production/profile.ts:31`). Toda cotización es `customer: { kind: 'guest' }` (`agents/sales/src/capabilities/commercial-snapshot.ts:218,233`). `sales.v7.agent.json` declara `customer.read` y menciona `customer.get_context`, que producción no ofrece (GAP-15) |
| Contratos que J4 debe respetar | Las definiciones y perfiles versionados son inmutables: cualquier cambio requiere una versión nueva y respetar las huellas fijadas en `tests/contract/`. Customer es un concepto de dominio, fuera de R4 Core (AGENTS.md). El contrato de cliente de Quote V2 es `guest` / `person` / `company`. Los datos que declara el cliente son inputs no confiables (ADR-036). La confirmación y la oferta se ligan por hash (ADR-035, C1) |
| Gaps de identidad / Customer 360 (no eran de J3) | GAP-05: la cotización no identifica al cliente. Aceptación §12: falta email verificado, nombre/RUT/razón social verificados, vínculo a un cliente PrestaShop y búsqueda por `wa_id` en el ingreso |
| Dependencias con J4.5 | Despliegue de la optimización de Catalog → reevaluar la eficiencia del agente (llamadas, lecturas, presupuesto del run). GAP-04 (peso solo por variante) es J1/J2 |
| Riesgos que J4 no debe absorber | Entrega del PDF (R4 Media); GAP-03 y los gates J7 (§8); implementación de ADR-036/037; eficiencia del agente (J4.5); el fallo GAP-15; el rollout de `@7` a producción |

## 11. Decisión formal del propietario

```text
J3_FINAL_STATUS=CLOSED_WITH_RESCOPED_ACCEPTANCE   (owner, 2026-10-15; aceptación §17)
J3_TECHNICAL_ACCEPTANCE=PASS
J3_AUTONOMOUS_ISSUANCE=PASS
J3_REAL_MODEL_E2E=PASS
J3_REAL_QUOTE_V2_E2E=PASS
J3_EC2_CANARY=PASS
J3_QUOTE_ISSUED=PC-000006
J3F_DISPOSITION=DEFERRED_TO_R4_MEDIA
J3_CUSTOMER_JOURNEY_FULL=INCOMPLETE
J3_PRODUCTION_ROLLOUT=NOT_AUTHORIZED
J3_REMAINING_DEVELOPMENT=NONE
```

J3 queda cerrado con su alcance técnico aceptado y la evidencia preservada. Los compromisos pendientes quedan asignados:
- entrega documental → R4 Media;
- gates operacionales → J7;
- identidad del cliente → J4;
- eficiencia de Catalog y del agente → J4.5.

No se reabre J3 por esos pendientes.
