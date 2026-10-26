# AnyWeb MCP: viabilidad y diferenciación

Investigación documental del 23 de octubre de 2026. Se consultaron documentación primaria, repositorios y artículos. No se instalaron ni compararon productos en ejecución. Los resultados publicados pertenecen a sus autores y no son mediciones de AnyWeb.

## Conclusión

Convertir tareas web en herramientas MCP es técnicamente plausible, pero capturar tráfico, generar herramientas y reutilizarlas ya existe. No hay evidencia para afirmar que AnyWeb sea novedoso por esa combinación. Tampoco hay evidencia de una técnica que transforme cualquier web completa en una API estable sin restricciones.

La apuesta recomendable es aprender una capacidad a demanda y entregar un programa local verificable, reutilizable y portable. El usuario proporciona una web y un objetivo; el sistema resuelve una primera instancia, extrae un programa parametrizado, lo prueba en casos nuevos y lo expone por MCP. Un marketplace no es necesario. La novedad sería una hipótesis a demostrar, no un atributo asegurado.

## Qué existe

| Proyecto | Evidencia consultada | Consecuencia para AnyWeb |
|---|---|---|
| Unbrowse | Cliente SDK/CLI abierto para servicio alojado; descubrimiento, HAR, compilación, MCP, sesiones y verificación del resultado declarados en docs | Competidor directo. Captura + compilación + validación no bastan como diferenciación. El repositorio consultado no entrega el backend completo |
| Spectral | Captura por extensión/proxy, análisis con LLM, generación MCP, autenticación y reparación declaradas | No reinventar esta propuesta como si fuera nueva; no se encontraron métricas de fiabilidad en el README |
| wiretrace | Inferencia determinista de tráfico, dependencias por coincidencia de valores, exportación OpenAPI/MCP y replay | La capa captura/esquema puede ser infraestructura reutilizable. Su README limita el entorno a macOS |
| Stagehand | Acciones cacheadas, ejecución determinista y reinferencia ante selectores obsoletos | Repetir y reparar acciones de navegador ya tiene soluciones. Ejecutar un clic correctamente no prueba que la tarea completa sea correcta |
| WebMCP | El propietario registra herramientas en JavaScript o formularios; Chrome documenta origin trial | Consumir herramientas nativas donde existan; no resuelve automáticamente webs que no lo implementan |
| WALT | Descubrimiento de funciones, demostración, scripts parametrizados, sustitución de clics por rutas URL, pruebas y recuperación | Es un antecedente directo del enfoque de aprender herramientas desde webs |
| ReUseIt | Flujos aprendidos de éxitos/fallos, comprobaciones y recuperación | La validación y la memoria de fallos importan, pero también están investigadas |

## Qué dicen realmente las mediciones

- Unbrowse: el resumen del preprint informa 94 dominios, un host y cachés calientes; 950 ms frente a 3.404 ms de Playwright, 3,6× de media. No mide una conversión universal, ni el coste completo de descubrir un sitio nuevo.
- ReUseIt: 15 familias de tareas, éxito publicado de 24,2% a 70,1%. La construcción usa 20 ejecuciones exploratorias por familia; estima 15–53 minutos acumulados. No aporta un umbral de amortización económica. Su juez automático tuvo 77,8% de exactitud en una auditoría humana de 45 juicios.
- WALT: genera scripts de navegador y rutas parametrizadas, no demuestra extracción universal de APIs HTTP. Evalúa réplicas de sitios de benchmarks; reconoce costes por sitio, cobertura incompleta y problemas con interfaces dinámicas. El artículo informa éxitos agregados de 52,9% y 50,1%, no universalidad. El texto consultado promete publicar código, pero no incluye un repositorio específico de WALT.
- Webwright, de Microsoft Research: desarrolla programas Playwright desde terminal y reutiliza scripts; publica resultados en tareas web, pero sus métricas no certifican estabilidad de una biblioteca de herramientas tras cambios de los sitios.

Los porcentajes provienen de evaluaciones diferentes y no son comparables entre sí como un ranking.

## Arquitectura propuesta, aún no implementada

1. **Objetivo observable.** Traducir la intención a entradas, resultado y condiciones comprobables. «Última publicación» exige identidad, orden y actualidad; «publicación por ID» no satisface ese contrato.
2. **Exploración instrumental.** Resolver una instancia observando acciones, DOM/accesibilidad y red conjuntamente. La captura es evidencia para explicar qué operación ocurrió.
3. **Síntesis de un programa.** Identificar datos variables, dependencias, sesión y comprobaciones. Elegir HTTP directo cuando se pruebe su equivalencia; usar un programa de navegador cuando el estado de la aplicación sea necesario. El agente no vuelve a planificar cada clic en todas las ejecuciones.
4. **Experimentos acotados.** Cambiar entradas, introducir casos negativos y repetir en sesión nueva. Comparar resultados con una referencia independiente. Para escrituras, usar solo entornos de prueba o acciones expresamente autorizadas; no repetir una operación de resultado incierto.
5. **Entrega portable.** Bundle o paquete con herramientas, programa, versiones, permisos requeridos, pruebas y límites. Las credenciales quedan fuera. Si necesita navegador, declarar esa dependencia; no presentarlo como un bundle HTTP autónomo.
6. **Mantenimiento con control.** Comprobar precondiciones y resultados. Si fallan, invalidar la versión; una reparación propuesta debe superar las mismas pruebas antes de activarse. No cambiar el comportamiento silenciosamente para obtener una respuesta exitosa.

HTTP directo, ejecución dentro del contexto del navegador y acciones UI tienen restricciones diferentes. Estar en un navegador no elimina CORS, CSRF, sesiones caducadas ni comprobaciones del servidor; no es una técnica para saltar controles de acceso.

## Diferenciación que vale la pena probar

Hipótesis: se puede producir localmente una capacidad portable con menos intervención que escribir un conector y menos coste recurrente que un agente navegador, manteniendo un porcentaje bajo de éxitos falsos.

No se afirma que sea una invención exclusiva. El posible valor está en la implementación y sus resultados: aprendizaje sin catálogo obligatorio, entrega sin servicio central obligatorio, comprobaciones explícitas del significado y mantenimiento observable. Un catálogo podría existir después como distribución opcional, pero no sería el motor del producto.

## Experimento decisivo antes de otra reescritura

Implementar una sola capacidad aprendida de extremo a extremo sobre una aplicación controlada con API y UI. No añadir marketplace ni rehacer la interfaz. Medir después un conjunto fijado de antemano de 12 tareas en 4 sitios autorizados: búsqueda/detalle, paginación/orden y lectura autenticada; incluir casos que necesiten UI y variantes controladas que rompan selectores o contratos.

Comparar con las mismas tareas, entradas, modelo y presupuesto:

- Agente navegador sin aprendizaje previo.
- Programa reutilizable de navegador (baseline Stagehand/Playwright).
- AnyWeb con síntesis y comprobaciones.

Reservar al menos cinco entradas nuevas por tarea, sin usarlas en construcción. Fijar resultados esperados mediante fixtures o revisión humana independiente. Repetir para evitar tomar un éxito casual como prueba. Evaluar por separado coste inicial y coste de repetición, intervención humana, éxito de tarea, falsos éxitos, detección de cambios y recuperación.

Criterios propuestos, no resultados: al menos 10 de 12 tareas aprendidas sin código específico manual, al menos 90% de aciertos en casos reservados, cero éxitos falsos en los escenarios de rotura preparados y coste total inferior al baseline tras 20 usos. Registrar también resultados desfavorables y tareas bloqueadas. Superar este experimento justificaría ampliar; fallarlo indicaría qué promesa reducir o qué infraestructura existente adoptar.

Amortización: si L es coste de aprendizaje, B coste por ejecución del baseline y R coste por repetición aprendida, hace falta N > L/(B−R), siempre que B > R. Incluir mantenimiento e intervención humana en L o contabilizarlos por separado. No vender ahorro basándose solo en ejecuciones con caché caliente.

## Encaje con el código actual

Reutilizar CLI, exploración, captura, marcas, recetas, sesiones, revisión y empaquetado MCP. El trabajo faltante principal es síntesis dirigida por objetivo, ejecución de programas dependientes del navegador y verificación independiente del resultado. La corrección de POST/cookies no cubre esas piezas.

La limitación de dos demostraciones no debe convertirse en una teoría del aprendizaje: algunos flujos necesitan más observaciones para separar coincidencias de dependencias reales. El número de pruebas debe depender de la ambigüedad y el riesgo del contrato.

## Fuentes

Actualización de implementación, 24 de octubre de 2026: ya existe un primer recorrido de [aprendizaje de acciones de navegador](browser-workflows.md), con parametrización entre demostraciones, evaluación reservada y entrega MCP local. No implementa todavía la síntesis autónoma desde un objetivo, reparación ni el benchmark de 12 tareas propuesto arriba. Las afirmaciones y métricas de la investigación del 23 de octubre siguen siendo referencias externas.

- Unbrowse repositorio: https://github.com/unbrowse-ai/unbrowse
- Unbrowse documentación: https://unbrowse.ai/docs
- Unbrowse preprint: https://arxiv.org/abs/2604.00694
- Spectral: https://github.com/spectral-mcp/spectral
- wiretrace: https://github.com/navilansanthanakrishnan/wiretrace
- Stagehand, caching: https://github.com/browserbase/stagehand/blob/main/packages/docs/v4/best-practices/caching.mdx
- WebMCP: https://developer.chrome.com/docs/ai/webmcp
- WALT: https://arxiv.org/html/2510.01524v1
- ReUseIt: https://arxiv.org/html/2510.14308v1
- Agent Workflow Memory: https://proceedings.mlr.press/v267/wang25bx.html
- Webwright: https://www.microsoft.com/en-us/research/articles/webwright-a-terminal-is-all-you-need-for-web-agents/
