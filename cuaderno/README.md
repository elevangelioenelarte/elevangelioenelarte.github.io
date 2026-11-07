# Cuaderno

App web instalable (PWA) para iPad: cuaderno con Apple Pencil, carpetas y subcarpetas, conversión de manuscrito a texto con Claude, sesiones en vivo con grabación, transcripción y secretario con IA, y agenda con tus calendarios.

Se sirve en `https://<tu-dominio>/cuaderno/` desde este repositorio de GitHub Pages. No necesita servidor: todos los datos viven en el iPad (IndexedDB) y solo salen hacia la API de Anthropic cuando pides algo a Claude.

## Instalar en el iPad

1. Abre `https://<tu-dominio>/cuaderno/` en Safari.
2. Toca **Compartir → Añadir a pantalla de inicio**. Se instala como app a pantalla completa.
3. Abre la app, entra en **Ajustes** y pega tu clave de API de Anthropic (console.anthropic.com). Se guarda solo en el dispositivo.
4. Para la transcripción en vivo activa el dictado: Ajustes del iPad → General → Teclado → **Activar dictado**.

## Qué hace

- **Cuaderno**: páginas con aspecto de papel (rayado, cuadrícula, puntos o liso), pluma con presión, subrayador, goma, deshacer/rehacer. Con “Solo Apple Pencil” el dedo desplaza y el lápiz escribe.
- **Convertir a texto**: lee la tinta de la página con Claude y te deja insertar el texto (conservando o limpiando la tinta). Con la herramienta de texto también funciona *Garabatear* del propio iPad.
- **Carpetas y subcarpetas** sin límite, mover notas, fijar, buscar en todo (incluidas transcripciones).
- **Sesión en vivo**: graba el audio (m4a), transcribe en directo con el dictado del sistema y el secretario (Claude) redacta resumen, acta, puntos clave, acciones, decisiones, pendientes o un correo de seguimiento. Resumen automático cada N minutos y preguntas libres sobre lo hablado. Al terminar se guarda todo como nota de la carpeta elegida.
- **Agenda**: importa archivos `.ics` (iCloud, Outlook, Google), suscripción por URL cuando el proveedor lo permite, o Google Calendar en directo con tu propio ID de cliente OAuth. Cada reunión tiene sus apuntes y su sesión en vivo vinculados y aparece en **Hoy**.
- **Copia de seguridad**: exporta e importa todo en un archivo JSON desde Ajustes.

## Google Calendar (opcional)

1. En Google Cloud Console crea un proyecto, activa la *Google Calendar API* y crea un **ID de cliente OAuth** de tipo *Aplicación web*.
2. Añade `https://<tu-dominio>` como origen JavaScript autorizado.
3. Pega el ID de cliente en Ajustes y pulsa **Google Calendar** en la Agenda.

## Archivos

- `index.html`, `app.css`: interfaz.
- `app.js`: controlador (vistas, carpetas, notas, sesión en vivo, agenda).
- `ink.js`: motor de tinta (trazos vectoriales con presión, goma, exportación a PNG).
- `claude.js`: cliente de la API de Claude (streaming, manuscrito a texto, secretario).
- `live.js`: grabación de audio y reconocimiento de voz.
- `calendar.js`: lector de `.ics` con recurrencias y conexión a Google Calendar.
- `db.js`: IndexedDB y ajustes.
- `sw.js`, `manifest.webmanifest`, `icons/`: instalación y modo sin conexión.
