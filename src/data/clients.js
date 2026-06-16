// Clientes mock para pruebas de integración
export const CLIENTS = [
  {
    id: 'cli-001', name: 'DISTRIBUIDORA NORTE S.A.C.',
    documentType: 'RUC', documentNumber: '20512345678',
    phone: '01-4567890', email: 'compras@disnorte.pe',
    address: 'Av. Los Industriales 123, Lima',
    currentDebt: 0, isActive: true,
    loyaltyPoints: 150, loyaltyAccumulated: 150,
    loyaltyLevel: 'bronce', loyaltyTransactions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'cli-002', name: 'LUCIA MENDOZA RIOS',
    documentType: 'DNI', documentNumber: '45678901',
    phone: '987654321', email: null,
    address: null,
    currentDebt: 0, isActive: true,
    loyaltyPoints: 80, loyaltyAccumulated: 80,
    loyaltyLevel: 'bronce', loyaltyTransactions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'cli-003', name: 'TECH SOLUTIONS PERU S.A.C.',
    documentType: 'RUC', documentNumber: '20601234567',
    phone: '01-7654321', email: 'facturacion@techsolutions.pe',
    address: 'Jr. Comercio 456, Miraflores',
    currentDebt: 0, isActive: true,
    loyaltyPoints: 0, loyaltyAccumulated: 0,
    loyaltyLevel: 'bronce', loyaltyTransactions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  },
]
