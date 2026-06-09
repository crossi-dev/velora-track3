import type { ProviderStatus } from "./ServiciosTab.cards";

/** Per-service contextual tip shown below a connected node. */
export function getServiceTip(
  providerId: string,
  provider: ProviderStatus,
): string | null {
  if (!provider.connected) return null;

  switch (providerId) {
    case "mercadopago":
      return "Estás conectado a Mercado Pago — podés cobrar mandando un link de pago via WhatsApp.";
    case "modo":
      return "Estás conectado a MODO — podés cobrar con la billetera digital.";
    case "alias":
      return provider.value
        ? `Tu alias para transferencias es ${provider.value} — los clientes te pueden transferir directo.`
        : "Alias/CBU configurado — los clientes te pueden transferir directo.";
    case "arca":
      return "Estás conectado a ARCA — podés emitir facturas oficiales por chat.";
    case "andreani":
      return "Estás conectado a Andreani — podés cotizar y crear envíos por chat.";
    case "oca":
      return "Estás conectado a OCA — el comparador de envíos te incluye sus tarifas.";
    case "correo":
      return "Estás conectado a Correo Argentino — podés cotizar envíos por MiCorreo.";
    case "pedidosya":
      return "Estás conectado a PedidosYa — podés coordinar entregas en el día dentro de la ciudad.";
    case "whatsapp_business":
      return "Tenés WhatsApp Business conectado — recibís pedidos y mandás comprobantes por WhatsApp.";
    default:
      return null;
  }
}

export interface ConnectedServices {
  mp: boolean;
  modo: boolean;
  alias: boolean;
  arca: boolean;
  andreani: boolean;
  oca: boolean;
  correo: boolean;
}

/**
 * Builds the Supervisor contextual message based on which services are connected
 * across Ventas, Fiscal, and Logística.
 */
export function buildSupervisorMessage(services: ConnectedServices): string {
  const { mp, arca, andreani, oca, correo, modo, alias } = services;
  const hasShipping = andreani || oca || correo;

  // Best combination: mp + andreani + arca
  if (mp && andreani && arca) {
    return "Como tenés Mercado Pago, Andreani y ARCA conectados, podés vender, cobrar, enviar y facturar con un solo mensaje. El Supervisor coordina todo.";
  }

  // mp + andreani
  if (mp && andreani) {
    return "Como tenés Mercado Pago y Andreani conectados, podés vender y mandar el paquete con un solo mensaje. Decile algo como 'mandale 3 alfajores a Carlos' y el Supervisor coordina el cobro y el envío.";
  }

  // mp + any other courier
  if (mp && hasShipping) {
    const courierName = oca ? "OCA" : "Correo Argentino";
    return `Como tenés Mercado Pago y ${courierName} conectados, podés cobrar y coordinar envíos por chat.`;
  }

  // arca + shipping
  if (arca && hasShipping) {
    const courierName = andreani ? "Andreani" : oca ? "OCA" : "Correo Argentino";
    return `Como tenés ARCA y ${courierName} conectados, podés emitir facturas y coordinar envíos por chat.`;
  }

  // Solo mp
  if (mp) {
    return "Como tenés Mercado Pago conectado, podés cobrar por chat. Conectá un courier para cerrar el ciclo de venta y envío.";
  }

  // Solo arca
  if (arca) {
    return "Como tenés ARCA conectado, podés emitir facturas oficiales por chat después de cada venta.";
  }

  // Solo shipping
  if (hasShipping) {
    const courierName = andreani ? "Andreani" : oca ? "OCA" : "Correo Argentino";
    return `Como tenés ${courierName} conectado, podés cotizar envíos por chat. Conectá Mercado Pago para cobrar también con un solo mensaje.`;
  }

  // Only modo/alias with nothing else
  if (modo || alias) {
    return "Como tenés un medio de cobro configurado, podés cobrar por chat. Conectá un courier o ARCA para cerrar el ciclo completo.";
  }

  // Nothing
  return "Conectá tus servicios (Mercado Pago, ARCA, Andreani) y el Supervisor empieza a coordinar ventas, cobros, facturas y envíos por un solo chat.";
}
