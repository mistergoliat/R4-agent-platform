---
title: R4-J4-R7-4 — plan de despliegue en EC2
status: PLAN — NOT AUTHORIZED
mandate: «R4 — R7-4 Final PR Review» (owner, 2026-11-04), §5
date: 2026-11-04
---

# R7-4: plan de despliegue

**Alcance.** Este documento describe cómo desplegar R7-4 cuando el owner lo autorice. **No autoriza nada:** no se ha tocado EC2 ni la base de producción.

Se basa en el procedimiento del despliegue de R7 (`R4_R7_EC2_DEPLOYMENT_REPORT.md`, 2026-10-30), que ya tiene rollback probado.

## 1. Qué cambia

| Aspecto | Hoy (producción) | Con este despliegue |
|---|---|---|
| Código | `0deaac6` (R7-1 y R7-2, llegó por bundle) | **SHA explícito** del merge commit del PR #36 en `main` |
| Esquema Core | `0012_platform_fallback_outbound` (15 migraciones en total) | `+ 0013_conversation_binding_history` (índice aditivo) |
| Compatibilidad del worker | `0012_platform_fallback_outbound:sales-production@3` | `0013_conversation_binding_history:sales-production@3` |
| Contexto del modelo | Una task nueva no ve las anteriores | Ve los turnos de las tasks anteriores de la misma conversación de los últimos 30 días, como conversación y nunca como evidencia |
| Perfil y definición | `sales-production@3` (definición v4) | Sin cambios |
| `R4_TURN_GUARD` | `observe` | `observe`. **No se activa `enforce`** |
| Rollout y allowlist | 0 %, 1 entrada | Sin cambios |
| `R4_PROD_PRIOR_CONVERSATION_DAYS` | No existe | Sin definir; rige el valor por defecto, 30 |

**Delta de código.** El SHA a desplegar trae, además de R7-4, todo lo que entró a `main` después de `0deaac6`:
- la integración de R7 (PR #33);
- la estrategia de pruebas (PR #34, sólo documentación);
- los PR que se fusionen antes del corte.

El delta de runtime entre `0deaac6` y el SHA elegido se revisa como compuerta (§3, D-1). Si incluye algo más que R7-4 y R7, se informa al owner antes del corte.

## 2. Riesgo de escritura de la migración 0013

- **Lock.** `CREATE INDEX` sin `CONCURRENTLY` (el migrador es transaccional) toma un lock SHARE sobre `channel_conversation_bindings`. Durante la construcción quedan bloqueadas las escrituras a esa tabla: ingreso de mensajes, apertura y cierre de bindings. Las lecturas siguen.
- **Duración esperada.** Medida en una estación de trabajo: 8,4 s con 540.000 bindings. Producción tiene un número de bindings de dos dígitos, que se medirá en preflight, así que la construcción dura milisegundos.
- **Mitigación.** Igual que en R7: la migración corre con gateway, worker y scheduler **detenidos**. No hay escritores concurrentes y el lock no afecta a nadie.
- **Mensajes durante el corte.** Los webhooks que lleguen con el gateway detenido fallan, y Meta los reintenta. En R7 el corte duró unos 18 s.
- **Irreversible en el registro.** El migrador sólo avanza. El índice no reescribe datos y puede eliminarse (§6).
- **Prohibido crear el índice a mano.** `0013` no usa `if not exists`: un índice homónimo previo haría fallar la migración.

## 3. Compuertas previas (todas en `PASS` antes del corte)

| # | Compuerta | Cómo |
|---|---|---|
| D-0 | Mandato de despliegue del owner, con el SHA explícito | Fuera de este plan |
| D-1 | Delta de runtime `0deaac6..SHA` revisado | `git diff --stat 0deaac6 <SHA> -- packages apps adapters agents`; se informa cualquier cambio ajeno a R7 o R7-4 |
| D-2 | Preflight de solo lectura en EC2 | Tasks vivas por versión de definición (ninguna incompatible con @3), outbox sin `pending` ni `dispatching`, número de bindings, `r4_schema_migrations` = 15 con cabeza `0012`, disco libre, memoria (build limitado a 1,2 GB como en R7) |
| D-3 | Handoff abierto de la conversación en la allowlist | La task del owner está `blocked` (`run_budget_exhausted`, 2026-11-04) con un handoff `requested`. El despliegue no la toca. El owner decide si se resuelve antes (por ejemplo, tomarlo y liberarlo) o se deja. Con R7-4, la continuidad sólo actúa cuando esa task termine |
| D-4 | Respaldo y restauración de prueba | Ver §4 |
| D-5 | Prueba aislada sobre la restauración | Restaurar el respaldo en una base aparte, aplicar `0013` con el build nuevo y verificar que se aplica sólo esa migración. Luego, con modelo y WhatsApp simulados: una conversación de dos tasks donde la segunda ve la primera; aislamiento con otro contacto; los 12 smoke tests de R7 sin regresión |
| D-6 | Build en el servidor | `npm ci` y `npm run build` en un directorio nuevo bajo `~/r4-releases/`, con el SHA verificado (`git rev-parse HEAD` y digest de `dist`) |

## 4. Respaldos

- **Antes del corte:** `pg_dump` de `r4_production` (formato custom) en `~/r4-backups/`, modo 600, con SHA-256 y restauración de prueba (conteo de tablas y filas).
- **Con los procesos detenidos:** un segundo respaldo, el **final**, inmediatamente antes de migrar.
- **Copia del entorno:** `~/.config/r4/production.env` copiado a `production.env.bak-r74-<timestamp>`.
- **Directorio de código actual:** se conserva intacto como `~/r4-releases/R4-agent-platform.0deaac6` para el rollback.
- **Límite conocido:** los respaldos quedan en el mismo disco que la base. Se recomienda copiar el respaldo final fuera del servidor. Requiere decisión del owner.

## 5. Corte (coordinación de procesos)

Orden, con tiempos registrados:
1. `pm2 stop r4-channel-gateway r4-sales-worker r4-scheduler`. No tocar `catalog-service`, `customer-profile`, `crm-web` ni los contenedores.
2. Respaldo final (§4).
3. Cambiar el directorio de código al build nuevo, verificado en D-6.
4. `db:migrate` con `production.env`. **Esperado: `applied: ['0013_conversation_binding_history']` y nada más.** Cualquier otra migración pendiente detiene el corte: se ejecuta el rollback y se informa.
5. Entorno: sólo actualizar `R4_BUILD_REF` al SHA. Verificar `R4_TURN_GUARD=observe`, `R4_PROD_POLICY_PROFILE=sales-production@3`, rollout 0 % y allowlist idéntica (diff contra la copia).
6. `pm2 restart r4-scheduler r4-sales-worker r4-channel-gateway`. Gateway y worker **con el mismo SHA**: si las compatibilidades difieren, `/ready/r4` responde 503 `no_worker`.

## 6. Verificación posterior

| # | Verificación | Esperado |
|---|---|---|
| V-1 | Procesos | Los 3 en línea, `cwd` en el directorio nuevo, iniciados después del corte, sin reinicios |
| V-2 | Esquema | 16 migraciones Core más Sales; cabeza `0013`; índice `channel_conversation_bindings_conversation_history` presente |
| V-3 | Readiness | Gateway `/health` y `/ready` 200; `/ready/r4` 200; `worker_presence.compatibility = 0013_conversation_binding_history:sales-production@3` |
| V-4 | Plan real | `EXPLAIN` de solo lectura de la consulta de turnos anteriores, para la task viva: `Index Scan` sobre el índice nuevo. Con pocas filas, el planificador puede elegir otro plan, y es aceptable |
| V-5 | Configuración | `observe`, @3, 0 %, allowlist idéntica. `R4_PROD_PRIOR_CONVERSATION_DAYS` ausente (30) |
| V-6 | Credenciales y webhook | Igual que en R7: consultas de estado de WhatsApp y del modelo sin envíos; webhook sin firma 401, token inválido 403 |
| V-7 | Continuidad real (opcional, requiere al owner) | Una conversación del owner que cierre una task y abra otra: la segunda ve la primera |

## 7. Rollback

**Rollback de código** (recomendado, pocos segundos). Probado para R7 y válido aquí, porque un build anterior ignora una migración aplicada que no conoce:

```bash
pm2 stop r4-channel-gateway r4-sales-worker r4-scheduler
mv ~/R4-agent-platform ~/r4-releases/r4-<SHA>-rolledback
mv ~/r4-releases/R4-agent-platform.0deaac6 ~/R4-agent-platform
cp -p ~/.config/r4/production.env.bak-r74-<timestamp> ~/.config/r4/production.env
pm2 restart r4-scheduler r4-sales-worker r4-channel-gateway
```

- **Compatibilidad.** Gateway y worker vuelven a `0012_…:sales-production@3`.
- **Índice.** Queda, sin efecto en `0deaac6`. Si hubiera que quitarlo: `drop index channel_conversation_bindings_conversation_history;`. La migración sigue registrada, y un nuevo despliegue de R7-4 no la recrearía.
- **Restauración completa** (última opción, decisión del owner): con los procesos detenidos, se restaura el respaldo final. Se pierde todo lo posterior al corte.

## 8. Observación

- **Plazo y señales:** al menos 24 h, o hasta la siguiente conversación real que cruce dos tasks.
  - errores y reinicios;
  - eventos de handoff (`run_*`);
  - latencia de compilación de contexto;
  - turnos anteriores incluidos o excluidos en las snapshots de las tasks nuevas.
- **Condición de rollback:** turnos de otra conversación en un contexto, duplicados, o un aumento de handoffs atribuible al cambio.
- **Pendiente heredado.** Mientras no se resuelva D-7 (DS-1 del backlog), cualquier escritura que el modelo intente con `maxWriteActions` 0 termina en handoff, con o sin R7-4.

## 9. Fuera de este plan

Siguen fuera:
- `enforce`;
- cambios de rollout, allowlist o perfil;
- la resolución de D-7, DS-1 y DS-2;
- IR-2 e IR-3;
- cualquier cambio en Quote, Checkout o Shipping.
