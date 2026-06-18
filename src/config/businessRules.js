/**
 * Reglas de negocio centralizadas del backend POS Minimarket.
 *
 * IMPORTANTE: Cualquier cambio en estas constantes debe replicarse en
 * front/minimarket/src/config/businessRules.js para mantener
 * la coherencia entre frontend y backend.
 */

// ── Programa de lealtad ───────────────────────────────────────────────────────
// IMPORTANTE: estos valores DEBEN coincidir con LOYALTY_LEVELS en
// front/minimarket/src/shared/utils/LoyaltyEngine.js.
export const LOYALTY = {
  // Puntos acumulados históricos para alcanzar cada nivel (min del rango)
  LEVEL_PLATINO:  4000,
  LEVEL_ORO:      1500,
  LEVEL_PLATA:     500,

  // Multiplicador de puntos por nivel (se aplica al base = floor(total / POINTS_DIVISOR))
  RATE_PLATINO: 2.0,  // acumulado >= 4000
  RATE_ORO:     1.5,  // acumulado >= 1500
  RATE_PLATA:   1.2,  // acumulado >= 500
  RATE_BRONCE:  1.0,  // nivel bronce (base)

  // Divisor del total de venta para calcular puntos base
  POINTS_DIVISOR: 10,

  // Nombres de niveles (almacenados en minúsculas en la BD para uniformidad con Prisma)
  LEVELS: {
    PLATINO: 'platino',
    ORO:     'oro',
    PLATA:   'plata',
    BRONCE:  'bronce',
  },
}

// ── Descuentos ────────────────────────────────────────────────────────────────
export const DISCOUNT = {
  // Descuento máximo absoluto por ítem (% sobre precio unitario).
  // El frontend también tiene este valor como fallback.
  // El valor real por tenant se lee de la configuración del sistema (systemConfig.maxDiscountPct).
  HARD_MAX_PCT: 100,  // Límite absoluto que el backend nunca deja superar
}

// ── Control de stock ──────────────────────────────────────────────────────────
export const STOCK_CONTROL = {
  SIMPLE:     'simple',
  BATCH_FEFO: 'lote_fefo',
  BATCH_FIFO: 'lote_fifo',
  SERIAL:     'serie',
}

// ── Tipos de producto ─────────────────────────────────────────────────────────
export const PRODUCT_TYPE = {
  NORMAL:  'normal',
  BUNDLE:  'bundle',
  SERVICE: 'service',
}

// ── Estados de serial ─────────────────────────────────────────────────────────
export const SERIAL_STATUS = {
  AVAILABLE: 'disponible',
  SOLD:      'vendido',
  INACTIVE:  'dado_baja',
}

// ── Estados de lote ───────────────────────────────────────────────────────────
export const BATCH_STATUS = {
  ACTIVE:    'activo',
  EXHAUSTED: 'agotado',
  EXPIRED:   'vencido',
}

// ── Reserva de stock ──────────────────────────────────────────────────────────
export const STOCK_RESERVE = {
  // TTL de la reserva en minutos (debe ser mayor que STOCK_RESERVE.RENEW_MS del frontend)
  TTL_MINUTES: 10,
}
