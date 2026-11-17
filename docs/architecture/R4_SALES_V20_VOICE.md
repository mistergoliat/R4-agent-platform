---
title: R4 — Voz de Don Pesín (sales-production@20, definición v20)
status: R4_SALES_V20_VOICE_READY_FOR_REVIEW — implementado (no desplegado ni activado)
date: 2026-11-17
mandate: decisión del owner, 2026-11-17: el agente suena demasiado serio; se quiere la voz más humana
---

# Voz de Don Pesín (`@20`)

## 1. Qué cambia

`@20` es `@19` sin cambios de dominios, capacidades ni controles, fijado a la **definición v20**. v20 es v19 más:

1. **Sección de voz al inicio** («## Don Pesín: cómo conversas»), la variante que ganó en los replays de tono, textual, con dos ejemplos de tono más (saludo y agradecimiento).
2. **Recomendación:** «Never call a product the best one.» pasa a «You may recommend one product as your pick, always with its reason from verified data; never claim it is objectively the best.»
3. **PDF:** el agente dice que el PDF «te llega acá mismo», ya no «el PDF sigue en esta conversación». Sigue siendo solo con `document.delivery = queued`.
4. **Despacho al cambiar la selección:** si la cotización anterior fue sin despacho y el cliente cambia o agrega productos, pregunta si sigue sin despacho antes de pedir la comuna.

El resto de v19 se mantiene línea por línea. El contrato `tests/contract/sales-profile-v20.test.ts` reconstruye v20 desde v19 con exactamente estas ediciones. v19 y `@19` no se modifican.

## 2. Dónde está `@20`

Mismos conjuntos que `@19`: `SALES_LANE_PROFILES` (carril, bootstrap `--lane`, percepción de medios), `isQuoteLaneProfile` (límites F1, techo de escrituras, single-flight), `SALES_AUTONOMOUS_QUOTE_PROFILES`, `SALES_CONFIRMED_INTENT_PROFILES`, `SALES_DETERMINISTIC_OFFER_PROFILES`, `SALES_VARIANT_AVAILABILITY_PROFILES`, `SALES_QUOTE_DOCUMENT_PROFILES`, `SALES_INTENT_ACCEPTANCE_PROFILES`, `SALES_F1_SHIPPING_PROFILES` (política v2 y cotizaciones promocionales v3), `SALES_HUMAN_REQUEST_NOTICE_PROFILES`, `CANARY_PROFILES` y `SALES_PRODUCTION_AGENT_VERSIONS` (`@20` → v20).

## 3. Gate (`SALES_PRODUCTION_PROFILE_V20_GATE`)

Los ítems de `@19`, salvo su registro y su autorización, más:

- `voice-l3`: L3 con el modelo real. La voz no agrega datos de producto, precio, stock ni despacho fuera de las observaciones. La oferta se presenta exacta y se acepta en lenguaje natural. El PDF se anuncia solo cuando está en cola. Ante un cambio sobre una cotización sin despacho, pregunta si sigue sin despacho antes de pedir la comuna.
- `profile-20-registered`: `production:sales:bootstrap --lane` con `R4_PROD_POLICY_PROFILE=sales-production@20` (registra v20).
- `explicit-authorization`: autorización del owner por SHA exacto, solo allowlist, con `@19` como rollback.

## 4. Activación (no autorizada en este PR)

1. Deploy del SHA mergeado. Nada cambia mientras el carril siga en `@19`.
2. Registrar v20/`@20`: `production:sales:bootstrap --lane` con `R4_PROD_POLICY_PROFILE=sales-production@20`.
3. Levantar un worker del carril con `R4_PROD_POLICY_PROFILE=sales-production@20` (`servedAgents` = v20) junto al de `@19`, con la misma configuración de `@19`: límites F1, `R4_EXEC_MAX_WRITE_ACTIONS`, `R4_F1_PROMOTIONAL_QUOTES` y el modelo.
4. Cambiar el carril del gateway a `R4_PROD_LANE_PROFILE=sales-production@20` y reiniciarlo. **`R4_MEDIA_PERCEPTION_PROFILES` debe listar `sales-production@20`** (y `@19` mientras drenan sus conversaciones); si no, las imágenes y los audios del carril vuelven a quedar para una persona.
5. Según ADR-045, un binding abierto sigue en su perfil. El worker de `@19` sigue en marcha hasta que sus tareas abiertas no tengan entradas pendientes. Solo las conversaciones nuevas abren con `@20`.
6. Rollback: lo mismo en sentido inverso. Volver `R4_PROD_LANE_PROFILE` (y la lista de percepción) a `sales-production@19` con el worker de `@19` en marcha, y mantener el de `@20` hasta drenar sus tareas. v19 ya está registrada y no cambia.
