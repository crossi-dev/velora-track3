module.exports = {
  cloudLog: () => {},
  runWithTraceContext: (_headers, fn) => fn(),
  runWithTraceStore: (_store, fn) => fn(),
  getTraceStore: () => undefined,
  logA2ATransfer: () => {},
  logUnauthorizedAccess: () => {},
  reportError: () => {},
  reportWarning: () => {},
};
