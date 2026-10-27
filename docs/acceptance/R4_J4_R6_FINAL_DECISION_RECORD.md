---
title: R4-J4-R6 — Revisión del PR #25 y decisión final de J4
status: decision — J4_R6_BLOCKED
mandate: R4-J4-R6 Final Acceptance and Customer Profile Contract Closure (owner, 2026-10-27), Fases A y D
date: 2026-10-27
base: R4 main 09d6579; PR #25 head e6debe8
---

# R4-J4-R6: revisión del PR #25 y decisión final

```text
J4_R6_BLOCKED
```

Etiquetas: **EJEC** = ejecutado en esta sesión · **GIT** = verificado en el repositorio · **INF** = afirmado por el
informe J4-R5, **sin verificación independiente** (la evidencia cruda está solo en el EC2, `~/r4-j4-canary/evidence`,
y este mandato no autoriza acceso al EC2).

## 1. Fase A — revisión independiente del PR #25

**Contenido** (GIT): `docs/architecture/R4_J4_R5_INTEGRATED_CANARY_REPORT.md` y cuatro scripts bajo
`scripts/canary-j4/`. Head `e6debe8` contiene `main` `09d6579`; GitHub: `MERGEABLE`, `CLEAN`, GitGuardian en verde.
Sin cambios en harness, Core, migraciones ni producción.

**Checks ejecutados sobre `e6debe8`** (EJEC, clon de trabajo limpio, `npm ci`):

| Check | Resultado |
|---|---|
| `build`, `typecheck` | OK |
| `eslint scripts/canary-j4 --max-warnings=0` | OK |
| `node --check` de los 4 scripts | OK |
| `test:unit` | 1519 PASS, 0 FAIL (4 skip) |
| `test:contract` | 450 PASS, 0 FAIL |
| `test:integration`, `sales`, `shadow`, `recovery` | **No ejecutados**: Docker no estaba disponible. El PR no agrega código que estas suites carguen |
| Imports de `replay-shapes.mjs` (`shapeOf`, `renderModelRequest`, `parseAgentDecision`, adaptador OpenAI-compatible) | Existen en `main` (GIT) |

**Revisión de los scripts** (GIT):
- `cia-host.mjs`: usa la composición propia de la CIA sin modificarla; la CIA valida loopback, sintético y `.test`.
  El buzón OTP escucha solo en `127.0.0.1`, con bearer comparado en tiempo constante y restringido a
  `@synthetic.test`. Correcto para un canary sintético.
- `loopback-only.mjs`: fuerza `127.0.0.1` en `listen(port…)` y `listen({…})`; descarta el host pedido. Correcto.
- `leakscan.mjs`: no imprime el secreto. **Observación menor:** las columnas `bytea` se comparan por su texto
  hexadecimal, así que en ellas un código en claro no se detectaría. El estado sellado es cifrado (SEC-S2), por
  lo que la conclusión no cambia, pero «301 columnas» incluye columnas en las que la búsqueda no aplica.
- `replay-shapes.mjs`: registra solo la forma de la respuesta, nunca su texto. Envía al modelo contextos del canary
  (sintéticos).

**Verificación de las afirmaciones del mandato:**

| Afirmación | Estado | Base |
|---|---|---|
| Ejecución integrada CIA + Customer Profile | Consistente | INF §3–§4 etapas 4–6 |
| Protección OTP | Consistente | INF: código en 0 de 301 columnas, logs y capturas |
| Acceso autorizado a CP (grant, `enforce`, principal `r4-sales`) | Consistente | INF etapa 4–6 |
| Degradación de CP | **Parcial** | INF etapa 5: con CP caído el agente no inventa datos. **No** hay evidencia de que la quote `guest` se emita con CP caído en el canary desplegado (I7). Sí está cubierto en local: `tests/integration/sales-profile-v8.test.ts` §A (GIT) |
| Recuperación del dispatcher | Consistente | INF etapa 7: misma clave de idempotencia tras caída de CIA y reinicio del gateway |
| Pareado `@7`/`@8` | Ejecutado, con fallo | INF etapa 9: `@7` A sin ninguna respuesta (F-1) |
| Rollback protegido | Consistente | INF etapa 10: `full → protect_only → ventanas vencidas → @7`, sin `FORCE_OFF` |
| Purga con 0 filas | Consistente | INF: `rowsRemaining: 0`, `realCustomers` 0, sha256 `bd2105ba…`, esquema CIA eliminado |
| Sin cambios al runtime productivo `@2` | Consistente | INF §2–§3. No re-verificado |
| Sin acceso a datos reales | Consistente | INF; config CP `realDataAccess: false`, BD PrestaShop con placeholders |

**Dictamen del PR #25:** el contenido es correcto y coherente, y los checks del repositorio pasan. Lo que el PR
**registra** es un J4-R5 con los gates de integración en verde y la confiabilidad conversacional en **FAIL**
(`J4_R5_CONVERSATION_RELIABILITY_FAIL`, F-1 P0). Fusionarlo archiva esa evidencia; **no** acepta J4-R5.

```text
PR25_REPO_CHECKS=PASS
PR25_CONTENT_REVIEW=PASS (1 observación menor: leakscan y bytea)
PR25_RUNTIME_CLAIMS=CONSISTENT_NOT_INDEPENDENTLY_VERIFIED
PR25_MERGE=PENDING_OWNER_DECISION (ver §4)
```

La verificación independiente de la evidencia cruda solo es posible en el EC2 y requiere autorización
explícita. Los logs se retienen hasta el **2026-11-02**; los informes hasta el 2026-11-25.

## 2. Fase D — los nueve criterios originales

Fuente: `R4_J4_CROSS_REPO_ROADMAP_REBASE_REPORT.md` §9 (sin modificar).

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 1 | `@8`/v8 en `main` con exactamente las capacidades Customer/identity + Catalog/Shipping/Quote de `@7`; mapa de versiones fijado por contrato | **MET** | PR #19 `3e04b4f`; `J4_R4_SYNTHETIC_ACCEPTED` (2026-10-22) |
| 2 | Huellas `@1`–`@7` y v3–v7 sin cambios | **MET** | J4-R4; contract 450/450 sobre `e6debe8` (EJEC) |
| 3 | Composición `@8` rechaza cada dependencia faltante, con mutaciones | **MET** | Mutaciones `profile-v8` 8/8 y `canary-j4` 13/13 (informe J4-R4 y tooling) |
| 4 | Regresión completa en verde sobre el commit candidato | **PARTIAL** | Completa sobre `3e142ad`; recuperación 18/18 tras PR #24. Sobre el candidato final solo unit + contract (EJEC). Falta integración/sales/shadow/recovery sobre el commit que se acepte |
| 5 | Pareado `@7`/`@8` sin regresión de decisiones válidas ni fidelidad; nunca repite secretos | **MET** | Comparación J4-R4 aceptada; en el canary F-1 afectó a `@7` y `@8` por igual (no es regresión de `@8`); OTP ausente en BD, logs y capturas (INF) |
| 6 | J4-R5 en verde con CIA y CP desplegados en prueba, modo `synthetic` | **NOT MET** | El propio informe declara `J4_R5_CONVERSATION_RELIABILITY_FAIL` y recomienda no avanzar (§7). Sub-casos sin evidencia en el canary desplegado: provisional / grant ajeno → `unavailable`; 401/403 → `unauthorized`; CP caído → quote `guest` emitida. Cumplidos: verificado → historial; 0 clientes reales; evidencia sintética |
| 7 | J4-R6: rollback `@8 → @7` con protocolo de protección, sin huérfanas, `@7` intacto, recuperación del dispatcher | **PARTIAL** | Rollback, `@7` y dispatcher: consistentes (INF). **Ejecuciones huérfanas de Customer / `identity.start_verification` tras el rollback: no reportadas.** Dependencia «R5 PASS» no cumplida |
| 8 | G-16 y AP-01..08, AP-11 con pronunciamiento formal del owner de CP; D7 y `R4_CONTEXT_EXPIRED_EVIDENCE` decididos | **NOT MET** | D7 del canary y `R4_CONTEXT_EXPIRED_EVIDENCE=exclude` decididos (2026-10-22). **G-16 PENDIENTE**; [registro preparado sin firmar](R4_J4_G16_CP_ACCEPTANCE_RECORD.md); [auditoría CP](../architecture/R4_J4_R6_CUSTOMER_PROFILE_STATE_AUDIT.md) §6–§7 |
| 9 | Registro de aceptación firmado por el owner; lista explícita de gates que hereda J7 | **NOT MET** | Lista J7 preparada ([backlog J7-CP](../architecture/R4_J7_CUSTOMER_PROFILE_PRODUCTION_DATA_BACKLOG.md)); registro de aceptación no firmado (depende de 6–8) |

`J4_RELEASE_CANDIDATE_ACCEPTED_WITH_EXPLICIT_LIMITATIONS` **no aplica**: exige que se cumpla toda condición
obligatoria, y 6, 8 y 9 no se cumplen. Las limitaciones de J7 (datos reales) no son la causa del bloqueo.

## 3. Decisión

```text
J4_R6_BLOCKED
```

| Gate no cumplido | Criterio | Owner | Para cerrarlo |
|---|---|---|---|
| **BG-1** G-16: conformidad formal del owner de CP con AP-01..AP-08 y AP-11 | 8 | Owner de CP | Firmar [el registro](R4_J4_G16_CP_ACCEPTANCE_RECORD.md) y transcribirlo a CP §9.1 |
| **BG-2** J4-R5 PASS: conversaciones abandonadas (F-1 P0) | 6, 7 | Owner R4 | Revisión independiente y merge del PR #27 (ADR-041, migración Core `0012`: fuera de este mandato, que no permite cambios del kernel); repetir el canary en el mismo entorno y verificar el aviso fijo tras una falla de recuperación. Alternativa: que el owner reclasifique F-1 fuera de J4 **por escrito**, sabiendo que el informe J4-R5 lo pone como condición de J4-R6 |
| **BG-3** Evidencia desplegada faltante | 6, 7 | Owner R4 / Operación | En la repetición del canary (o en la evidencia cruda del EC2, si ya existe): provisional y grant ajeno → `unavailable`; 401/403 → `unauthorized`; CP caído → quote `guest` emitida; 0 ejecuciones huérfanas tras el rollback |
| **BG-4** Regresión completa sobre el candidato final | 4 | R4 | `npm test` + recovery (solo, al final) sobre el commit que se acepte |
| **BG-5** Registro de aceptación J4 firmado | 9 | Owner | Tras BG-1..BG-4 |

Producción, datos reales y rollout de `@8` siguen fuera de J4 (J7). Nada de lo anterior requiere desarrollo
nuevo en Customer Profile.

## 4. Merge del PR #25

Los checks del repositorio y la revisión de contenido pasan (§1). Las afirmaciones de runtime son consistentes
pero no se verificaron de forma independiente. El merge queda **a decisión del owner**, fijado a `e6debe8`:

```text
gh pr merge 25 --merge --match-head-commit e6debe8230a9d4a72aa05246ea232f13a570c84b
```

SHA de merge: _pendiente_.
