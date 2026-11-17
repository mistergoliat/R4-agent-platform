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

## 5. v21 / `@21`: feedback del owner tras probar `@20` por WhatsApp (2026-11-17)

`@21` es `@20` fijado a la **definición v21**. v21 es v20 más las ediciones de abajo. v20 y `@20` no cambian, y `@20` queda como rollback. El contrato `tests/contract/sales-profile-v21.test.ts` reconstruye v21 desde v20 con exactamente estas ediciones.

| # | Caso observado con `@20` | Edición en v21 |
|---|---|---|
| 1 | Después de emitir una cotización, el cliente escribió «gracias» y el agente decidió `complete` sin responder | Interaction: «Complete the task … only when the conversation has clearly ended» pasa a ser «los agradecimientos y despedidas también se responden: breve, agradeciendo con calidez el contacto con PesasChile, con palabras propias (nunca una fórmula fija), y se espera. Nunca `complete` después de un mensaje del cliente» |
| 2 | Copió textual el saludo de ejemplo («¡Hola! Soy Don Pesín. ¿Qué andas buscando?») | Salen los dos ejemplos literales de v20 (saludo y agradecimiento). Se agrega una guía de saludo: bienvenida cálida a PesasChile, con palabras propias, distinta cada vez, preguntando qué necesita; presentarse como Don Pesín es opcional. También una línea general: «Nunca copies los ejemplos de tono palabra por palabra: muestran el tono, no el texto» |
| 3 | A un cliente de 150 kg le ofreció una barra de máximo 150 kg como «calza con tu presupuesto y ese requisito» | Truth and evidence: si el uso está en o cerca de la capacidad máxima declarada, se dice que está al límite, sin margen, y se busca una opción con más capacidad; nunca se presenta como adecuada |
| 4 | «Para espalda» recibió de inmediato una máquina de $1.199.990 | Interaction: ante una necesidad abierta sin presupuesto ni contexto, se pregunta qué quiere lograr, dónde entrena y cuánto quiere gastar, o se ofrece primero una opción simple, antes de una máquina cara |
| 5 | «su precio promocional no se puede cotizar formalmente» | Interaction: nunca mostrar términos de plataforma o de política; decirlo en palabras del cliente (por ejemplo, que está en promoción pero esa oferta no se puede dejar en una cotización ahora). La regla de promociones no cambia |

`@21` está en los mismos conjuntos que `@20` (§2). Su gate es el de `@20` (sin su registro ni su autorización) más `feedback-l3` (replay de los cinco casos con el modelo real), `profile-21-registered` y `explicit-authorization` con `@20` como rollback. La activación es la de §4, cambiando `@20` por `@21` y `@19` por `@20`: worker de `@21` junto al de `@20`, `R4_PROD_LANE_PROFILE=sales-production@21`, y `R4_MEDIA_PERCEPTION_PROFILES` con `sales-production@21` (y `@20` mientras drenan sus conversaciones).
