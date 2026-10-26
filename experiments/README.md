# Experimento mínimo: aprender una consulta de producto

## Resultado observado

Operación: obtener ficha por nombre exacto. Dos demostraciones de navegador (Laptop Pro, Laptop Air), compilación con el motor existente y tres consultas reservadas (Phone Max, Tablet Mini, Camera Lite), repetidas cinco veces.

| Medida | Receta aprendida | Agente navegador |
|---|---:|---:|
| Respuestas correctas | 15/15 | 3/3 |
| Casos distintos | 3 | 3 |
| Preparación y compilación | 1.099 ms | No comparable |
| Latencia media por consulta | 51,22 ms | No medida |
| Latencia mediana | 48,43 ms | No medida |
| Operaciones | 2 peticiones HTTP por consulta | 23 operaciones de herramientas en total |
| Coste monetario | No medido | No medido |

Los puntos de miles y las comas decimales de la tabla usan formato español. Mediciones originales en JSON: [comparison.json](results/comparison.json).

La preparación incluye abrir Chromium, ejecutar las dos demostraciones y compilar; excluye el arranque del servidor, desarrollo, escritura de las demostraciones y razonamiento del agente. Las llamadas medidas son al runner HTTP; no incluyen empaquetado ni transporte MCP.

## Verificación independiente

`oracle.mjs` contiene resultados esperados fijos. El compilador no recibe el oracle ni las respuestas de detalle de evaluación. El verificador compara todos los campos, incluidos precio e identificador, sin usar el estado `passed` del motor como evidencia.

- Producto inexistente: el motor rechaza con `NO_MATCH`.
- Corrupción consistente: un interceptor de prueba suma 100 al precio en catálogo y detalle. El motor devuelve éxito con precio 900 para Phone Max; el oracle exige 800 y lo rechaza. Es un falso éxito del motor detectado por el verificador externo.
- Esto simula corrupción en una fixture inmutable. En una web real un precio nuevo puede ser legítimo: el oracle fijo no es una solución de producción.

## Comparación navegador

Un subagente aislado fue lanzado con instrucciones de usar solo la interfaz, pero falló por cuota antes de navegar. El agente principal completó las tres consultas con las herramientas Claude Browser: abrir inicio, leer controles, escribir nombre, buscar, elegir enlace y leer ficha. Las respuestas se guardaron en `browser-agent.json` desde lo observado, incluido el id en la URL.

No es una comparación ciega: el agente principal conocía la fixture y el oracle. No hay medición fiable de latencia, tokens o dinero del agente, por lo que no se calcula speedup ni amortización. Los conteos son operaciones individuales dentro de lotes, no cantidad de lotes: 9 para Phone Max (incluye apertura y un clic fallido por panel oculto), 7 para Tablet Mini y 7 para Camera Lite. La apertura del panel del host queda fuera.

## Reproducir

Desde la raíz, iniciar la configuración de preview `anyweb-experiment` en `.claude/launch.json`; sirve la fixture en el puerto 4331. Después:

```bash
node experiments/learn-operation.mjs
```

```bash
node experiments/verify.mjs
```

El primer comando regenera mediciones y receta. El segundo verifica las mediciones y la captura histórica del agente, y escribe la comparación. **No vuelve a ejecutar un agente LLM**: para repetir esa parte, un agente debe realizar de nuevo las tres consultas por UI y registrar sus observaciones. No instalar dependencias adicionales; usa Playwright ya presente.

## Límites e interpretación

- Una única fixture controlada, sin sesión ni paginación; no demuestra transferencia a webs reales.
- Las demostraciones están programadas por el desarrollador. Se aprende el enlace entre nombre, búsqueda e identificador HTTP; no se aprende autónomamente a navegar.
- El catálogo completo aparece durante entrenamiento, así que los nombres reservados no son entidades completamente inéditas; sus consultas de detalle sí están reservadas.
- Tres casos con cinco repeticiones no equivalen a quince tareas distintas.
- No hay comparación temporal válida entre HTTP y agente, ni una evaluación de reparaciones.
- El resultado acredita inferencia y repetición en este caso, y descubre un límite semántico concreto. No acredita todavía la propuesta «dar una web y aprender una capacidad sin intervención técnica».

Archivos: `fixture.mjs` reutiliza el servidor de tests; `learn-operation.mjs` reutiliza grabador, compilador y runner; `oracle.mjs` y `verify.mjs` puntúan independientemente. No se modifica el motor para hacer pasar el experimento.
