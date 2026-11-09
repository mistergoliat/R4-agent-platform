---
title: R4 — Activación del carril F1 de cotizaciones (sales-production@17) y rollback a @13
status: PREPARADO — no ejecutado. Requiere la autorización final del owner sobre el SHA exacto
date: 2026-11-09
---

# Activación de `@17` en el carril (solo allowlist) y rollback a `@13`

**Nada de esto se ejecuta sin la autorización final del owner sobre el SHA exacto de R4.** El rollout general no cambia (`@3`, observe, 0 %). Solo cambia el carril ADR-045, con la allowlist existente.

## 0. Precondiciones (todas verificadas, en este orden)

| # | Verificación | Cómo |
|---|---|---|
| 1 | SHA de R4 fijado y L3 satisfactorio sobre ese SHA, con Quote `a79d33f` y Catalog `8a72c38` | Informe L3 |
| 2 | El owner de Quote autorizó `r4-sales-retail-session` para tráfico real (60 minutos) | Quote #33 |
| 3 | Política `F1-COMMERCIAL-POLICY-v1` aprobada | `R4_F1_COMMERCIAL_POLICY.md` |
| 4 | Alertas operativas en marcha (§4) | Prueba de disparo |
| 5 | Quote sin carrito: `QUOTE_CART_PREPARATION_ENABLED` sin definir o `false`, y H3 `closed`; `@17` sin Checkout | `docker exec quote-v2-integration env`, contrato de `@17` |
| 6 | Respaldo de la base de R4 y de `~/.config/r4/` | §1 paso 1 |

## 1. Activación

> **Movimiento coordinado.** Entre el R4 desplegado (`ae0bedf`) y el candidato hay dos migraciones nuevas: Core `0014` (avisos de plataforma) y Sales `0010`. Core `0014` cambia la identidad de compatibilidad de los workers, así que **todos** los procesos (gateway, worker principal, worker del carril y scheduler) se mueven juntos.

1. **Respaldo:**
   - `pg_dump -Fc` de la base de R4 (contenedor `r4-production-postgres`);
   - copia de `~/.config/r4/*.env` y `run-*.sh`;
   - SHA anterior: `ae0bedf`.
2. **Kill switch:** `npm run production:sales:control -- autonomy off --reason "F1 @17 activation"`.
3. **Detener** con pm2: `r4-channel-gateway`, `r4-sales-worker`, `r4-sales-worker-lane` y `r4-scheduler`.
4. **Código:** `cd ~/R4-agent-platform && git fetch && git checkout <SHA> && npm ci && npm run build`.
5. **Cerrar las conversaciones `@13` del carril.** El gateway solo sirve los bindings de su perfil principal y de su carril actual, y una tarea `@13` quedaría sin worker. Para cada tarea abierta del carril:

   `npm run production:sales:control -- tasks cancel --task <id> --reason "lane switch to @17"`

   El próximo mensaje abre un binding `@17`.
6. **Configuración del carril:**
   - En `production-lane.env`:
     - `R4_PROD_POLICY_PROFILE=sales-production@17`;
     - `R4_EXEC_MAX_WRITE_ACTIONS=6`;
     - los límites F1: `R4_AUTONOMOUS_QUOTE_MAX_GROSS_CLP=250000`, `_MAX_LINES=3`, `_MAX_UNITS_PER_LINE=5`, `_MAX_TOTAL_UNITS=5`, `_MAX_PER_CONVERSATION=1`, `_MAX_PER_HOUR=2` y `_CONFIRMATION_WINDOW_SECONDS=900`.
   - En `run-worker-lane.sh`, agregar `source /home/ec2-user/.config/r4/quote-v2-retail.env`. Ese archivo ya existe y está inactivo; tiene `R4_QUOTE_*` con `r4-sales-retail-session`.
   - En `production.env`, `R4_PROD_LANE_PROFILE=sales-production@17`. **La allowlist no cambia.**
   - **Sin P-1:** no se define `R4_QUOTE_PARITY_EVIDENCE_FILE`.
   - Shipping (`R4_SHIPPING_*`) ya está configurado.
7. **Bootstrap:**
   - `npm run production:sales:bootstrap` (perfil principal);
   - con el entorno del carril, `npm run production:sales:bootstrap -- --lane`. Registra la definición v16 de `@17`.
8. **Validación sin efectos:** `production:sales:validate` y `production:sales:plan` con el entorno del carril. Rechaza cualquier configuración incompleta: Quote sin Shipping, límites F1 más laxos, presupuesto fuera de 1..6.
9. **Arranque**, en este orden: `r4-scheduler`, `r4-sales-worker`, `r4-sales-worker-lane` y `r4-channel-gateway`. Verificar:
   - `worker.started`, con el worker del carril sirviendo `sales@16`;
   - pm2 `online` y 0 reinicios;
   - salud del gateway.
10. **Prueba de humo con el kill switch puesto:** un mensaje de la allowlist llega a `@17`. Quote no se llama, porque el kill switch retiene las escrituras.
11. **Primera escritura real:** solo con la autorización final del owner, `autonomy on --reason "<autorización>"`. Queda bajo observación activa.

## 2. Rollback a `@13`

**Rollback por perfil (el primario, sin cambiar código):**

1. `autonomy off`.
2. Esperar a que ninguna `quote.create` quede en `executing` o `unknown`. Las retenidas se reconcilian por su clave.
3. Detener el gateway y el worker del carril.
4. Cerrar las tareas `@17` abiertas (`tasks cancel`).
5. Volver a `R4_PROD_LANE_PROFILE=sales-production@13`, al `production-lane.env` anterior y a `run-worker-lane.sh` sin `quote-v2-retail.env`.
6. Arrancar el worker del carril y el gateway.
7. `autonomy on`. `@13` no escribe en Quote.

**Rollback de código (solo si el SHA nuevo falla en sí mismo):** volver a `ae0bedf` exige **restaurar la base de R4** desde el respaldo del paso 1, porque `0014` cambia la identidad de compatibilidad. Se hace con todos los procesos detenidos.

**Quote:** sus cotizaciones ya emitidas siguen válidas por 60 minutos. El rollback de Quote (`6735352`) es independiente; ver `~/backups/quote-v2-integration/`.

## 3. Lo que no cambia

- El rollout general.
- El perfil principal `@3` y su modo observe.
- La allowlist.
- El principal de 5 días, que no se usa.
- El carrito y Checkout.

## 4. Alertas mínimas (bloqueo: hoy no existen)

R4 no tiene alertas operativas (solo logs en pm2), y en la EC2 corre únicamente `amazon-ssm-agent`. Antes de la primera escritura real hace falta, como mínimo, alertar sobre:

- reinicios o un proceso pm2 del carril que no esté `online`;
- `quote.create` en `unknown` o retenida por más de 5 minutos;
- `model.call.failed` no reintentable;
- `handoff.requested` y `consultation.requested`, para avisar al administrador;
- Quote `/health/ready` distinto de 200.

El canal de notificación (correo, WhatsApp del owner, CloudWatch) es una **decisión del owner**.
