import type { Metadata } from "next";
import { CobroResult } from "../_components/CobroResult";

export const metadata: Metadata = {
  title: "Pago no completado | Velora",
  robots: { index: false },
};

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CobroFailurePage({ searchParams }: Props) {
  const params = await searchParams;
  const paymentId =
    typeof params.payment_id === "string" ? params.payment_id : null;

  return (
    <CobroResult
      variant="failure"
      headline="El pago no se completó."
      body="No se realizó ningún cobro. Podés volver al link de pago e intentarlo de nuevo."
      paymentId={paymentId}
    />
  );
}
