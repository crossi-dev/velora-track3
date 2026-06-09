// owner-assistant.prompt.examples.ts — Few-shot examples for the Owner Assistant prompt.
//
// Extracted from owner-assistant.prompt.ts to keep it under the 300-line limit.
// Imported and concatenated into OWNER_ASSISTANT_SYSTEM_PROMPT at module load time.

export const OWNER_ASSISTANT_FEW_SHOT_EXAMPLES = `
## Extracción de datos — ejemplos de entrenamiento (MUY IMPORTANTE)

### create_product — crear un producto nuevo

Ejemplo 1 (verbless, posicional):
  Dueño: "producto bizcochuelo 50 unidades 20 pesos"
  → create_product({ name: "bizcochuelo", price: 20, stock: 50 })
  Razón: "producto" es declarativo; el número después del nombre es stock ("50 unidades");
         el número final con "pesos" es el precio ("20 pesos").

Ejemplo 2 (verbless, sin unidades):
  Dueño: "alfajor 1500 stock 24"
  → create_product({ name: "alfajor", price: 1500, stock: 24 })
  Razón: precio primero (mayor, lógico como precio), stock segundo con señal "stock".

Ejemplo 3 (con verbo):
  Dueño: "agregar coca cola 2 litros precio 800"
  → create_product({ name: "coca cola 2 litros", price: 800, stock: null })
  Razón: verbo "agregar" + nombre compuesto; precio explícito; stock no mencionado → null.

Ejemplo 4 (sin precio):
  Dueño: "producto tuerca M8"
  → preguntá el precio: "¿A qué precio vendés la tuerca M8?"

### stock_load — llegaron mercaderías

Ejemplo 5 (llegaron N de X a Y):
  Dueño: "llegaron 20 de coca cola a 800"
  → stock_load({ itemName: "coca cola", quantity: 20, unitPrice: 800, supplierName: "" })

Ejemplo 6 (con proveedor):
  Dueño: "entró mercadería de Distribuidora Cordo: 50 alfajores a 150"
  → stock_load({ itemName: "alfajores", quantity: 50, unitPrice: 150, supplierName: "Distribuidora Cordo" })

Ejemplo 7 (sin precio):
  Dueño: "cargué 30 latas de atún"
  → stock_load({ itemName: "latas de atún", quantity: 30, unitPrice: null, supplierName: "" })

### adjust_stock — corregir stock existente

Ejemplo 8 (set):
  Dueño: "el stock de gaseosas es 12"
  → adjust_stock({ productName: "gaseosas", mode: "set", quantity: 12 })

Ejemplo 9 (increase):
  Dueño: "sumá 5 unidades de pan"
  → adjust_stock({ productName: "pan", mode: "increase", quantity: 5 })

Ejemplo 10 (decrease):
  Dueño: "me faltan 3 papas fritas, bajá el stock"
  → adjust_stock({ productName: "papas fritas", mode: "decrease", quantity: 3 })

### register_sale — registrar una venta

Ejemplo 11 (con cliente, sin envío):
  Dueño: "vendé 2 alfajores a María"
  → register_sale({ productName: "alfajores", customerName: "María" })
  Razón: el dueño no pidió mandar comprobante por WhatsApp → omitir autoSend (campo opcional).

Ejemplo 12 (sin cliente mencionado):
  Dueño: "venta de gaseosa"
  → register_sale({ productName: "gaseosa", customerName: "Consumidor Final", autoSend: undefined })
  Razón: sin nombre de cliente → usar "Consumidor Final" por defecto.

Ejemplo 13 (con envío):
  Dueño: "vendé coca cola a Juan y mandále el comprobante"
  → register_sale({ productName: "coca cola", customerName: "Juan", autoSend: true })

### return_sale — deshacer ventas

Ejemplo 14 (una venta):
  Dueño: "deshacer última venta"
  → return_sale({ undoCount: 1 })

Ejemplo 15 (múltiples):
  Dueño: "undo 3 ventas"
  → return_sale({ undoCount: 3 })

### register_movement — movimiento de caja

Ejemplo 16 (gasto):
  Dueño: "gasto 500 pesos en bolsas"
  → register_movement({ movementType: "purchase", amount: 500, description: "bolsas" })
  Razón: "gasto" → movementType "purchase" (compra/gasto de operación).

Ejemplo 17 (ingreso):
  Dueño: "entró 2000 de la venta mayorista"
  → register_movement({ movementType: "income", amount: 2000, description: "venta mayorista" })

Ejemplo 18 (sueldo):
  Dueño: "pagué sueldo de Carlos 15000"
  → register_movement({ movementType: "salary", amount: 15000, description: "sueldo Carlos" })

Ejemplo 19 (retiro):
  Dueño: "saqué 3000 de caja para gastos personales"
  → register_movement({ movementType: "adjustment", amount: 3000, description: "retiro personal" })

### create_customer — agregar cliente

Ejemplo 20 (nombre y teléfono):
  Dueño: "agregar cliente Ana García, teléfono 2612345678"
  → create_customer({ name: "Ana García", phone: "2612345678", email: null, taxId: null })

Ejemplo 21 (solo nombre):
  Dueño: "nuevo cliente Martín López"
  → create_customer({ name: "Martín López", phone: null, email: null, taxId: null })

Ejemplo 22 (con CUIT):
  Dueño: "cliente empresa ABC CUIT 20123456789"
  → create_customer({ name: "empresa ABC", phone: null, email: null, taxId: "20123456789" })

### edit_product — editar un campo de producto

Ejemplo 23 (cambio de precio):
  Dueño: "cambiar precio de alfajor a 250"
  → edit_product({ productName: "alfajor", field: "price", value: 250 })

Ejemplo 24 (cambio de nombre):
  Dueño: "renombrá 'coca cola' a 'Coca-Cola 500ml'"
  → edit_product({ productName: "coca cola", field: "name", value: "Coca-Cola 500ml" })

### bulk_price_update — actualizar precios en masa

Ejemplo 25 (subir % todo el catálogo):
  Dueño: "subir todos los precios 10%"
  → bulk_price_update({ amount: 10, mode: "percentage", direction: "up", target: "all" })

Ejemplo 26 (bajar % un producto):
  Dueño: "bajar el precio de alfajores 5%"
  → bulk_price_update({ amount: 5, mode: "percentage", direction: "down", target: "alfajores" })

### delete_product — eliminar producto

Ejemplo 27:
  Dueño: "borrar producto tuerca M8"
  → delete_product({ productName: "tuerca M8" })

### edit_customer — editar un campo de cliente

Ejemplo 28:
  Dueño: "cambiar el teléfono de Ana García a 2614567890"
  → edit_customer({ customerName: "Ana García", field: "phone", value: "2614567890" })

### create_supplier — nuevo proveedor

Ejemplo 29 (completo):
  Dueño: "agregar proveedor Distribuidora Sur, teléfono 2612222333, contacto Pedro Gómez"
  → create_supplier({ name: "Distribuidora Sur", phone: "2612222333", email: "", contactName: "Pedro Gómez" })

Ejemplo 30 (solo nombre):
  Dueño: "nuevo proveedor Lácteos del Valle"
  → create_supplier({ name: "Lácteos del Valle", phone: "", email: "", contactName: "" })

### edit_supplier — editar proveedor

Ejemplo 31:
  Dueño: "cambiar el teléfono de Distribuidora Sur a 2619999888"
  → edit_supplier({ supplierName: "Distribuidora Sur", field: "phone", value: "2619999888" })

### delete_supplier — eliminar proveedor

Ejemplo 32:
  Dueño: "eliminar proveedor Lácteos del Valle"
  → delete_supplier({ supplierName: "Lácteos del Valle" })

### delete_customer — eliminar cliente

Ejemplo 35:
  Dueño: "borrar cliente Juan Pérez"
  → delete_customer({ customerName: "Juan Pérez" })
  Razón: verbo destructivo + nombre del cliente. Si el cliente tiene ventas/facturas,
         el sistema lo rechaza automáticamente con un mensaje cálido.

### create_purchase_request — pedido de compra

Ejemplo 33 (con todo):
  Dueño: "pedir 50 alfajores a Distribuidora Sur a 120 pesos"
  → create_purchase_request({ supplierName: "Distribuidora Sur", itemName: "alfajores", quantity: 50, unitPrice: 120 })

Ejemplo 34 (sin precio):
  Dueño: "hacer un pedido de gaseosas a Coca-Cola"
  → create_purchase_request({ supplierName: "Coca-Cola", itemName: "gaseosas", quantity: null, unitPrice: null })

### list_customers — listar clientes

Ejemplo 36 (todos):
  Dueño: "¿quiénes son mis clientes?"
  → list_customers({})
  Razón: pregunta de listado → llamar la herramienta y mostrar el resultado en texto.

Ejemplo 37 (con filtro):
  Dueño: "¿tengo algún cliente que se llame García?"
  → list_customers({ search: "García" })

Ejemplo 38 (cantidad):
  Dueño: "¿cuántos clientes tengo?"
  → list_customers({})
  Razón: usar el campo "total" del resultado para responder cuántos.

### list_suppliers — listar proveedores

Ejemplo 39 (todos):
  Dueño: "¿qué proveedores tengo?"
  → list_suppliers({})
  Razón: pregunta de listado → llamar la herramienta y mostrar el resultado en texto.

Ejemplo 40 (con filtro):
  Dueño: "¿tengo algún proveedor Distribuidora?"
  → list_suppliers({ search: "Distribuidora" })
`.trimEnd();
