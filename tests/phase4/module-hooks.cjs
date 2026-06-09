const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const globalState = globalThis.__veloraPhase4ModuleHooks ?? {
  installed: false,
  mocks: new Map(),
};

function resolveAlias(request) {
  const base = path.join(process.cwd(), "src", request.slice(2));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.cts`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return base;
}

function installHooks() {
  if (globalState.installed) return;

  const originalResolveFilename = Module._resolveFilename;
  const originalLoad = Module._load;

  Module._resolveFilename = function patchedResolveFilename(request, parent, isMain, options) {
    if (request.startsWith("@/")) {
      const resolved = resolveAlias(request);
      return originalResolveFilename.call(this, resolved, parent, isMain, options);
    }

    return originalResolveFilename.call(this, request, parent, isMain, options);
  };

  Module._load = function patchedLoad(request, parent, isMain) {
    if (globalState.mocks.has(request)) {
      return globalState.mocks.get(request);
    }

    return originalLoad.apply(this, arguments);
  };

  globalState.installed = true;
  globalThis.__veloraPhase4ModuleHooks = globalState;
}

function setMockModule(request, exports) {
  installHooks();
  globalState.mocks.set(request, exports);
}

function clearMockModules() {
  globalState.mocks.clear();
}

function resetSourceModules() {
  const cwd = process.cwd() + path.sep;

  for (const cacheKey of Object.keys(require.cache)) {
    if (cacheKey.startsWith(cwd) && cacheKey.includes(`${path.sep}src${path.sep}`)) {
      delete require.cache[cacheKey];
    }
  }
}

module.exports = {
  clearMockModules,
  resetSourceModules,
  setMockModule,
};
