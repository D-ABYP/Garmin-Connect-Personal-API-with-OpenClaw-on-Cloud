# Garmin Connect Personal API MCP

Servidor MCP stdio para OpenClaw. Usa Garmin Connect Personal API y expone solamente cuatro tools de lectura.

## 1. Estructura actual

```
src/
  index.ts                  Entrada stdio; registra solo tools Personal API
  personal/
    personal-api.ts         API Key, Obtain Token, Bearer, retries y errores
    http-transport.ts       Transporte Axios inyectable
    redaction.ts            Redaccion de secretos
    cache.ts                Cache JSON por fecha y endpoint
    normalize.ts            DTOs allowlist; elimina ubicacion y campos no publicos
    data-service.ts         Cuatro contextos de datos
    recovery.ts             Baselines y estado de sincronizacion
    training.ts             Agregados semanales
    activity.ts             Detalle de actividad sin GPS
    *.test.ts               Tests offline con fixtures
  tools/
    personal.tools.ts       Cuatro tools read-only
    personal.tools.test.ts  Contrato y protocolo MCP en memoria
  client/                   LEGACY: referencia, no usado por la nueva entrada
  constants/                LEGACY: referencia
  dtos/                     LEGACY: referencia
coach/
  SKILL.md                  Workflows del coach y confirmacion de planes
  *.example.yaml            Ejemplos ficticios
  templates/                Reportes morning/evening
scripts/
  notify_email.py           SMTP stdlib, --test y reportes deduplicados
tests/
  test_*.py                 Tests Python sin SMTP real
```

## 2. Reglas obligatorias

- No usar email, password, SSO ni OAuth consumer de terceros.
- Leer API Key solo de `~/.config/garmin/api_key` o `GARMIN_API_KEY_FILE`.
- No aceptar la Key directamente como variable de entorno o argumento CLI.
- No registrar tools de escritura ni llamar endpoints create/update/delete/download.
- No devolver latitud, longitud, polyline, GPS, FIT ni ZIP.
- Normalizar antes de escribir en cache o devolver datos.
- No inventar datos: missing/error es `null` mas una entrada en `issues`.
- MCP no genera recomendaciones; Claw interpreta los datos.
- Consultar el Swagger oficial antes de agregar cualquier endpoint o campo.
- Mantener el codigo legacy solo como referencia, nunca importarlo desde la nueva entrada.

## 3. Autenticacion y red

- Obtain Token: `POST /personalapitoken-service/personal-api/personal-api-key/token` con `Authorization: ApiKey`.
- Host: `https://personal.connectapi.garmin.com`.
- Bearer JWT con `exp`; refresh una hora antes y una sola renovacion tras 401.
- Maximo tres intentos para timeout, red, 429 y 5xx; `Retry-After` y backoff limitado.
- El unico POST permitido es Obtain Token; datos solamente con GET.
- Logs por stderr, sin Authorization, response bodies, Key, token ni passwords.

## 4. Herramientas MCP

- `get_recovery_context(date, baseline_days=28)`
- `get_training_day_context(date, history_days=42)`
- `get_training_history(start_date, end_date)` con 56–84 dias
- `get_activity_details(activity_id)`

Todas devuelven `{ meta, data, issues }`, con fechas, timezone, unidades y cache. HRV usa `unspecified_by_api` si Garmin no declara su unidad. Los timestamps de sueno aceptan strings ISO y numeros epoch en segundos o milisegundos; se normalizan a ISO.

## 5. Cache local

- Token: `~/.config/garmin/access_token.json`.
- Datos: `~/.config/garmin/cache/`.
- Dia actual: 10 minutos; dos dias anteriores: 6 horas; historia cerrada: larga duracion.
- Actividades por dia, paginacion de 20 y deduplicacion por `activityId`.
- Cache de datos con namespace SHA-256 de la Key; nunca compartir datos entre cuentas.
- Escritura atomica y permisos `0600` en POSIX.
- Paquete npm: incluir `build/`, `coach/` y `scripts/notify_email.py`; comprobar con `npm pack --dry-run`.

## 6. Convenciones

- TypeScript strict, ESM, Node 20+, Zod y Axios existentes.
- Sin comentarios innecesarios en el codigo.
- Imports locales sin extension; SDK externo con ruta completa `.js`.
- `console.error()` para logging de servidores stdio.
- No secretos reales en tests, fixtures, docs, logs o Git.
- Python solo stdlib para el helper SMTP.

## 7. Verificacion

```bash
npm test
npm run typecheck
npm run build
python -m unittest discover -s tests -p "test_*.py"
git diff --check
```

Los tests no deben acceder a Garmin ni SMTP reales. El antiguo `src/client/garmin.client.test.ts` es live API y esta excluido del suite offline; conserva dos errores historicos de tipos que no pertenecen a la nueva implementacion.

## 8. Entrega por fases

Despues de cada fase: ejecutar tests y build, mostrar archivos cambiados, diferencias clave, resultados, problemas pendientes y scans de secretos/escritura/endpoints. No continuar a la siguiente fase hasta confirmacion del usuario.
