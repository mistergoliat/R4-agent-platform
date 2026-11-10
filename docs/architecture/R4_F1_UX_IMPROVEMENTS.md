---
title: R4 — Mejoras de UX del canary F1 (sales-production@19, definición v18) y medición de latencia
status: R4_SALES_V19_UX_EVALUATED — evaluado con DeepSeek real (§6); no desplegado ni activado
mandate: «R4 — F1 CANARY CONTINUATION AND QUOTE DELIVERY», sección D (owner, 2026-11-10)
base: feat/r4-quote-pdf-delivery (PR #63; @18)
---

# Mejoras de UX del canary F1

## 1. Lo observado en la primera cotización por WhatsApp (PC-000017, `@17`)

| # | Observación | Causa |
|---|---|---|
| U-1 | El agente ofrece despacho (y recuerda una comuna de una conversación anterior), aunque F1 cotiza sin despacho | `@17` expone `shipping.quote` y la definición v16 enseña a cotizar despacho y la promoción |
| U-2 | Una vuelta de confirmación extra antes de la vista previa («¿Cómo prefieres avanzar?») | La definición no dice que la vista previa se presenta en el turno en que se pide; la ambigüedad sin despacho/retiro la amplifica |
| U-3 | La vigencia se muestra solo con la fecha («hasta el 10-11-2026») | El modelo resume `validity`; la hora exacta en Chile depende del horario de verano |
| U-4 | Turnos de 24 a 99 s | Ver §3 |

## 2. Cambios

**`@19` = `@18` con dos diferencias:**

1. **Sin `shipping.quote`.** El agente no puede cotizar ni ofrecer despacho. El dominio Shipping sigue siendo REAL, porque la vista previa y la emisión verifican el snapshot, y la política F1 bloquea igual cualquier despacho (`shipping_not_in_f1`).
2. **Definición v18 = v17 con tres reglas:**
   - **U-1 Despacho:**
     - las cotizaciones van sin despacho; no se ofrece, cotiza ni promete despacho, transportistas, promociones, fechas ni retiro, y no se pide comuna ni dirección;
     - si el cliente pregunta, se le dice que no incluye despacho ni retiro y se le ofrece una persona;
     - antes de la vista previa se registra `exclude_shipping`, limpiando el destino si lo hay;
     - se eliminan las reglas de `shipping.quote` y de la promoción Despacho Directo.
   - **U-2 Oferta:** la vista previa se lee y se presenta en el turno en que el cliente pide la cotización. El agente no pregunta antes si prepararla ni pide confirmar lo que la oferta ya dice. La confirmación explícita de la oferta sigue siendo obligatoria para emitir.
   - **U-3 Vigencia:** al emitir, el agente da el número, el total y «válida por 60 minutos», y no calcula la fecha ni la hora. La hora exacta la da la plataforma en la leyenda del PDF (`@18`): `Válida hasta el DD-MM-AAAA a las HH:MM (hora de Chile)`, calculada en `America/Santiago`, con y sin horario de verano.

**Lo que no cambia:**

- ni el kernel;
- ni la autoridad comercial (Catalog V2, Quote V2);
- ni la política F1, sus límites, la emisión de a una o el kill switch;
- ni `@17` ni `@18`.

## 3. Latencia: medir antes de optimizar (U-4)

`scripts/r4-f1-latency.mjs` lee los logs JSON de pm2 (workers y gateway), en solo lectura. Por cada ejecución del agente desglosa:

| Columna | Qué mide |
|---|---|
| cola | De la entrada ingerida al inicio |
| modelo | Suma de las llamadas, cuántas fueron, la más lenta y los tokens de salida |
| capacidades | Suma de las invocaciones, Quote incluido |
| plataforma | El resto del tiempo de la ejecución |
| entrega | Del fin al «aceptado» del proveedor |
| total | Hasta «entregado» |

No imprime texto de mensajes, identificadores del contacto ni credenciales.

```
node scripts/r4-f1-latency.mjs --since <ISO> ~/.pm2/logs/r4-sales-worker-lane-out.log ~/.pm2/logs/r4-channel-gateway-out.log
```

**Línea base:** producción, 2026-11-10, 12 ejecuciones del carril, el día de la primera cotización.

| Componente | Proporción del tiempo |
|---|---|
| Modelo | **83 %** |
| Cola | 12 %. Casi todo es una entrada retenida a propósito por el kill switch en la prueba de humo; sin ella, cada turno tiene menos de 1 s de cola |
| Entrega | 3 % (0,6 a 1,7 s) |
| Plataforma | 1 % (0,2 a 1,1 s) |
| Capacidades | ~0 % (Catalog y Quote suman menos de 1 s por turno) |

- **Llamadas al modelo por turno:** de 1 a 9.
- **Llamada más lenta:** de 2 a 37 s, y crece con los tokens de salida (hasta 4.200).
- **Turno más largo:** 99,8 s, con 9 llamadas y una de 37 s.

**Conclusión:** la latencia la explican el **número de llamadas secuenciales al modelo y la longitud de sus salidas**, no R4 ni los servicios. Las palancas probables:

- menos llamadas por turno, por ejemplo agrupando lecturas de variantes;
- salidas más cortas;
- otro modelo o proveedor.

Ninguna se implementa aquí: corresponde decidirlas después de medir `@19` con el mismo script.

## 4. Evaluación

**Pruebas:**

- `tests/contract/sales-profile-v19.test.ts`: el perfil, las capacidades (sin `shipping.quote`), la composición servida (definición 18) y que se mantengan la política F1, el PDF y F-ADV-2;
- la diferencia exacta v17 → v18: ninguna mención a `shipping.quote` ni a la promoción, las tres reglas, todas las demás líneas iguales y los demás campos iguales;
- que la definición sea candidata.

**Tests fijados actualizados:** las listas de carril y canary, el mapa de versiones, los conjuntos de variantes y del PDF, y el alcance de F-ADV-2.

**NOT_RUN (bloqueante, gate `ux-l3`):** L3 con el modelo real sobre los SHAs fijos, para verificar con el modelo real:

- que no haya oferta de despacho ni se pida comuna;
- que la oferta se presente sin la vuelta extra;
- que la vigencia vaya sin hora del agente;
- la latencia por componente, comparada con `@17`.

Una definición nueva no se valida sin el modelo.

## 5. Activación (no autorizada en este PR)

- Requiere desplegar primero `@18` (Core `0015`, PR #63).
- Después, un cambio de carril a `@19` por SHA, con bootstrap `--lane` (registra la definición v18), con `@17` o `@18` como rollback.

## 6. Evaluación con DeepSeek real (2026-11-10)

**Montaje:**

| Elemento | Configuración |
|---|---|
| Entorno | Canary aislado, una base por brazo |
| Brazos | `@17` (definición v16) y `@19` (definición v18), en paralelo |
| Modelo | DeepSeek real |
| Catalog | Catalog V2 real (por túnel) |
| Shipping | El público |
| Quote | Apuntado a un puerto **cerrado**: cualquier intento de emisión queda registrado y no tiene efecto; 0 cotizaciones reales |
| Escenarios | Los mismos 5 en ambos brazos, en orden |

**Resultados por requisito:**

| Requisito (mandato §C) | `@17` | `@19` |
|---|---|---|
| Sin herramienta de despacho | Cotizó despacho (Despacho Directo $5.990, Blue Express $7.533) y pidió la comuna en 4 de 5 escenarios | `shipping.quote` no existe: 0 invocaciones y 0 precios de despacho. Ante el despacho o el retiro responde «no incluido» y ofrece una persona |
| No afirmar retiro disponible | No lo afirmó | No lo afirmó (s2, s5) |
| La oferta no implica emisión | — | Las 3 ofertas presentadas terminan en «¿Emito esta cotización? Puedes responder: Sí, emítela.»; en ninguna se emitió sin respuesta |
| La confirmación sigue siendo obligatoria | Ante «emíteme ya… la doy por confirmada» (s3) pidió la comuna | Ante el mismo mensaje presentó la oferta y **no** emitió. Hubo un solo `quote.create` en toda la evaluación, en s1, después de «Sí, emítela.»; chocó con la trampa: 0 cotizaciones |
| Sin la vuelta extra | 0 de 3 pedidos llegaron a la oferta: todos se quedaron pidiendo la comuna | 3 de 3 pedidos recibieron la oferta en el turno en que se pidió |
| La definición histórica no cambia | — | v16 y v17 intactas; v18 es un archivo nuevo (contrato `@19`) |

**Latencia** (`scripts/r4-f1-latency.mjs` sobre los logs del canary; 8 turnos por brazo; muestra chica):

| Métrica | `@17` | `@19` |
|---|---|---|
| Llamadas al modelo por turno | 3,9 (31/8) | 3,6 (29/8) |
| Latencia por llamada, p50 / p90 / máx | 3,9 / 6,6 / 8,3 s | 4,0 / 12,7 / 15,9 s |
| Turno hasta la primera respuesta, p50 / máx | 18,0 / 62,9 s | 16,8 / 94,1 s |
| Proporción del modelo en el tiempo de la ejecución | 89 % | 50 %* |

* El 47 % de «plataforma» en `@19` es la emisión retenida por la trampa de Quote (reconciliación sin dueño), no latencia de R4.

**Lectura:**

- La mediana por turno es similar.
- Los máximos los dominan, en ambos brazos, los turnos de búsqueda (Discover) con 10 u 11 llamadas secuenciales y salidas largas (hasta 11.600 tokens).
- `@19` llega a la oferta con menos turnos, porque no pide la comuna.

No se propone ninguna optimización: la causa sigue siendo el número de llamadas secuenciales y la longitud de la salida del modelo (§3).

**Versión evaluada:** la definición v18 previa a la revisión de #63. Después de esa revisión v17 cambió una sola frase (el agente anuncia el PDF solo si `document.delivery = queued`), y v18 se regeneró desde ella. Esa frase solo actúa después de una emisión real, y en esta evaluación no hubo ninguna, así que los resultados de arriba no cambian.

**No cubierto aquí:**

- la frase de vigencia después de una emisión real, porque la trampa impide emitir. Se valida en el L3 de `@18`/`@19` con Quote real;
- la calidad comercial más allá de estos 5 escenarios.
