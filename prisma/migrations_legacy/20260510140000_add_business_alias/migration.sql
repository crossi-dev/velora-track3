-- Business.alias — slice 2 del módulo Cobro QR ("modo informal").
--
-- El dueño declara su alias personal MP/CVU (ej. "carlos.mp") en Ajustes;
-- cuando el empleado tipea "cobro alias 5000" la app muestra el alias en
-- grande para que el cliente transfiera. Si el dueño no seteó el alias,
-- el flujo alias responde con un error chip pidiendo configurarlo.
--
-- Aditiva, nullable, sin default forzado: cero downtime y rows existentes
-- arrancan con NULL hasta que el dueño lo declare.

ALTER TABLE "Business" ADD COLUMN "alias" TEXT;
