export const COOKIE_SESSION_TRANSIENT_CODES = new Set([
  'COOKIE_PROVIDER_UNAVAILABLE',
  'OPERATION_TIMEOUT',
  'REQUEST_FAILED',
  'FREQUENCY_LIMIT',
  'STORAGE_UNAVAILABLE',
  'BINDING_UNAVAILABLE',
  'SESSION_STORAGE_POLICY_MISMATCH',
])

const ERROR_COPY: Record<string, string> = {
  COOKIE_FORMAT_UNRECOGNIZED: 'Formato no reconocido. Usá Cookie Editor JSON, Cookie Header o Netscape cookies.txt.',
  COOKIE_INVALID: 'La exportación contiene una fila crítica inválida. Volvé a exportarla sin editarla.',
  COOKIE_DOMAIN_REJECTED: 'La exportación contiene una cookie crítica fuera de google.com.',
  COOKIE_SET_INCOMPLETE: 'No queda autenticación suficiente para validar la sesión.',
  COOKIE_EXPIRED: 'La sesión importada ya no contiene autenticación vigente. Exportá cookies nuevas.',
  COOKIE_AUTH_EXPIRED: 'Google rechazó la autenticación o ya no queda una cookie de autenticación vigente.',
  COOKIE_PROVIDER_UNAVAILABLE: 'Google no respondió temporalmente; la validación no concluyó. Conservé la captura para reintentar.',
  COOKIE_SESSION_EXPIRED: 'La sesión temporal de STRACKER venció. Importala nuevamente.',
  BODY_TOO_LARGE: 'El archivo supera el límite permitido de 64 KiB.',
  FREQUENCY_LIMIT: 'La actualización fue demasiado rápida. El sampler seguirá en segundo plano.',
  OPERATION_TIMEOUT: 'La operación superó el tiempo de espera. No se confirmó el resultado; conservé la captura para reintentar.',
  REQUEST_FAILED: 'No se pudo completar la operación. Conservé la captura para reintentar.',
  STORAGE_UNAVAILABLE: 'El backend de sesiones no pudo completar la operación de guardado seguro. Conservé la captura para reintentar; si persiste, hay que revisar el servicio.',
  BINDING_UNAVAILABLE: 'El servicio de sesiones no está disponible. Conservé la captura para reintentar cuando el backend se recupere.',
  SESSION_STORAGE_POLICY_MISMATCH: 'El servidor público sigue usando almacenamiento temporal incompatible. No acepté la sesión como persistente y solicité su revocación; conservé la captura para reintentar cuando se actualice el runtime.',
  NOT_FOUND: 'La sesión de STRACKER ya no existe o venció. Volvé a importarla desde el navegador.',
  ORIGIN_REJECTED: 'El servidor rechazó el origen de la solicitud. Abrí STRACKER desde su URL pública y recargá.',
  CONTENT_TYPE_REQUIRED: 'La solicitud no pudo validarse. Recargá STRACKER e intentá de nuevo.',
  REQUEST_INVALID: 'La solicitud no pasó la validación del servidor. Verificá que la exportación no esté editada.',
  METHOD_NOT_ALLOWED: 'Esta operación no está disponible en el runtime actual. Recargá STRACKER e intentá de nuevo.',
  VERSION_METADATA_UNAVAILABLE: 'El runtime publicado no pudo verificar su identidad. El servidor requiere revisión antes de usar la sesión.',
}

export function isTransientCookieSessionError(code: string): boolean {
  return COOKIE_SESSION_TRANSIENT_CODES.has(code)
}

export function cookieSessionErrorMessage(code: string): string {
  const known = ERROR_COPY[code]
  if (known) return known
  const safeCode = /^[A-Z0-9_]{2,64}$/.test(code) ? code : 'UNCLASSIFIED_SERVER_ERROR'
  return `El servidor rechazó la sesión de forma segura (código: ${safeCode}). Conservé la captura si el error permite reintentar.`
}
