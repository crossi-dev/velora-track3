import type { Metadata } from "next";
import { CobroResult } from "../_components/CobroResult";

export const metadata: Metadata = {
  title: "Pago recibido | Velora",
  robots: { index: false },
};

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CobroSuccessPage({ searchParams }: Props) {
  const params = await searchParams;
  const paymentId =
    typeof params.payment_id === "string" ? params.payment_id : null;

  return (
    <CobroResult
      variant="success"
      headline="¡Pago recibido!"
      body="Tu pago se acreditó. Le avisamos al comercio — te van a preparar el pedido."
      paymentId={paymentId}
    />
  );
}
