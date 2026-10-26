---
title: R4-J4-R5 — Canary integrado sintético en el EC2 de PesasChile (ejecutado)
status: executed
mandate: R4-J4-R5 Single-EC2 Integrated Canary (owner, 2026-10-26); cierre según «R4 — J5 Reliability Gap and Commercial Knowledge»
date: 2026-10-26
base: main 09d6579 (PR #23 y #24 integrados)
---

# R4-J4-R5: canary integrado `sales-production@8` (ejecutado)

```text
J4_R5_TOOLING_MERGED
J4_R5_PREFLIGHT_EVALUATED
J4_R5_INTEGRATED_CANARY_EXECUTED          (las 10 etapas, con servicios desplegados en el mismo EC2)
J4_R5_INTEGRATION_GATES_PASS              (CIA, CP, OTP, dispatcher, singleton, rollback, purga)
J4_R5_CONVERSATION_RELIABILITY_FAIL       (P0: 2 conversaciones quedaron sin respuesta; ver §5 F-1)
J4_R6_ACCEPTANCE_PENDING
R4_HARNESS_UNCHANGED
CUSTOMER_REAL_DATA_ACCESS_BLOCKED
```

## 1. Fase 1 — PRs

- PR #23 (documentación y preflight) y PR #24 (corrección de la prueba de recuperación) se fusionaron tras verificar el head (`--match-head-commit`), los checks (GitGuardian en verde) y la regresión de #24.
- `main` = **`09d6579`**.

## 2. Fase 2 — preflight del EC2 (solo lectura)

| Aspecto | Observado | Consecuencia |
|---|---|---|
| Host | `ip-172-31-1-183`, Amazon Linux 2023, 2 vCPU, 3,8 GB de RAM **sin swap** (~1,7 GB disponibles), 9,9 GB de disco libre | Memoria ajustada. Todo se compiló fuera del host y se instalaron solo dependencias de producción |
| Gestión de procesos | pm2 (CRM, catalog, customer-profile, gateway, worker y scheduler de R4), Docker, nginx | El canary corre fuera de pm2 (`setsid` y archivos de pid): un `pm2 restart all` o `pm2 save` de producción no lo toca |
| R4 productivo | `~/R4-agent-platform` en `ef5a354`, **`sales-production@2`**, rollout 0 % con allowlist | Discrepancia documental: los documentos dicen `@3` |
| WhatsApp | nginx `/v1/channels/whatsapp/webhook` → `127.0.0.1:8090` (gateway productivo) | No se tocó (Fase 5) |
| Customer Profile productivo | `23a2ef3` escucha en `*:3010` (todas las interfaces) | Hallazgo de contención de red (X7); no se modificó |
| PostgreSQL | `r4-production-postgres` (:55432), `r4-sales-canary-postgres` J3E (:55434), Quote V2 y checkout aislados | Para J4 se creó un contenedor propio (§3) |
| Otra actividad | Otra sesión desplegó `checkout-sandbox` y recargó nginx unas 3 h antes | Sin interferencia; no se tocó |

**Bloqueantes:** ninguno. La memoria se mitigó con límites de heap (`--max-old-space-size`), un tope de 256 MB para el Postgres del canary y la compilación fuera del host.

## 3. Fase 3 — entorno aislado (`~/r4-j4-canary`, permisos 0700)

| Componente | Versión | Aislamiento |
|---|---|---|
| PostgreSQL dedicado `r4-j4-canary-postgres` | `postgres:16-alpine` (imagen ya presente) | `127.0.0.1:55435`, 256 MB y 0,5 CPU. Bases `r4_j4_canary` y `cia_j4_synthetic` |
| CIA sintética | CIA `7525395`, **sin cambios** | `127.0.0.1:18787`. Composición propia de la CIA con el doble del proveedor de cuentas y el buzón falso (`scripts/canary-j4/cia-host.mjs`). Buzón OTP solo en loopback, con bearer, en `:18788` |
| Customer Profile S5 | CP `bbd766e`, **sin cambios** | `127.0.0.1:13011` forzado por el preload `scripts/canary-j4/loopback-only.mjs`. `enforce`, principal sintético `r4-sales` con `customer.sales_context.read`, grant `required` con el JWKS de la CIA fijado, fuente `synthetic` (`realDataAccess: false`). BD de PrestaShop y CRM con placeholders inalcanzables |
| R4 | `09d6579` + scripts de esta rama | `sales:canary gateway` (único, `full`), `run` (`@8`), `send` |
| Secretos | Sintéticos, generados en el host, archivos 0600, nunca impresos | El keyring y `confirm` solo en el rol gateway; los tokens de CIA y CP solo en el worker |
| Dependencias heredadas del canary J3E aprobado | Modelo (`deepseek-flash`, thinking activo), Catalog `:4010` (solo lectura), Shipping real, Quote V2 de integración `:4020` | Las mismas del canary `@7` aprobado |

No se modificó ni reinició ningún proceso productivo.

## 4. Fase 4 — ejecución

| # | Etapa | Resultado | Evidencia (EC2, `evidence/`) |
|---|---|---|---|
| 1 | Inicialización y migraciones | ✅ canary `6e5363ecd83d`. Core `0001`–`0011` (sin `0006`), Sales `0006`–`0009`, identity `0011`–`0014`. `sales@3`–`@8` registrados | `01-init.json` |
| 2 | Gateway único protegido | ✅ modo `full`, `liveGateways: 1` | `02-*` |
| 8 | Rechazo de gateways concurrentes | ✅ 1 segundo arranque y 3 concurrentes → `canary_gateway_replica` | `08-*` |
| 3 | Worker `@8` | ✅ aislamiento `verified`, 0 tráfico ajeno | `03-*` |
| 4–6 | Conversación sintética + CIA + OTP + CP | ✅ `start` en la CIA desplegada → código del buzón sintético → inspector → `confirm` → vínculo → `customer.get_purchase_history` contra CP S5 en `enforce` con grant. **El código no aparece** en 301 columnas de texto o JSON, ni en logs ni en capturas | `04-*`, `06-otp-leakscan-*` |
| 5 | Caída de Customer Profile | ✅ con CP detenido, `get_context` falla y el agente dice que el servicio no responde, sin inventar datos. Al reiniciar CP, la lectura funciona. Código de error genérico (F-3) | `05-*` |
| 7 | Recuperación del dispatcher | ✅ CIA caída durante el `confirm` y reinicio del gateway. Al volver la CIA, el `confirm` se reanuda con **la misma clave de idempotencia** (12 intentos) y vincula la cuenta | `07-dispatcher-recovery.txt` |
| 9 | Pareado `@7`/`@8` | `@8` A: Catalog y Shipping reales y cotización **PC-000007** emitida (preview ×3, política allow, recibo `quote.create`). `@8` B: ofrece verificación. `@7` A: **ninguna respuesta** (F-1). `@7` B: correcta | `04-pair-at8.txt`, `09-pair-at7.txt` |
| 10 | Rollback controlado y purga | ✅ `full → protect_only` (3 ventanas abiertas, `@7` rechazado en worker e ingesta, código en `protect_only` sin persistir) → ventanas vencidas → gateway detenido (`ready: true`) → `@7`. Limitación conocida de `@7` observada (`unknown_capability` recuperado; mensaje engañoso, F-4). **Purga: `rowsRemaining: 0`**, `realCustomers` en 0, sha256 `bd2105ba…`. Esquema de la CIA eliminado (3 vínculos → 0). 0 procesos y 0 puertos del canary | `10-*`, `11-*` |

**Datos fuera de la base del canary.** La cotización PC-000007 quedó en el servicio de integración Quote V2 (`:4020`, entorno de prueba del canary J3), que no es de esta purga.

## 5. Hallazgos

| # | Severidad | Hallazgo | Estado |
|---|---|---|---|
| F-1 | **P0** | 5 respuestas malformadas en ~73 llamadas (`finish_reason: stop`, JSON mode activo). En 2 de 11 conversaciones fallaron dos runs seguidas: handoff de plataforma **sin ninguna respuesta al cliente**. `p7-a`: 0 respuestas a 5 mensajes | Investigado y corregido: `R4_J5_P0_STRUCTURED_OUTPUT_FAILURE_REPORT.md`, ADR-041 |
| F-2 | J5 | Despacho Directo de $1 presentado sin explicación. Es una promoción autorizada | Mandato J5 (Sales v9) |
| F-3 | J5 | La caída de CP llega como `handler_error` genérico | Mandato J5 (clasificación) |
| F-4 | Menor | `@7` ante una pregunta de Customer dijo «el servicio de datos de cliente no está respondiendo», pero `@7` no tiene esa capacidad | Limitación `@7` aceptada; mensaje a revisar en J5 |
| F-5 | Info | Discrepancia documental: producción en `@2`, no en `@3`. CP productivo en `*:3010` | Para el owner |

## 6. Fase 5 — piloto privado de WhatsApp: preparación

**No ejecutada:** su condición previa es que la Fase 4 pase, y F-1 es un fallo de confiabilidad conversacional. Para el piloto haría falta:
1. Un stack piloto separado (`production.js --gateway/--worker` con `sales-production@8`, BD piloto propia y CIA/CP sintéticos), detrás de la allowlist de remitentes (`R4_PROD_ROLLOUT_ALLOWLIST` con la clave del número del owner, rollout 0 %).
2. Cambiar la ruta del webhook de nginx de `:8090` al stack piloto. Es un cambio de enrutamiento productivo con recarga de nginx: requiere validar el impacto (el gateway `@2` deja de recibir) y ensayar el rollback (revertir el `location`) con autorización separada.
3. Pagos y pedidos no existen en R4. `quote.create` sigue gobernado por la política.

## 7. Recomendación J4-R6

**No avanzar todavía.** Pasan los gates de integración: CIA, CP, OTP, dispatcher, singleton, rollback y purga verificables con servicios desplegados. Falla el invariante de no abandonar conversaciones (F-1). Condiciones para J4-R6:
1. Fusionar la corrección P0 (ADR-041) tras su revisión independiente.
2. Repetir el canary en este mismo entorno y verificar que una falla de recuperación entrega el aviso fijo.
3. Mantener F-1 (confiabilidad del modelo) como bloqueante de J5.

## 8. Retención

- Logs y evidencia en `~/r4-j4-canary` (0700), lista sha256 en `evidence.sha256` (23 archivos). Logs sanitizados hasta **2026-11-02** (7 días); informes de aceptación hasta **2026-11-25** (30 días).
- No hay S3. El borrado al vencer queda como acción manual del owner: no se instaló cron en el host productivo.
