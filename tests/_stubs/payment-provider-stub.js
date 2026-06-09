module.exports = { getPaymentProvider: async () => ({ createCollection: async () => ({ providerRef: "pref_test", checkoutUrl: "https://mp.me/test", instructions: null }) }) };
