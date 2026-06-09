-- MpConnection + OAuthState — slice 7 del módulo Cobro QR ("OAuth Mercado Pago").
--
-- Habilita que el dueño conecte su cuenta MP via OAuth y que slices
-- posteriores generen QRs reales con la API de MP usando el accessToken
-- persistido. OAuthState se usa para validar el callback OAuth (consume-once,
-- TTL 30 min) contra CSRF / replay en el redirect de Mercado Pago.
--
-- Aditiva: dos tablas nuevas. NO toca data existente. Sin downtime.

-- CreateTable MpConnection
CREATE TABLE "MpConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "mpUserId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "publicKey" TEXT,
    "liveMode" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MpConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (un negocio = una conexión MP)
CREATE UNIQUE INDEX "MpConnection_businessId_key" ON "MpConnection"("businessId");

-- AddForeignKey (cascade — si el business desaparece, el OAuth token también)
ALTER TABLE "MpConnection" ADD CONSTRAINT "MpConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable OAuthState
CREATE TABLE "OAuthState" (
    "state" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("state")
);

-- CreateIndex (cubre limpieza por TTL)
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");
