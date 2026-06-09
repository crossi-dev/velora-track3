// Stub for @phosphor-icons/react. The real package ships a .cjs.js file inside
// a "type": "module" package, which Node treats as ESM and refuses to load via
// the CJS test loader. We don't render icons in unit tests anyway — return a
// Proxy that lazily produces no-op React components for any icon import.
const React = require("react");

const createIconStub = (name) => {
  const Icon = React.forwardRef((props, ref) =>
    React.createElement("svg", { "data-icon": name, ref, ...props }),
  );
  Icon.displayName = name;
  return Icon;
};

module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "__esModule") return true;
      if (typeof prop === "string") return createIconStub(prop);
      return undefined;
    },
  },
);
