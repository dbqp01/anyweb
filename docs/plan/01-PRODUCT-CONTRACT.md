# AnyWeb — contrato de producto y seguridad

Estado: dirección acordada con el usuario el 27–28 de octubre de 2026; implementación y validación pendientes. Este documento modifica el alcance exclusivamente hacia el producto general; no certifica funcionamiento ni autorización para operar cuentas.

## Resultado

Producto público instalable que, a partir de un objetivo y una web autorizada, ayuda a descubrir, construir, probar y entregar herramientas MCP específicas, reutilizables y portables. Prioriza sitios autenticados sin MCP estándar, sin acoplar el núcleo a una web: Clementina/UVCV es un caso de validación, no la arquitectura. El agente hace el trabajo; la persona revisa decisiones y resultados, no debe dirigir cada paso técnico. Declarar explícitamente límites y pruebas, sin prometer compatibilidad universal.

## Criterios observables

1. Una instalación limpia desde el artefacto distribuible puede ejecutar la CLI y crear y utilizar un MCP en un cliente independiente, sin depender del checkout original. Documentar prerrequisitos y distinguir runtime HTTP y de navegador.
2. Manejo local de sesiones, autenticación manual y diagnóstico de expiración, sin incluir secretos en bundles, logs, parámetros MCP o reportes públicos; describir honestamente cualquier persistencia y riesgo de plataforma.
3. Sitio de laboratorio con login y datos de prueba: desde el objetivo hasta un MCP con una lectura y una escritura autorizada, incluyendo denegación, errores y verificación independiente del estado posterior; no usar credenciales reales.
4. Caso real UVCV: usar únicamente lecturas autorizadas de la sesión existente; comparar resultado del MCP genérico con fuente independiente y registrar evidencia sin información sensible. Si no es viable, informar bloqueo y causa, no simular el éxito. No entregar tareas, modificar cuentas, enviar mensajes ni iniciar quizzes como pruebas.
5. La autorización para una escritura real identifica operación, destino, argumentos y efectos; requiere aprobación humana explícita fuera del control del agente y es limitada a la operación acordada. Una aprobación del propio agente o un nonce visible al agente no es aprobación humana. Operaciones de efecto desconocido fallan de forma segura. No reintentar automáticamente cuando el resultado sea incierto. El diseño debe contemplar que un GET o una navegación también pueda causar efectos y que algunas consultas legítimas usan POST; no inferir seguridad únicamente del verbo HTTP.
6. Entrenamiento/evaluación separados; verificar semántica y reportar alcance, fecha, límites y fallos. Éxito HTTP o coincidencia con un ejemplo no demuestra corrección general. El benchmark registra baseline independiente, costes, falsos éxitos y casos no soportados; no inventar cifras ni evidencia.
7. Tests de regresión, pruebas adversariales, documentación de instalación, operación y amenaza; CI y empaquetado con verificación de instalación aislada. Publicación en el repositorio existente y npm solo cuando las comprobaciones pasen y exista acceso; no incluir datos o credenciales privadas.

## Límites y resolución de conflictos

La regla histórica GET-only del plan anterior ya no define la visión completa: el usuario pidió también escrituras reales con revisión humana. Mientras no exista un mecanismo de aprobación humana verificable y pruebas negativas suficientes, ninguna escritura real debe quedar habilitada o presentarse como segura. Se pueden ejercitar escrituras solamente contra un laboratorio controlado. Las pruebas reales en Clementina serán de lectura. El usuario autorizó la publicación posterior en el repositorio existente y npm, así como el desarrollo de la confirmación de escritura; eso no autoriza una escritura concreta en su cuenta. Publicar solo después de auditar contenido, historial y prerrequisitos técnicos. La cuenta npm se comprobó autenticada como `akimibks`.

## Criterio de incorporación pública (28 de octubre de 2026)

Una persona debe poder entregar el repositorio público a un agente de IA y pedirle que lo instale y utilice. El repositorio debe contener instrucciones para agentes y una skill con pasos verificables; la instalación debe resolver las dependencias necesarias de forma automática o, cuando falten privilegios o autorización, detenerse indicando el motivo exacto. Debe existir una CLI operativa, generación de MCP y documentación para conectar el MCP generado a clientes compatibles. Comprobar el flujo en un entorno limpio mediante instalación real, un cliente MCP independiente y un laboratorio autenticado; validar aparte una operación real autorizada en UVCV sin publicar datos sensibles. Los prerrequisitos fuera de control del proyecto (red, sistema compatible, permisos, acceso a la cuenta, autorización humana) se documentan explícitamente. No afirmar soporte universal de todas las webs, plataformas o clientes sin evidencia.

## Orden inicial

1. Reducir exposición de secretos y corregir rutas inseguras con tests de regresión.
2. Hacer el paquete instalable y portable, manteniendo los motores explícitos.
3. Diseñar y comprobar una frontera de autorización para acciones con efecto; no reutilizar la confirmación controlable por el mismo agente como control humano.
4. Integrar laboratorio autenticado, contratos de resultado, caso real de lectura y benchmark; documentar qué es y no es portable.
5. Ejecutar revisión adversarial y gates de release antes de publicar.

Los resultados concretos de cada fase se registrarán con comandos y salidas reales; el contrato es una meta, no una afirmación de que ya esté cumplido.
