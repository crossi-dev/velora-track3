import type { Metadata } from "next";
import { CobroResult } from "../_components/CobroResult";

export const metadata: Metadata = {
  title: "Pago en proceso | Velora",
  robots: { index: false },
};

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CobrowPendingPage({ searchParams }: Props) {
  const params = await searchParams;
  const paymentId =
    typeof params.payment_id === "string" ? params.payment_id : null;

  return (
    <CobroResult
      variant="pending"
      headline="Tu pago está en proceso."
      body="Mercado Pago todavía está confirmando el pago. Le vamos a avisar al comercio en cuanto se acredite."
      paymentId={paymentId}
    />
  );
}
