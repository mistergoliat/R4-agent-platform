# R4 — Plan de rollout comercial controlado (M5)

Mandato «R4 — COMMERCIAL SCALE-UP: MEASUREMENT, OPTIMIZATION, FOLLOW-UP AND CHECKOUT», M5. Este documento es un plan y no cambia nada. No activa capacidades, no cambia el rollout y no introduce límites comerciales. Cada avance de etapa requiere la autorización explícita del owner.

**Estado:** `R4_CONTROLLED_ROLLOUT_PLAN_READY`, con prerrequisitos técnicos abiertos (§2: P1 implementado sin desplegar; P2 a P4 abiertos).

## 1. Punto de partida

Hoy producción atiende WhatsApp con el perfil de carril `sales-production@22` (antes `@19`; `@20` y `@21` superados) y GPT-6 Luna (OpenRouter). Ese perfil incluye Catalog V2 con Discover, Shipping, Quote V2 regular y promocional, PDF, imágenes y notas de voz. La configuración actual es `R4_PROD_ROLLOUT_PERCENT=0` con allowlist, Checkout deshabilitado y CloudWatch/SNS diferidos.

La medición sale del reporte M1 (`ops/r4-metrics/`), que es de solo lectura y separa:

- **testers**: elegibilidad `allowlisted`;
- **comercial**: elegibilidad `cohort`, es decir, el porcentaje de rollout.

Hasta hoy todo el tráfico medido es de testers. Las cifras de producción no se publican en este repositorio; el reporte se genera localmente.

## 2. Prerrequisitos técnicos (bloquean la etapa 2)

**P1. Un cliente de la cohorte no llega al perfil del carril (`@22`).**

El carril del gateway (ADR-045, `salesGatewayLane`) atiende solo las claves de conversación listadas en `R4_PROD_LANE_ALLOWLIST`. Una conversación que entra por el porcentaje de rollout (`cohort`) la atiende el perfil principal del gateway (`R4_PROD_POLICY_PROFILE`, hoy `@3`), que no tiene Quote ni Discover. Además, el perfil principal no puede ser un perfil de carril. Por eso subir `R4_PROD_ROLLOUT_PERCENT` hoy no da a clientes reales la experiencia probada.

Opciones, que se deciden con revisión de arquitectura antes de la etapa 2:

- **a. Carril por porcentaje.** El carril acepta, además de su lista, la cohorte del rollout. Es un cambio acotado en `salesGatewayLane` y `ChannelIngress`, con el mismo worker y la misma definición.
- **b. Perfil de producción equivalente al perfil del carril.** Un perfil no-carril que el gateway usa como principal. Requiere un nuevo número de perfil, sin tocar las definiciones históricas.

La recomendación es la **a**: menos superficie, y el rollback sigue siendo bajar el porcentaje.

**Implementada la opción a** (ADR-045, enmienda 1; pendiente de revisión y merge, no desplegada): con el carril compuesto, la cohorte del rollout abre en el perfil del carril. En `R4_PROD_ROLLOUT_PERCENT=0` nada cambia. Con un porcentaje mayor que 0, el gateway de WhatsApp no arranca sin carril, ni con un perfil de carril distinto de `sales-production@22` (la lista aprobada `SALES_COHORT_LANE_PROFILES`, una constante en código).

Límites que el operador debe conocer (enmienda 1, puntos 6 a 8):

- Bajar el porcentaje no revoca la autonomía de las conversaciones de cohorte ya abiertas (§6).
- Un cliente con un binding `@3` abierto desde antes de subir el porcentaje no entra a la cohorte hasta que esa tarea termina. Los clientes recurrentes quedan sub-representados en la cohorte, y las métricas de etapa 2 se leen con ese sesgo.

**P2. No hay alerta de saldo del proveedor.**

El 2026-11-13 el saldo directo de DeepSeek llegó a cero y cada turno terminó en `provider_error` y derivación humana. Ninguna alerta lo advirtió. Antes de clientes reales, el observador debe consultar el saldo de OpenRouter (`GET /api/v1/credits`, solo lectura) y avisar bajo un umbral expresado en días de gasto. El gasto diario sale del reporte M1.

**P3. `/ready/r4` no cuenta el worker del carril.**

La readiness del gateway cuenta sólo los workers del perfil principal (ADR-045, límites conocidos). Con la cohorte en el carril, un worker del carril caído deja a clientes reales sin respuesta mientras la readiness sigue verde. Antes de la etapa 2, el worker del carril debe entrar en la readiness, o el observador debe alertar cuando no esté `online` en `worker_presence`. La alerta 7 de §5 cumple esta condición si ya está activa en producción.

**P4. Rotar la clave de identidad antes de subir el porcentaje.**

La rotación pendiente de `R4_PROD_IDENTITY_HASH_KEY` cambia todas las claves de conversación y, con ellas, los buckets. Las conversaciones abiertas dejarían de encontrar su binding, y los bindings de cohorte abiertos quedarían huérfanos de su conversación. Se rota en la etapa 0 o 1, nunca durante la etapa 2.

## 3. Etapas

Las etapas no tienen días fijos. Una etapa termina cuando acumula la muestra que permite afirmar su criterio con la confianza indicada, y antes no.

El tamaño de muestra sigue la regla del tres: si en `n` conversaciones independientes no ocurre un fallo grave, la tasa real es menor que `3/n` con un 95 % de confianza.

| Etapa | Quién | Control | Sale cuando | Cota que demuestra |
|---|---|---|---|---|
| 0. Canary | Owner y testers nombrados | `R4_PROD_LANE_ALLOWLIST` + allowlist del rollout | Los escenarios de aceptación vigentes pasan (F/G, promocional, álbum, voz) y P1 y P2 están resueltos | Funcional, no estadística |
| 1. Usuarios reales controlados | Clientes invitados por el equipo comercial y agregados por clave a la allowlist | Allowlist (decenas de conversaciones) | 100 conversaciones con al menos 1 turno sin fallo grave (§4.1) | Fallo grave < 3 % |
| 2. Expansión progresiva | Fracción de clientes que escriben al número | `R4_PROD_ROLLOUT_PERCENT`: 1 %, después 5 % y 20 % (requiere P1 a P4) | En cada escalón, 300 conversaciones de cohorte sin fallo grave y métricas §4.2 dentro de banda | Fallo grave < 1 % por escalón |
| 3. General | Todos | `R4_PROD_ROLLOUT_PERCENT=100`, con denylist para excepciones | — | Operación con alertas (§5) |

Un escalón con poco tráfico tarda más en juntar su muestra; subir el porcentaje para acelerar no es un criterio válido.

Qué se activa para clientes reales en la etapa 2. Un porcentaje mayor que 0 les da todo lo que tiene `@22` (lo mismo que `@19` más el texto del agente de v20 a v22), no sólo la conversación:

- percepción de imágenes con un modelo de terceros, si `R4_MEDIA_PERCEPTION` y `R4_MEDIA_PERCEPTION_PROFILES` la incluyen;
- cotizaciones promocionales, si `R4_F1_PROMOTIONAL_QUOTES` está encendido;
- la emisión de Quote V2 en vuelo única (single-flight), con hasta 20 s de espera del lock por emisión bajo concurrencia.

Antes de cada escalón se confirma cuáles están encendidas.

Las capacidades nuevas (Checkout, seguimiento proactivo) **no** se activan dentro de este plan. Cada una tiene su propia etapa 0.

## 4. Métricas por etapa

### 4.1 Fallos graves: cualquiera bloquea el avance y obliga a revisar

- Una cotización emitida con precio, stock o promoción que Catalog no respaldaba en ese momento, o una promoción emitida fuera de `F1-COMMERCIAL-POLICY-v3`.
- Una cotización duplicada por reintento: dos emisiones con la misma clave o el mismo `previewId` en la misma conversación.
- Un mensaje a un cliente fuera de la conversación, o un PDF entregado a otra conversación.
- Un dato personal de otro cliente en una respuesta.
- Un turno que promete una acción que no ocurrió («te la emito» sin emisión, «te derivo» sin derivación).
- Una conversación sin respuesta a un mensaje del cliente durante más de 10 minutos en horario de atención, sin derivación.

### 4.2 Métricas con banda: se comparan contra la etapa anterior

Todas salen del reporte M1, segmento `commercial`.

| Métrica | Banda para avanzar | Rollback o pausa si |
|---|---|---|
| Latencia del turno (entrada → respuesta), p50 / p90 | p90 no empeora más de un 25 % contra la etapa anterior | p90 > 2 × la etapa anterior durante 1 hora |
| Llamadas al modelo por turno, p90; turnos con más de 5 llamadas | No crecen más de un 25 % | — (se diagnostica con M2) |
| Decisiones inválidas o `model_failed` por llamada | ≤ 2 % | > 5 % en 1 hora, o cualquier `provider_error` sostenido (≥ 3 turnos seguidos) |
| Costo por conversación y por cotización emitida (US$) | Dentro del presupuesto que fije el owner | Costo por hora > 3 × la mediana horaria de la etapa |
| Derivaciones a humano por conversación | Sin umbral fijo: cada derivación se clasifica (pedido del cliente, límite de capacidad, error) | Derivaciones por error > 5 % de conversaciones |
| Cotizaciones rechazadas por código | Los rechazos `customer_confirmation_not_explicit` y `autonomy_*` se revisan semanalmente | — |
| Mensajes enviados y entregados | ≥ 99 % entregados o leídos | Envíos `failed` > 1 % en 1 hora |
| Tiempo desde el primer mensaje hasta la emisión | Se observa; sin banda en etapa 1 | — |

Las bandas son relativas a propósito: la etapa 0 fija la referencia y cada etapa la actualiza.

## 5. Alertas

CloudWatch y SNS siguen diferidos. Las alertas viven en el observador de solo lectura que ya corre en el host (`r4-f1-observe-v2`). Se agregan estos chequeos, cada uno con aviso al owner:

1. Saldo de OpenRouter bajo el umbral de días de gasto (P2).
2. `provider_error` o `model_failed` en 3 turnos seguidos.
3. Un turno sin respuesta durante más de 10 minutos (ya existe para el PDF; se extiende a los turnos).
4. Una decisión de Quote `unknown` o retenida más de 5 minutos (ya existe).
5. Costo por hora sobre 3 × la mediana.
6. Envíos `failed` sobre el 1 %.
7. El worker del carril no está `online` o no compuso (ya existe).

## 6. Rollback

| Situación | Acción | Tiempo |
|---|---|---|
| Fallo grave en etapa 2 o 3: entrada | `R4_PROD_ROLLOUT_PERCENT` al escalón anterior, o a 0, y reinicio del gateway. Ninguna conversación nueva entra a la cohorte | Minutos |
| Fallo grave en etapa 2 o 3: conversaciones de cohorte ya abiertas | Bajar el porcentaje **no** les quita la autonomía. Siguen en el carril hasta que su tarea termina. Con `R4_PROD_CASE_IDLE_CLOSE_HOURS=24` (#97), una conversación que espera al cliente se cierra tras 24 h sin mensajes y su siguiente mensaje sigue el porcentaje vigente; sin esa variable, la tarea suele no terminar sola. El worker del carril sigue en marcha mientras queden. Corte dirigido: listar los bindings abiertos con `eligibility_reason = 'cohort'` y `tasks cancel` de cada tarea. Cancelar descarta las entradas aún no procesadas (ADR-045, 7.2), así que primero se deja responder al worker del carril. Alternativas: denylist por clave, o el interruptor de autonomía global. Seguimiento recomendado: un comando que retenga o drene los bindings de cohorte con `rollout_fingerprint` anterior (no implementado) | Con el cierre por inactividad, 24 h después del último mensaje de cada conversación (más si el cliente sigue escribiendo); si no, lo que tome el corte dirigido. No minutos |
| Fallo grave atribuible al agente | Interruptor de autonomía (`production:sales:control -- autonomy off`). Las lecturas siguen y las escrituras se rechazan con «definitivamente no enviado» | Segundos |
| Fallo de promociones | `R4_F1_PROMOTIONAL_QUOTES` apagado en el entorno del carril. Antes de apagarlo se revisan las decisiones promocionales retenidas (precondición del PR #79) | Minutos |
| Regresión de código | `rollback.sh 2` con el SHA anterior completo (procedimiento de despliegue por SHA) | ~1 minuto |
| Proveedor caído o sin saldo | Recargar saldo; como alternativa, cambiar `R4_MODEL_*` a otro modelo ya evaluado y reiniciar los workers | Minutos |

## 7. Políticas de seguridad que se mantienen en todas las etapas

- La salida del modelo no es confiable: toda escritura pasa por ejecución gobernada (decisión congelada, idempotencia, reconciliación).
- Quote V2 es la autoridad de la cotización y Catalog V2 la del precio y el stock. R4 no inventa precios.
- No se almacena razonamiento del modelo.
- Identidad, pagos, consentimiento y cambios de precio requieren su propia revisión y quedan fuera de este plan.
- Las claves de conversación se registran como hash; los números no aparecen en registros, commits ni PRs.

## 8. Límites técnicos contra abuso

Estos límites no son comerciales: protegen el costo y la plataforma ante un uso anómalo. Se proponen para la etapa 2 y requieren aprobación:

- **Turnos por conversación:** como máximo 30 por hora. Al superarlo, el agente responde una vez que retomará más tarde y espera.
- **Costo de modelo por conversación por día:** un tope técnico, por ejemplo 20 × la mediana de costo por conversación. Al alcanzarlo, la conversación pasa a una persona.
- **Llamadas al modelo por turno:** el presupuesto vigente de la definición.
- **Cotizaciones:** se mantienen los límites de medición actuales (100 por conversación, 10 000 por hora). El owner fijará un límite comercial cuando M1 muestre cuántas veces cotiza un cliente real.

## 9. Pendientes

1. P1: elegir la opción a o b.
2. P2: alerta de saldo.
3. Chequeos de alerta §5.2 a §5.6.
4. Aprobar los límites §8.
5. Fijar el presupuesto de costo por conversación.

Todos requieren autorización del owner. Ninguno se implementa con este documento.
