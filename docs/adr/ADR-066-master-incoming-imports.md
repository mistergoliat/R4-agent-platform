# ADR-066 — Master: Pesín consulta si un producto sin stock viene en camino

- **Identificador:** `R4-MASTER-INCOMING-01`
- **Estado:** **Propuesto.** No autoriza código ni despliegues. Cada fase necesita autorización explícita del owner.
- **Fecha:** 2026-11-25
- **Mandato:** owner, 2026-11-25.
  - Compartió la documentación de la API de Master, el ERP interno: `GET /api/preventas/importaciones`.
  - Definió el alcance: «las estrategias de precios, costos y todo lo demás no está publicado todavía. Podría ser que
    Pesín por ahora pueda revisar si ese producto va a llegar».
- **Autoridad superior:**
  - Constitución: la salida del modelo no es confiable; los conceptos de dominio quedan fuera de Core; no se agrega
    infraestructura sin necesidad demostrada;
  - ADR-030 (frescura de capacidades acotada por el dueño);
  - ADR-055 (contacto con clientes: el propósito `promesa`);
  - ADR-061 (conectores: Master es un conector de lectura).

## Contexto

**Qué da Master.**
- La API devuelve la mercadería de importación que todavía no se recibe, con una fila por operación y SKU.
- Cada fila trae:
  - el estado de la operación;
  - la cantidad abierta;
  - una ETA, con su tipo: `real` (registrada en la operación), `calculado_etd` o `calculado_pago` (estimada con el
    historial del proveedor), o `sin_dato`.
- Trae todo en cada llamada, sin filtros. Se autentica con un token Bearer que actúa con los permisos de su usuario.
- La cantidad no descuenta lo ya vendido en preventa (lo dice la documentación de Master).

**Hoy, ante un producto sin stock, Pesín solo puede decir que no hay.** No sabe si viene en camino.

**El SKU de Master coincide con el de la tienda.** Verificado el 2026-11-25 con una lectura en la base de la tienda:
- el SKU de ejemplo `FF1105R` es la referencia del producto activo 867;
- los 1.049 productos activos y sus 398 combinaciones tienen referencia;
- el catálogo de R4 ya entrega el `sku` de cada producto y de cada variante.

**Fuera de alcance por ahora, a pedido del owner:** la preventa, los precios y los costos.

## Decisión 1 — Qué hace Pesín

- Una lectura nueva del paquete de Ventas, `catalog.incoming`. Recibe los SKU de productos que Pesín ya leyó en el
  catálogo y responde, por cada SKU, si viene en camino y cuándo.
- Pesín la usa cuando un producto está sin stock, o cuando el cliente pregunta cuándo llega algo.
- **Pesín nunca:**
  - dice cantidades;
  - ofrece preventa, reserva o aparta unidades;
  - promete una fecha de despacho.

## Decisión 2 — Cómo dice la fecha (owner, 2026-11-25: «graduada»)

La lectura entrega la fecha ya convertida en la frase que corresponde; Pesín no interpreta la ETA.

| ETA de Master | Qué entrega la lectura | Ejemplo |
|---|---|---|
| `real`, futura | La fecha | «llega a bodega aproximadamente el 10-12-2026» |
| `calculado_etd` o `calculado_pago`, futura | Solo la quincena | «se espera para la segunda quincena de diciembre» |
| `sin_dato`, o una ETA ya pasada sin que la operación se reciba | Sin fecha | «viene en camino, sin fecha confirmada» |

- Siempre aclara que es la llegada a bodega: el despacho se suma después.
- Si el mismo SKU viene en varias operaciones, vale la que llega primero. Una fecha real gana sobre una calculada.

## Decisión 3 — Qué cuenta como «viene en camino» (owner, 2026-11-25)

- Solo las operaciones `En Origen` y `En Camino`, comparadas sin distinguir mayúsculas.
- `En Bodega - Ingresado` e `ingresado a sap` ya llegaron: el stock aparece pronto en la tienda y Pesín no las
  menciona.
- Un estado desconocido no cuenta: se registra para revisarlo y Pesín no lo menciona.

## Decisión 4 — Dónde vive cada cosa

| Pieza | Dónde | Por qué |
|---|---|---|
| Cliente HTTP de Master y su esquema | Adaptador de dominio `adapters/domains/master` | Importaciones y preventa son conceptos de dominio: nunca en Core |
| La lectura `catalog.incoming` y sus frases | Paquete de Ventas | Las reglas de la Decisión 2 son de Ventas |
| La copia de la oferta | En memoria de cada worker, renovada cada 30 minutos | La documentación de Master recomienda 15 a 60 minutos. Son 2 o 3 workers, es decir, unas 6 llamadas por hora. Sin tabla ni proceso nuevo |
| El token | Baúl de la consola (`~/.config/r4/secrets/connectors/master.env`, clave `R4_MASTER_API_TOKEN`), con la tarjeta Master de Conectores | Como ClickUp: nunca en el repositorio, en los logs ni en el chat |

- **Si Master no responde,** la copia anterior sirve por hasta 2 horas. Pasado ese tiempo, la lectura dice «no
  disponible» y Pesín no menciona llegadas.
- **La frescura** sigue el ADR-030: cada respuesta lleva la hora de la copia.

## Decisión 5 — El acceso (owner, 2026-11-25: «mi token por ahora»)

- Se parte con el token personal del owner. Mientras sea así, R4 actúa con los permisos del owner, y el token deja de
  servir si se revoca o vence.
- R4 solo llama a esta ruta de lectura.
- **Queda abierto:** reemplazarlo por un usuario de servicio «R4», que solo lea este endpoint, creado por el equipo de
  Master.

## Fases (cada una requiere autorización del owner)

| Fase | Contenido |
|---|---|
| M0 | Este ADR |
| M1 | Adaptador, lectura y evaluación con datos ficticios. Sin perfil de producción nuevo |
| M2 | Un perfil nuevo del carril con la lectura y su instrucción. Prueba L3 con el token del owner y activación |
| M3 | (Más adelante) Aviso cuando llegue: el propósito `promesa` del ADR-055, si el owner lo autoriza |

## Evaluación

Se entrega con el código:
- las frases de la Decisión 2 por tipo de ETA, incluida la ETA ya pasada;
- el filtro de estados, incluido un estado desconocido;
- un SKU que viene en varias operaciones;
- Master caído: primero la copia anterior; pasadas 2 horas, «no disponible»;
- casos de conversación: producto sin stock que viene en camino; producto sin stock que no viene; cliente que pide la
  cantidad o una preventa y Pesín no la da.

## Decisiones abiertas

1. El usuario de servicio de Master para R4 (Decisión 5).
2. Pedirle a Master un código fijo de estado, además del texto libre.
3. Cuando se publiquen la preventa y los precios, una revisión de este ADR. Antes de ofrecer preventa, Master debe
   entregar la cantidad disponible descontando lo ya vendido.

## Fuera de alcance

- Preventa, reservas, cantidades, precios y costos.
- Escribir en Master.
- Avisos de llegada (fase M3).
