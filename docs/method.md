# Método de integración de AnyWeb MCP

## Producto y criterio de éxito

AnyWeb MCP es un taller local para construir integraciones curadas. El entregable es una operación útil, reproducible y comprobada desde un cliente MCP, con alcance y autenticación explícitos. Una respuesta HTTP 200 o un bundle que arranca no demuestran que la operación haga lo que el usuario necesita.

Primera versión: lecturas y descargas para uso personal/local. Hay recetas HTTP y un modo explícito de [flujos de navegador aprendidos](browser-workflows.md) para lecturas acotadas. No existe todavía un importador general de OpenAPI ni un planificador autónomo.

## Elegir una vía por servicio

1. Buscar una API documentada y comprobar autenticación, permisos, coste y operaciones disponibles. Usarla mediante un conector específico cuando el compilador actual no represente su contrato.
2. Si no existe una API adecuada, observar operaciones permitidas con el navegador y comprobar si se reproducen por HTTP. Usar el compilador solo cuando entradas, dependencias y resultados encajen en sus capacidades.
3. Si el servicio depende de WebSocket, estado del dispositivo o protocolos especiales, evaluar un conector específico, fuera del motor.
4. Si requiere interacción visual, evaluar el modo `execution: browser`: acciones reproducibles, extracción DOM, peticiones GET revisadas y comparación de entrenamiento/evaluación. Si requiere protocolos o efectos fuera de sus límites, registrar el caso como no soportado. Nunca cambiar de HTTP a navegador silenciosamente.

La elección se hace por operación, no solo por nombre de sitio. No relajar controles genéricos para que una demo particular pase. Un parámetro llamado `token` no demuestra por sí mismo que sea una credencial ni que sea público: su tratamiento requiere evidencia del protocolo.

## Procedimiento curado

### 1. Definir la operación

Escribir qué necesita el usuario, entradas, resultado esperado, cardinalidad (uno, varios o todos), efectos, destinos y contexto de acceso. Ejemplo: «dado el nombre exacto de un producto, devolver su ficha; si hay dos coincidencias, fallar como ambiguo».

No confundir «consultar un post por ID» con «obtener el último post de una cuenta»: la segunda operación necesita resolver identidad, orden y actualidad. No declarar completitud sin cubrir paginación.

### 2. Preparar la declaración

Crear un JSON con origen, nombre, orígenes adicionales y herramientas; importar con `node src/cli.mjs init --file <archivo>`. El esquema existente valida la declaración y el comando rechaza sobrescribir trabajo previo. `examples/product-lookup.json` es una declaración ilustrativa, no una integración certificada.

### 3. Observar y demostrar

Iniciar `explore`; iniciar sesión manualmente cuando corresponda. Registrar dos demostraciones `train` distintas y una `eval` con un caso adicional. Conservar el daemon hasta completar `propose`, pues las marcas viven en memoria. Revisar los destinos observados antes de autorizarlos.

### 4. Compilar y comprobar

Inferir la receta únicamente con las demostraciones de entrenamiento. Reproducir entrenamiento y evaluación; comprobar contenido y significado, no solo tipo o código HTTP. El caso de evaluación no debe determinar los parámetros inferidos. Añadir pruebas negativas para entradas ausentes, resultados vacíos/ambiguos y sesión caducada según la operación.

### 5. Revisar y entregar

`review` ejecuta tráfico real. Revisar un caso representativo, confirmar efectos y aprobar explícitamente. `package` genera bundle, configuración MCP y evidencia. Probar listado e invocación desde un cliente MCP; comprobar que las credenciales permanecen fuera del bundle y que el resultado satisface la operación inicial.

### 6. Mantener

Registrar fecha de última prueba, casos cubiertos, límites y señal de rotura. Si cambia el sitio o la sesión, marcar la integración como pendiente de revalidación. Un resultado histórico nunca se presenta como prueba actual.

## Skills y MCP: responsabilidades

- Una **skill** guía al agente por este procedimiento, exige evidencia y decide cuándo parar. No sustituye validaciones del código.
- Un **MCP de navegador** ayuda a inspeccionar y demostrar. El grabador de AnyWeb debe capturar las demostraciones utilizadas para compilar; una captura externa no aparece automáticamente en sus marcas.
- El **servidor MCP generado** expone operaciones acotadas. No debe aceptar URLs arbitrarias, métodos HTTP libres ni credenciales como argumentos de conversación.
- La **documentación oficial del servicio** define la autenticación y el contrato disponible. Los repositorios y ejemplos externos sirven como pistas que se verifican, no como prueba de compatibilidad.

## Evidencia mínima por integración

Registrar operación, vía elegida y fuente, destinos autorizados, credenciales necesarias (sin valores), entradas de prueba no sensibles, resultado esperado/obtenido, fecha, limitaciones y cómo repetir la validación. Estados útiles en el informe: explorada, demo reproducida, validada localmente, validada contra el servicio, bloqueada. Estos estados son un método de reporte; no constituyen un registro automático implementado.

## Alcance de la distribución

Se conserva stdio local porque las sesiones y archivos pertenecen al equipo del usuario. Publicar un servicio remoto exige diseñar aislamiento por usuario, autenticación y almacenamiento de secretos; no es un simple cambio de transporte.

Los criterios de publicación de conectores de Anthropic recomiendan operaciones específicas, descripciones exactas, validación y pruebas por herramienta. La aceptación en su directorio tiene requisitos adicionales; un MCP local que funciona no obtiene esa aceptación automáticamente.

Referencia: https://claude.com/docs/connectors/building/review-criteria
