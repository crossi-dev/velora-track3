const assert = require("node:assert/strict");
const test = require("node:test");

const MODULE_PATH = "../../src/app/dashboard/lib/sounds/play-confirm-beep.ts";

// Helpers para stubear el entorno window/AudioContext entre tests. Cada test
// arma su propio stub porque los flags difieren (matchMedia reduced-motion,
// ausencia de AudioContext, etc.).

function buildAudioStub() {
  const oscillators = [];
  const gains = [];
  let stopCount = 0;
  const ctx = {
    currentTime: 0,
    destination: { __label: "destination" },
    createOscillator() {
      const osc = {
        type: "",
        frequency: { value: 0 },
        connect() {},
        start(at) {
          osc.startedAt = at;
        },
        stop(at) {
          osc.stoppedAt = at;
          stopCount += 1;
        },
      };
      oscillators.push(osc);
      return osc;
    },
    createGain() {
      const gain = {
        gain: {
          value: 0,
          setValueAtTime() {},
          linearRampToValueAtTime() {},
        },
        connect() {},
      };
      gains.push(gain);
      return gain;
    },
  };
  let instances = 0;
  function AudioContextCtor() {
    instances += 1;
    return ctx;
  }
  return {
    AudioContextCtor,
    state: {
      get oscillators() {
        return oscillators;
      },
      get gains() {
        return gains;
      },
      get stopCount() {
        return stopCount;
      },
      get instances() {
        return instances;
      },
    },
  };
}

function setWindow(win) {
  if (win === undefined) {
    delete global.window;
  } else {
    global.window = win;
  }
}

function freshModule() {
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

test("playConfirmBeep es no-op cuando window no existe (SSR)", () => {
  setWindow(undefined);
  const mod = freshModule();
  assert.doesNotThrow(() => mod.playConfirmBeep());
});

test("playConfirmBeep crea dos osciladores (two-tone) y los detiene", () => {
  const stub = buildAudioStub();
  setWindow({
    AudioContext: stub.AudioContextCtor,
    matchMedia: () => ({ matches: false }),
  });
  const mod = freshModule();
  mod.__resetAudioContextForTests();

  mod.playConfirmBeep();

  assert.equal(stub.state.oscillators.length, 2, "se crean dos osciladores");
  assert.equal(stub.state.gains.length, 2, "se crean dos gain nodes");
  assert.equal(stub.state.oscillators[0].frequency.value, 600);
  assert.equal(stub.state.oscillators[1].frequency.value, 900);
  // gain.value tiene que setearse al volumen subtle en cada gain node.
  assert.equal(stub.state.gains[0].gain.value, 0.15);
  assert.equal(stub.state.gains[1].gain.value, 0.15);
  // Cada oscillator se detiene limpiamente.
  assert.equal(stub.state.stopCount, 2, "ambos osciladores stop()");
  for (const osc of stub.state.oscillators) {
    assert.ok(typeof osc.stoppedAt === "number" && osc.stoppedAt > osc.startedAt);
  }
});

test("playConfirmBeep no-op cuando prefers-reduced-motion: reduce", () => {
  const stub = buildAudioStub();
  setWindow({
    AudioContext: stub.AudioContextCtor,
    matchMedia: (query) => ({ matches: query.includes("reduce") }),
  });
  const mod = freshModule();
  mod.__resetAudioContextForTests();

  mod.playConfirmBeep();

  assert.equal(stub.state.oscillators.length, 0, "no se toca audio");
  assert.equal(stub.state.instances, 0, "no se instancia AudioContext");
});

test("playConfirmBeep tolera ausencia de AudioContext", () => {
  setWindow({ matchMedia: () => ({ matches: false }) });
  const mod = freshModule();
  mod.__resetAudioContextForTests();
  assert.doesNotThrow(() => mod.playConfirmBeep());
});

test("playConfirmBeep nunca throws ante errores internos", () => {
  setWindow({
    AudioContext: function () {
      throw new Error("audio busted");
    },
    matchMedia: () => ({ matches: false }),
  });
  const mod = freshModule();
  mod.__resetAudioContextForTests();
  assert.doesNotThrow(() => mod.playConfirmBeep());
});
