---
title: R4 — Despliegue de a704319 y activación del carril F1 (sales-production@17), con rollback a @13
status: PREPARADO y revisado (mandato «F1 final release gate», 2026-11-09). No ejecutado
date: 2026-11-09
---

# Despliegue de R4 `a704319` y activación de `@17` (solo allowlist)

**SHAs:**

| Componente | SHA | Estado |
|---|---|---|
| R4 | `a704319` | Despliegue pendiente; hoy corre `ae0bedf` |
| Quote V2 | `a79d33f` | Desplegado |
| Catalog V2 | `8a72c38` | Desplegado |

**Lo que no cambia:** el rollout general (`@3`, observe, 0 %), la allowlist, Checkout (apagado), el carrito (apagado) y las promociones (excluidas).

**Desplegar el código no activa `@17`.** El perfil del carril lo decide `R4_PROD_LANE_PROFILE` y el entorno del worker del carril. Mientras sigan en `@13`, `@17` no sirve ninguna conversación.

## 0. Preflight (2026-11-09)

| Verificación | Resultado |
|---|---|
| Respaldo de la base de R4 (`pg_dump -Fc`, roles, `~/.config/r4/*.env` y `run-*.sh`, SHA desplegado, SHA256SUMS) | `~/backups/r4-production/20261109T184554Z` (4,2 MB). **Se repite inmediatamente antes del despliegue** |
| Restore en un contenedor aislado | Las 9 tablas clave son idénticas a producción (16 tareas, 91 corridas, 387 pasos, 79 outbound, 11 solicitudes humanas, 4 recibos, 205 observaciones); head `0013` |
| Ensayo de migración con el código `a704319` sobre esa copia | Core `0014` y Sales `0010` aplicadas; una segunda ejecución no aplica nada; readiness `ok`, sin migraciones pendientes ni modificadas; head `0014` |
| Disco | 6,2 GB libres |
| Logs sin secretos ni datos personales | Los 4 logs de R4: 0 tokens, 0 claves, 0 teléfonos, 0 `wa_id`, 0 correos, 0 textos de mensajes |
| Quote sin carrito | Ningún `QUOTE_CART_*` definido; 0 preparaciones de carrito |

## 1. Compatibilidad entre procesos

**Por qué se despliegan todos juntos:**

- Cada worker publica su compatibilidad: la última migración Core empaquetada en **su** código, más el perfil.
- El gateway solo admite workers con la misma compatibilidad que él.
- Si un proceso queda con `ae0bedf` y otro con `a704319`, el gateway no reconoce a los workers: las entradas quedan retenidas, sin pérdida de datos.

Por eso el gateway, los dos workers y el scheduler se **detienen y arrancan juntos**.

**El esquema hacia atrás:**

- Readiness solo exige que no falten migraciones del código y que ninguna esté modificada. Una migración extra que el código no conoce no lo bloquea.
- `0014` solo amplía una restricción (admite `notice_key` además de `human_request_id`).
- `0010` crea una tabla que el código viejo no usa.

En consecuencia, el código `ae0bedf` funciona sobre un esquema en `0014`. Esto está verificado por lectura de código, no ejecutado.

## 2. Despliegue técnico (etapa 1: el carril sigue en `@13` y no hay escrituras comerciales)

1. **Kill switch puesto:** `npm run production:sales:control -- autonomy off --reason "R4 a704319 deploy"`.
2. **Drenar la entrega:** esperar a que no haya outbound `pending` ni `dispatching`. Una entrega cortada a mitad queda `unknown` y nunca se reenvía.
3. **Respaldo nuevo:** el mismo procedimiento del preflight. Verificar SHA256SUMS.
4. **Detener** con pm2: `r4-channel-gateway`, `r4-sales-worker`, `r4-sales-worker-lane` y `r4-scheduler`.
5. **Código:** `cd ~/R4-agent-platform && git fetch && git checkout a704319 && npm ci && npm run build`.
6. **Migraciones**, con el entorno de producción: `npm run db:migrate` (Core `0014`) y luego `npm run sales:migrate` (Sales `0010`).
7. **Arrancar**, en este orden: `r4-scheduler`, `r4-sales-worker`, `r4-sales-worker-lane` (todavía `@13`) y `r4-channel-gateway`.
8. **Verificar:**
   - pm2 `online` y 0 reinicios;
   - `worker.started` en los dos workers;
   - salud del gateway;
   - `production:sales:validate`.
9. **Regresión:** un mensaje de la allowlist actual sigue respondido por `@13` (carril) y uno fuera de la allowlist sigue en `@3`.
10. **Kill switch:** `autonomy on --reason "<aprobación>"`. `@3` y `@13` no escriben en Quote.

**Idempotencia durante el corte:**

- Con el kill switch puesto no se propone ninguna escritura nueva, y `@3`/`@13` no escriben en Quote.
- Las acciones que estaban en curso se reconcilian por su clave al reiniciar (lo probaron R9 y A8).
- El outbound cortado queda `unknown` y no se reenvía.

## 3. Preparación del carril (etapa 2)

1. Ejecutar `autonomy off`.
2. **Cerrar las conversaciones `@13` abiertas del carril:** `production:sales:control -- tasks cancel --task <id> --reason "lane switch to @17"`. El gateway solo sirve el perfil actual del carril, y una tarea `@13` quedaría sin worker.
3. **`production-lane.env`:**
   - `R4_PROD_POLICY_PROFILE=sales-production@17`;
   - `R4_EXEC_MAX_WRITE_ACTIONS=6`;
   - los límites F1 `R4_AUTONOMOUS_QUOTE_*`: 250000, 3, 5, 5, 1, 2, 900.
4. **`run-worker-lane.sh`:** agregar `source /home/ec2-user/.config/r4/quote-v2-retail.env` (Quote real, `r4-sales-retail-session`, timeout 20 s). **Sin P-1.** Shipping (`R4_SHIPPING_*`) y Catalog V2 ya están configurados.
5. **`production.env`:** `R4_PROD_LANE_PROFILE=sales-production@17`. La allowlist no cambia.
6. **Bootstrap**, con el entorno del carril: `npm run production:sales:bootstrap -- --lane`. Registra la definición v16.
7. **Validación sin efectos:** `production:sales:validate`. Rechaza Quote sin Shipping, límites F1 más laxos y un presupuesto fuera de 1..6.
8. **Reiniciar** el worker del carril y el gateway. Verificar que el worker del carril sirve `sales@16`.
9. **Prueba de humo con el kill switch puesto:** un mensaje de la allowlist llega a `@17` y Quote no se llama.

## 4. Primera cotización (etapa 3: requiere la autorización final e independiente del owner)

1. Ejecutar `autonomy on --reason "<autorización del owner, SHA a704319>"`.
2. Pedir **una** cotización desde WhatsApp en una conversación de la allowlist.
3. Verificar:
   - producto y variante de Catalog V2, con stock y precio vigentes;
   - la vista previa y la confirmación explícita;
   - la emisión en Quote: `cl-retail-session-60m-v1`, documento, persistencia, una sola cotización, sin despacho y sin carrito;
   - la respuesta por WhatsApp.
4. **Si hay un incumplimiento crítico:** `autonomy off` y rollback (§5).

## 5. Rollback

**A. Rollback de perfil (`@17` → `@13`), el primario; el código no cambia:**

1. `autonomy off`.
2. Esperar a que ninguna `quote.create` quede en `executing` o `unknown`.
3. Detener el gateway y el worker del carril.
4. Cerrar las tareas `@17` abiertas (`tasks cancel`).
5. Restaurar `production-lane.env`, `run-worker-lane.sh` y `production.env` desde el respaldo.
6. Arrancar el worker del carril y el gateway.
7. `autonomy on`.

**B. Rollback de código (`a704319` → `ae0bedf`), solo si el código nuevo falla en sí mismo:**

1. `autonomy off`.
2. Detener los 4 procesos.
3. `git checkout ae0bedf && npm ci && npm run build`.
4. Restaurar la configuración del respaldo.
5. Arrancar los 4 procesos juntos.

La base **puede quedar en `0014`/`0010`** (§1), con una condición: **no debe haber outbound pendientes con `notice_key`**. Hoy ninguno, porque solo `@15` los crea y está inactivo.

**C. Último recurso:** restaurar la base desde el respaldo del paso 2.3, con todos los procesos detenidos, y volver a `ae0bedf`.

**Quote:** sus cotizaciones emitidas siguen vigentes 60 minutos. El rollback de Quote (`6735352`) es independiente; ver `~/backups/quote-v2-integration/`.

## 6. Alertas operativas (`ops/r4-f1-alerts/`)

**Diseño:** CloudWatch con el **agente oficial** (`amazon-cloudwatch-agent`, ya disponible en AL2023), más SNS por correo. No hay ningún servicio de alertas propio de R4. Las alertas son filtros de métricas sobre los eventos que R4 ya registra:

| # | Alerta | Evento | Umbral |
|---|---|---|---|
| 1 | Runtime caído | `pid_count` de cada proceso (gateway 1, workers 2, scheduler 1); `worker.stopped`, `scheduler.cycle.failed`, `task.run_failure.non_retryable` | < esperado durante 2 min; ≥ 1 en 5 min |
| 2 | Fallos de Quote reiterados | `quote.call` con `outcome=failed` | ≥ 3 en 5 min |
| 3 | Resultado desconocido sin resolver | `reconciliation.unresolved`, `action.outcome_uncertain` | ≥ 1 |
| 4 | Anomalía de idempotencia | `quote.call` con `errorCode=idempotency_key_conflict` | ≥ 1 |
| 5 | Falla de entrega por WhatsApp | `outbound.failed`, `outbound.unknown` | ≥ 1 |
| 6 | Presupuesto de escrituras | `budget.exhausted` | ≥ 1 |

**Bloqueo hoy: la EC2 no tiene un rol IAM y no hay credenciales de AWS.** Hace falta, del owner:

1. Un rol de instancia con la política administrada `CloudWatchAgentServerPolicy`, asociado a la EC2.
2. Un operador con permisos de `logs`, `cloudwatch` y `sns` que ejecute `REGION=us-east-1 ALERT_EMAIL=<correo autorizado> ops/r4-f1-alerts/setup-alarms.sh`.
3. El correo de destino autorizado. Hay que confirmar la suscripción y la recepción de `aws sns publish` (mensaje de prueba).

Después:

- instalar el agente: `sudo dnf install -y amazon-cloudwatch-agent`;
- cargar `ops/r4-f1-alerts/cloudwatch-agent.json` con `amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:<ruta>`.
