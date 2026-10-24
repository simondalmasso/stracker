export const COOKIE_SESSION_TRANSIENT_CODES = new Set([
  'COOKIE_PROVIDER_UNAVAILABLE',
  'OPERATION_TIMEOUT',
  'REQUEST_FAILED',
  'FREQUENCY_LIMIT',
])

const ERROR_COPY: Record<string, string> = {
  COOKIE_FORMAT_UNRECOGNIZED: 'Formato no reconocido. Usá Cookie Editor JSON, Cookie Header o Netscape cookies.txt.',
  COOKIE_INVALID: 'La exportación contiene una fila crítica inválida. Volvé a exportarla sin editarla.',
  COOKIE_DOMAIN_REJECTED: 'La exportación contiene una cookie crítica fuera de google.com.',
  COOKIE_SET_INCOMPLETE: 'No queda autenticación suficiente para validar la sesión.',
  COOKIE_EXPIRED: 'La sesión importada ya no contiene autenticación vigente. Exportá cookies nuevas.',
  COOKIE_AUTH_EXPIRED: 'Google rechazó la autenticación o ya no queda una cookie de autenticación vigente.',
  COOKIE_PROVIDER_UNAVAILABLE: 'Google no está disponible temporalmente. STRACKER conserva la sesión cifrada y reintentará.',
  COOKIE_SESSION_EXPIRED: 'La sesión temporal de STRACKER venció. Importala nuevamente.',
  BODY_TOO_LARGE: 'El archivo supera el límite permitido de 64 KiB.',
  FREQUENCY_LIMIT: 'La actualización fue demasiado rápida. El sampler seguirá en segundo plano.',
  OPERATION_TIMEOUT: 'La validación tardó demasiado. STRACKER conserva la sesión para el próximo intento.',
  REQUEST_FAILED: 'No se pudo completar la operación.',
}

export function isTransientCookieSessionError(code: string): boolean {
  return COOKIE_SESSION_TRANSIENT_CODES.has(code)
}

export function cookieSessionErrorMessage(code: string): string {
  return ERROR_COPY[code] || 'El servidor rechazó la sesión de forma segura.'
}
