// Decisión client-side para mostrar el botón "Enviar por WhatsApp".
//
// Filosofía (PRODUCT_BIBLE.md): si la acción no aplica, no la mostramos.
// Sin disabled, sin tooltips, sin mensajes "no podés porque...". El dueño
// no necesita explicación — si la opción tiene sentido aparece, si no, no.
//
// Una factura/venta es enviable por WhatsApp solo si tiene un cliente con
// teléfono cargado. Sin teléfono → botón oculto.

export function canSendInvoiceByWhatsapp(customerPhone: string | null | undefined): boolean {
  if (typeof customerPhone !== "string") return false;
  return customerPhone.trim().length > 0;
}
