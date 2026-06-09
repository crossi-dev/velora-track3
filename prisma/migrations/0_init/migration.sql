-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerChatUsage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OwnerChatUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Business" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "cuit" TEXT,
    "address" TEXT,
    "postalCode" TEXT,
    "phone" TEXT,
    "ivaCondition" TEXT DEFAULT 'Monotributista',
    "puntoVenta" TEXT,
    "iibb" TEXT,
    "activityStart" TEXT,
    "courierPreference" TEXT,
    "paymentProvider" TEXT DEFAULT 'mercadopago',
    "workerCount" INTEGER NOT NULL DEFAULT 0,
    "openingCash" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "openingCashConfigured" BOOLEAN NOT NULL DEFAULT false,
    "paymentMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstSaleConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "mercadoPagoOnboardingDeferred" BOOLEAN NOT NULL DEFAULT false,
    "customersOnboardingSkipped" BOOLEAN NOT NULL DEFAULT false,
    "arcaOnboardingDeferred" BOOLEAN NOT NULL DEFAULT false,
    "andreaniOnboardingDeferred" BOOLEAN NOT NULL DEFAULT false,
    "arcaDelegationCuit" TEXT,
    "arcaDelegationPendingStep" TEXT,
    "andreaniApiToken" TEXT,
    "andreaniApiUser" TEXT,
    "andreaniTokenPendingStep" TEXT,
    "taxRate" DECIMAL(12,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "email" TEXT,
    "whatsappPhone" TEXT,
    "alias" TEXT,
    "loginTokenVersion" INTEGER NOT NULL DEFAULT 1,
    "openingTime" TEXT DEFAULT '09:00',
    "closingTime" TEXT DEFAULT '20:00',
    "allowNegativeStock" BOOLEAN NOT NULL DEFAULT false,
    "defaultCustomer" TEXT NOT NULL DEFAULT 'Consumidor Final',
    "allowSaleWithoutCustomer" BOOLEAN NOT NULL DEFAULT true,
    "openReceiptAfterSale" BOOLEAN NOT NULL DEFAULT false,
    "autoCreateProductOnStockLoad" BOOLEAN NOT NULL DEFAULT false,
    "suggestWhatsappAfterSale" BOOLEAN NOT NULL DEFAULT true,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 5,
    "sessionDurationHours" INTEGER DEFAULT 8,
    "pendingStockProductId" TEXT,
    "demoMode" BOOLEAN NOT NULL DEFAULT true,
    "demoActionsUsed" INTEGER NOT NULL DEFAULT 0,
    "demoActionsLimit" INTEGER NOT NULL DEFAULT 50,
    "lastProactiveNudgeAt" TIMESTAMP(3),
    "skippedCatalog" BOOLEAN NOT NULL DEFAULT false,
    "firstSalePromptShown" BOOLEAN NOT NULL DEFAULT false,
    "firstSalePromptShownAt" TIMESTAMP(3),
    "firstSaleNudgeSent" BOOLEAN NOT NULL DEFAULT false,
    "notifyLowStockWa" BOOLEAN NOT NULL DEFAULT false,
    "whatsappBusinessPhoneE164" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,

    CONSTRAINT "Business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "pinHash" VARCHAR(200) NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'employee',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "failedPinAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "consecutiveLockouts" INTEGER NOT NULL DEFAULT 0,
    "firstSaleConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "onboardingStockQueryDoneAt" TIMESTAMP(3),
    "onboardingSalesQueryDoneAt" TIMESTAMP(3),
    "onboardingCobroQrDoneAt" TIMESTAMP(3),
    "onboardingSaleSendDoneAt" TIMESTAMP(3),
    "onboardingCompletedAt" TIMESTAMP(3),
    "lastWelcomeAt" TIMESTAMP(3),
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'assistant',
    "text" VARCHAR(8192) NOT NULL,
    "chips" JSONB,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "targetEmployeeId" TEXT,
    "customerId" TEXT,
    "ackedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessCounter" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "counterType" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "BusinessCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "customerId" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "documentType" TEXT NOT NULL DEFAULT 'receipt',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" TEXT NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "caeCode" TEXT,
    "caeFchVto" TIMESTAMP(3),
    "fiscalTipo" INTEGER,
    "fiscalPtoVta" INTEGER,
    "fiscalNumero" INTEGER,
    "fiscalEmittedAt" TIMESTAMP(3),
    "fiscalQrUrl" TEXT,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "costPrice" DECIMAL(65,30),
    "sku" TEXT,
    "reorderThreshold" INTEGER NOT NULL DEFAULT 5,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "weightGrams" INTEGER,
    "businessId" TEXT NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "taxId" TEXT,
    "dni" TEXT,
    "ivaCondition" TEXT,
    "address" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "embedding" vector(768),
    "embeddingUpdatedAt" TIMESTAMP(3),
    "agentSessionState" JSONB,
    "agentSessionStateUpdatedAt" TIMESTAMP(3),
    "priceTierId" TEXT,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 3,
    "businessId" TEXT NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "taxAmount" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'paid',
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT,
    "paymentMethod" TEXT,
    "paymentRequestSentAt" TIMESTAMP(3),
    "logisticaTriggeredAt" TIMESTAMP(3),
    "shippingQuoteCost" DECIMAL(14,2),
    "shippingQuoteCourier" TEXT,
    "shippingRequired" BOOLEAN NOT NULL DEFAULT false,
    "shippingAddressId" TEXT,
    "undoNotificationSentAt" TIMESTAMP(3),

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "saleId" TEXT,
    "monto" DECIMAL(12,2) NOT NULL,
    "metodo" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdByEmployeeId" TEXT,
    "confirmedByEmployeeId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "refundedByEmployeeId" TEXT,
    "matchedCustomerId" TEXT,
    "shippingRequired" BOOLEAN NOT NULL DEFAULT false,
    "shippingAddress" JSONB,
    "shippingCostARS" DECIMAL(12,2),
    "comprobanteSentAt" TIMESTAMP(3),
    "shipmentCreatedAt" TIMESTAMP(3),
    "trackingWppSentAt" TIMESTAMP(3),
    "paymentLinkSentAt" TIMESTAMP(3),
    "providerRef" TEXT,
    "checkoutUrl" TEXT,
    "paymentInstructions" TEXT,
    "promesaExpectedAt" TIMESTAMP(3),
    "reconcileFastTrack" BOOLEAN NOT NULL DEFAULT false,
    "reconcileFailureCount" INTEGER NOT NULL DEFAULT 0,
    "reconcileLastError" VARCHAR(500),
    "items" JSONB,
    "shippingCourier" TEXT,
    "refundNotificationSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentConfirmDlq" (
    "id" TEXT NOT NULL,
    "taskName" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "rawMessage" TEXT NOT NULL,
    "lastError" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentConfirmDlq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentCancelDlq" (
    "id" TEXT NOT NULL,
    "taskName" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "rawMessage" TEXT NOT NULL,
    "lastError" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentCancelDlq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleItem" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "productId" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,
    "unitCost" DECIMAL(65,30),

    CONSTRAINT "SaleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "saleId" TEXT,
    "type" TEXT NOT NULL,
    "description" VARCHAR(2000) NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "paymentMethod" TEXT,
    "clientMessageId" TEXT,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "quantityBefore" INTEGER NOT NULL,
    "quantityAfter" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "unitCost" DECIMAL(65,30),
    "reason" TEXT NOT NULL DEFAULT 'manual',
    "referenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLoad" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorReason" TEXT,

    CONSTRAINT "StockLoad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CriticalWriteEvent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorEmployeeId" TEXT,
    "routeScope" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "summary" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "inputJson" TEXT,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CriticalWriteEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEventLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "eventId" VARCHAR(128) NOT NULL,
    "protocol" TEXT NOT NULL,
    "protocolVersion" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorEmployeeId" TEXT,
    "source" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "decisionJson" TEXT,
    "pushSent" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AgentEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MockPurchaseRequest" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "supplierId" TEXT,
    "requestNumber" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockPurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Budget" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "budgetNumber" TEXT NOT NULL,
    "customerName" TEXT,
    "customerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "currency" TEXT NOT NULL,
    "totalAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetItem" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "BudgetItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRateLimit" (
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AiRateLimit_pkey" PRIMARY KEY ("userId","date")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'webpush',
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "fcmToken" TEXT,
    "deviceLabel" TEXT,
    "expired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailySummaryPushLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "dateAR" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailySummaryPushLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CronCheckpoint" (
    "jobName" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "runningAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronCheckpoint_pkey" PRIMARY KEY ("jobName")
);

-- CreateTable
CREATE TABLE "BusinessRule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DelegationPolicy" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "maxValue" DECIMAL(65,30),
    "conditions" VARCHAR(2000) NOT NULL,
    "requiresOwner" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessDocument" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "sourcePage" INTEGER NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "chunkText" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptExample" (
    "id" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "outputJson" TEXT NOT NULL,
    "intentType" TEXT NOT NULL,
    "embedding" vector(768),
    "source" TEXT NOT NULL DEFAULT 'auto_learned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptExample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageFeedback" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "feedback" TEXT NOT NULL,
    "userInput" TEXT,
    "assistantAnswer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "mpUserId" TEXT NOT NULL,
    "accessTokenCiphertext" TEXT,
    "refreshTokenCiphertext" TEXT,
    "publicKey" TEXT,
    "externalPosId" TEXT,
    "liveMode" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MpConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuthState" (
    "state" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "capacity" DOUBLE PRECISION NOT NULL,
    "refillRate" DOUBLE PRECISION NOT NULL,
    "lastRefillAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AndreaniShipment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "labelPdfPath" TEXT,
    "estimatedDelivery" TIMESTAMP(3),
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AndreaniShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OcaShipment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "trackingNumber" TEXT NOT NULL,
    "operativa" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "labelUrl" TEXT,
    "estimatedDelivery" TIMESTAMP(3),
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OcaShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeNote" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "EmployeeNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustedPeerAgent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "agentCardJson" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "TrustedPeerAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArcaCredential" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cuit" TEXT NOT NULL,
    "puntoVenta" INTEGER NOT NULL,
    "condicionIva" TEXT NOT NULL,
    "certGcsPath" TEXT NOT NULL,
    "encryptedPassphrase" TEXT,
    "passphraseSecretName" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "isProviderDelegation" BOOLEAN NOT NULL DEFAULT false,
    "providerCuit" TEXT,
    "cachedToken" TEXT,
    "cachedSign" TEXT,
    "cachedExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArcaCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModoConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "encryptedCredentials" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModoConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierCredential" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedCredentials" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessChannelCredential" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedCredentials" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessChannelCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "A2aJtiSeen" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "A2aJtiSeen_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "WebhookSecurityIncident" (
    "id" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSecurityIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WabaConnection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "accessTokenCiphertext" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WabaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantToolConfig" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "catalog" TEXT,
    "customer" TEXT,
    "fiscal" TEXT,
    "logistica" TEXT,
    "messaging" TEXT,
    "payments" TEXT,
    "promesa" TEXT,
    "supplier" TEXT,
    "ventas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantToolConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CajaSession" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedCashAmount" DOUBLE PRECISION NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedCashAmount" DOUBLE PRECISION,
    "expectedCashAmount" DOUBLE PRECISION,
    "variance" DOUBLE PRECISION,
    "openNote" TEXT,
    "closeNote" TEXT,
    "openedByEmployeeId" TEXT,
    "closedByEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CajaSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPriceTier" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPriceTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPriceTierEntry" (
    "id" TEXT NOT NULL,
    "tierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPriceTierEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "OwnerChatUsage_businessId_date_idx" ON "OwnerChatUsage"("businessId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "OwnerChatUsage_businessId_date_key" ON "OwnerChatUsage"("businessId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Business_userId_key" ON "Business"("userId");

-- CreateIndex
CREATE INDEX "Employee_businessId_active_idx" ON "Employee"("businessId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_businessId_name_key" ON "Employee"("businessId", "name");

-- CreateIndex
CREATE INDEX "ChatMessage_businessId_createdAt_idx" ON "ChatMessage"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_businessId_visibility_createdAt_idx" ON "ChatMessage"("businessId", "visibility", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_businessId_targetEmployeeId_createdAt_idx" ON "ChatMessage"("businessId", "targetEmployeeId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatMessage_businessId_customerId_createdAt_idx" ON "ChatMessage"("businessId", "customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_businessId_clientMessageId_key" ON "ChatMessage"("businessId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessCounter_businessId_counterType_key" ON "BusinessCounter"("businessId", "counterType");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_saleId_key" ON "Invoice"("saleId");

-- CreateIndex
CREATE INDEX "Invoice_businessId_idx" ON "Invoice"("businessId");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE INDEX "Invoice_businessId_issuedAt_idx" ON "Invoice"("businessId", "issuedAt");

-- CreateIndex
CREATE INDEX "Invoice_businessId_fiscalTipo_fiscalPtoVta_fiscalNumero_idx" ON "Invoice"("businessId", "fiscalTipo", "fiscalPtoVta", "fiscalNumero");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_businessId_invoiceNumber_key" ON "Invoice"("businessId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_businessId_documentType_sequenceNumber_key" ON "Invoice"("businessId", "documentType", "sequenceNumber");

-- CreateIndex
CREATE INDEX "Product_businessId_idx" ON "Product"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_businessId_sku_key" ON "Product"("businessId", "sku");

-- CreateIndex
CREATE INDEX "Customer_businessId_idx" ON "Customer"("businessId");

-- CreateIndex
CREATE INDEX "Customer_businessId_name_idx" ON "Customer"("businessId", "name");

-- CreateIndex
CREATE INDEX "Customer_priceTierId_idx" ON "Customer"("priceTierId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_businessId_name_key" ON "Customer"("businessId", "name");

-- CreateIndex
CREATE INDEX "Supplier_businessId_idx" ON "Supplier"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_businessId_name_key" ON "Supplier"("businessId", "name");

-- CreateIndex
CREATE INDEX "Sale_businessId_idx" ON "Sale"("businessId");

-- CreateIndex
CREATE INDEX "Sale_businessId_date_idx" ON "Sale"("businessId", "date");

-- CreateIndex
CREATE INDEX "Sale_customerId_idx" ON "Sale"("customerId");

-- CreateIndex
CREATE INDEX "Sale_businessId_status_idx" ON "Sale"("businessId", "status");

-- CreateIndex
CREATE INDEX "Sale_businessId_employeeId_idx" ON "Sale"("businessId", "employeeId");

-- CreateIndex
CREATE INDEX "PaymentIntent_businessId_estado_createdAt_idx" ON "PaymentIntent"("businessId", "estado", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentIntent_businessId_createdByEmployeeId_idx" ON "PaymentIntent"("businessId", "createdByEmployeeId");

-- CreateIndex
CREATE INDEX "PaymentIntent_saleId_idx" ON "PaymentIntent"("saleId");

-- CreateIndex
CREATE INDEX "PaymentIntent_providerRef_idx" ON "PaymentIntent"("providerRef");

-- CreateIndex
CREATE INDEX "PaymentIntent_businessId_providerRef_idx" ON "PaymentIntent"("businessId", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_businessId_idempotencyKey_key" ON "PaymentIntent"("businessId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentConfirmDlq_taskName_key" ON "PaymentConfirmDlq"("taskName");

-- CreateIndex
CREATE INDEX "PaymentConfirmDlq_businessId_idx" ON "PaymentConfirmDlq"("businessId");

-- CreateIndex
CREATE INDEX "PaymentConfirmDlq_paymentIntentId_idx" ON "PaymentConfirmDlq"("paymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCancelDlq_taskName_key" ON "PaymentCancelDlq"("taskName");

-- CreateIndex
CREATE INDEX "PaymentCancelDlq_businessId_idx" ON "PaymentCancelDlq"("businessId");

-- CreateIndex
CREATE INDEX "PaymentCancelDlq_paymentIntentId_idx" ON "PaymentCancelDlq"("paymentIntentId");

-- CreateIndex
CREATE INDEX "SaleItem_saleId_idx" ON "SaleItem"("saleId");

-- CreateIndex
CREATE INDEX "SaleItem_productId_idx" ON "SaleItem"("productId");

-- CreateIndex
CREATE INDEX "SaleItem_saleId_productId_quantity_idx" ON "SaleItem"("saleId", "productId", "quantity");

-- CreateIndex
CREATE INDEX "CashMovement_businessId_date_idx" ON "CashMovement"("businessId", "date");

-- CreateIndex
CREATE INDEX "CashMovement_saleId_idx" ON "CashMovement"("saleId");

-- CreateIndex
CREATE INDEX "StockMovement_businessId_createdAt_idx" ON "StockMovement"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_productId_idx" ON "StockMovement"("productId");

-- CreateIndex
CREATE INDEX "StockMovement_businessId_productId_createdAt_idx" ON "StockMovement"("businessId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "StockLoad_businessId_startedAt_idx" ON "StockLoad"("businessId", "startedAt");

-- CreateIndex
CREATE INDEX "CriticalWriteEvent_businessId_actionType_createdAt_idx" ON "CriticalWriteEvent"("businessId", "actionType", "createdAt");

-- CreateIndex
CREATE INDEX "CriticalWriteEvent_businessId_actorEmployeeId_createdAt_idx" ON "CriticalWriteEvent"("businessId", "actorEmployeeId", "createdAt");

-- CreateIndex
CREATE INDEX "CriticalWriteEvent_businessId_resourceId_idx" ON "CriticalWriteEvent"("businessId", "resourceId");

-- CreateIndex
CREATE INDEX "CriticalWriteEvent_createdAt_idx" ON "CriticalWriteEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AgentEventLog_businessId_createdAt_idx" ON "AgentEventLog"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEventLog_businessId_eventType_createdAt_idx" ON "AgentEventLog"("businessId", "eventType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEventLog_businessId_eventId_key" ON "AgentEventLog"("businessId", "eventId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_businessId_actionType_createdAt_idx" ON "IdempotencyRecord"("businessId", "actionType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_businessId_actionType_idempotencyKey_key" ON "IdempotencyRecord"("businessId", "actionType", "idempotencyKey");

-- CreateIndex
CREATE INDEX "MockPurchaseRequest_businessId_issuedAt_idx" ON "MockPurchaseRequest"("businessId", "issuedAt");

-- CreateIndex
CREATE INDEX "MockPurchaseRequest_supplierId_idx" ON "MockPurchaseRequest"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "MockPurchaseRequest_businessId_requestNumber_key" ON "MockPurchaseRequest"("businessId", "requestNumber");

-- CreateIndex
CREATE INDEX "Budget_businessId_createdAt_idx" ON "Budget"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "Budget_customerId_idx" ON "Budget"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Budget_businessId_budgetNumber_key" ON "Budget"("businessId", "budgetNumber");

-- CreateIndex
CREATE INDEX "BudgetItem_budgetId_idx" ON "BudgetItem"("budgetId");

-- CreateIndex
CREATE INDEX "PushSubscription_businessId_expired_idx" ON "PushSubscription"("businessId", "expired");

-- CreateIndex
CREATE INDEX "PushSubscription_businessId_kind_expired_idx" ON "PushSubscription"("businessId", "kind", "expired");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_businessId_endpoint_key" ON "PushSubscription"("businessId", "endpoint");

-- CreateIndex
CREATE INDEX "DailySummaryPushLog_dateAR_idx" ON "DailySummaryPushLog"("dateAR");

-- CreateIndex
CREATE UNIQUE INDEX "DailySummaryPushLog_businessId_dateAR_key" ON "DailySummaryPushLog"("businessId", "dateAR");

-- CreateIndex
CREATE INDEX "BusinessRule_businessId_active_idx" ON "BusinessRule"("businessId", "active");

-- CreateIndex
CREATE INDEX "BusinessRule_businessId_active_kind_idx" ON "BusinessRule"("businessId", "active", "kind");

-- CreateIndex
CREATE INDEX "DelegationPolicy_businessId_active_scope_idx" ON "DelegationPolicy"("businessId", "active", "scope");

-- CreateIndex
CREATE INDEX "BusinessDocument_businessId_sourceFile_idx" ON "BusinessDocument"("businessId", "sourceFile");

-- CreateIndex
CREATE INDEX "PromptExample_agentType_intentType_idx" ON "PromptExample"("agentType", "intentType");

-- CreateIndex
CREATE INDEX "MessageFeedback_businessId_feedback_createdAt_idx" ON "MessageFeedback"("businessId", "feedback", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageFeedback_businessId_clientMessageId_key" ON "MessageFeedback"("businessId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "MpConnection_businessId_key" ON "MpConnection"("businessId");

-- CreateIndex
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "RateLimitBucket_updatedAt_idx" ON "RateLimitBucket"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AndreaniShipment_saleId_key" ON "AndreaniShipment"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "AndreaniShipment_trackingNumber_key" ON "AndreaniShipment"("trackingNumber");

-- CreateIndex
CREATE INDEX "AndreaniShipment_businessId_idx" ON "AndreaniShipment"("businessId");

-- CreateIndex
CREATE INDEX "AndreaniShipment_trackingNumber_idx" ON "AndreaniShipment"("trackingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OcaShipment_saleId_key" ON "OcaShipment"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "OcaShipment_trackingNumber_key" ON "OcaShipment"("trackingNumber");

-- CreateIndex
CREATE INDEX "OcaShipment_businessId_idx" ON "OcaShipment"("businessId");

-- CreateIndex
CREATE INDEX "OcaShipment_trackingNumber_idx" ON "OcaShipment"("trackingNumber");

-- CreateIndex
CREATE INDEX "EmployeeNote_businessId_acknowledgedAt_idx" ON "EmployeeNote"("businessId", "acknowledgedAt");

-- CreateIndex
CREATE INDEX "EmployeeNote_businessId_createdAt_idx" ON "EmployeeNote"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "TrustedPeerAgent_businessId_idx" ON "TrustedPeerAgent"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedPeerAgent_businessId_domain_key" ON "TrustedPeerAgent"("businessId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "ArcaCredential_businessId_key" ON "ArcaCredential"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ModoConnection_businessId_key" ON "ModoConnection"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "CourierCredential_businessId_provider_key" ON "CourierCredential"("businessId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessChannelCredential_businessId_provider_key" ON "BusinessChannelCredential"("businessId", "provider");

-- CreateIndex
CREATE INDEX "A2aJtiSeen_expiresAt_idx" ON "A2aJtiSeen"("expiresAt");

-- CreateIndex
CREATE INDEX "WebhookSecurityIncident_ipAddress_eventType_idx" ON "WebhookSecurityIncident"("ipAddress", "eventType");

-- CreateIndex
CREATE INDEX "WebhookSecurityIncident_expiresAt_idx" ON "WebhookSecurityIncident"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookSecurityIncident_ipAddress_eventType_key" ON "WebhookSecurityIncident"("ipAddress", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "WabaConnection_businessId_key" ON "WabaConnection"("businessId");

-- CreateIndex
CREATE INDEX "WabaConnection_phoneNumberId_idx" ON "WabaConnection"("phoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantToolConfig_businessId_key" ON "TenantToolConfig"("businessId");

-- CreateIndex
CREATE INDEX "CajaSession_businessId_state_idx" ON "CajaSession"("businessId", "state");

-- CreateIndex
CREATE INDEX "CajaSession_businessId_openedAt_idx" ON "CajaSession"("businessId", "openedAt");

-- CreateIndex
CREATE INDEX "ProductPriceTier_businessId_idx" ON "ProductPriceTier"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPriceTier_businessId_label_key" ON "ProductPriceTier"("businessId", "label");

-- CreateIndex
CREATE INDEX "ProductPriceTierEntry_tierId_idx" ON "ProductPriceTierEntry"("tierId");

-- CreateIndex
CREATE INDEX "ProductPriceTierEntry_productId_idx" ON "ProductPriceTierEntry"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPriceTierEntry_tierId_productId_key" ON "ProductPriceTierEntry"("tierId", "productId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerChatUsage" ADD CONSTRAINT "OwnerChatUsage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Business" ADD CONSTRAINT "Business_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_targetEmployeeId_fkey" FOREIGN KEY ("targetEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessCounter" ADD CONSTRAINT "BusinessCounter_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_priceTierId_fkey" FOREIGN KEY ("priceTierId") REFERENCES "ProductPriceTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_matchedCustomerId_fkey" FOREIGN KEY ("matchedCustomerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLoad" ADD CONSTRAINT "StockLoad_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetItem" ADD CONSTRAINT "BudgetItem_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "Budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessRule" ADD CONSTRAINT "BusinessRule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DelegationPolicy" ADD CONSTRAINT "DelegationPolicy_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessDocument" ADD CONSTRAINT "BusinessDocument_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MpConnection" ADD CONSTRAINT "MpConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AndreaniShipment" ADD CONSTRAINT "AndreaniShipment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcaShipment" ADD CONSTRAINT "OcaShipment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeNote" ADD CONSTRAINT "EmployeeNote_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeNote" ADD CONSTRAINT "EmployeeNote_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedPeerAgent" ADD CONSTRAINT "TrustedPeerAgent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArcaCredential" ADD CONSTRAINT "ArcaCredential_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModoConnection" ADD CONSTRAINT "ModoConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierCredential" ADD CONSTRAINT "CourierCredential_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessChannelCredential" ADD CONSTRAINT "BusinessChannelCredential_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WabaConnection" ADD CONSTRAINT "WabaConnection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantToolConfig" ADD CONSTRAINT "TenantToolConfig_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CajaSession" ADD CONSTRAINT "CajaSession_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CajaSession" ADD CONSTRAINT "CajaSession_openedByEmployeeId_fkey" FOREIGN KEY ("openedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CajaSession" ADD CONSTRAINT "CajaSession_closedByEmployeeId_fkey" FOREIGN KEY ("closedByEmployeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPriceTier" ADD CONSTRAINT "ProductPriceTier_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPriceTierEntry" ADD CONSTRAINT "ProductPriceTierEntry_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "ProductPriceTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPriceTierEntry" ADD CONSTRAINT "ProductPriceTierEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

