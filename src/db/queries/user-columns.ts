// Explicit selection prevents new account fields from becoming shipment API fields.
export const shipmentContactColumns = {
  id: true,
  name: true,
  email: true,
  phone: true,
  avatar: true,
} as const;
