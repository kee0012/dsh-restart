/**
 * Client-half tests: load the shipped bundle with a stubbed ModuleLoader, React
 * and document, then render the registered components and inspect the markup.
 * Run with `node test/client.test.mjs`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

let checks = 0;

/**
 * Run one named assertion.
 * @param label - Test name.
 * @param fn - Body.
 */
function test(label, fn) {
  fn();
  checks += 1;
  process.stdout.write(`ok ${checks} - ${label}\n`);
}

/** Minimal React whose hooks need no dispatcher, so components can be called directly. */
const fakeReact = {
  Fragment: Symbol("Fragment"),
  createElement(type, props, ...children) {
    return {
      type,
      props: Object.assign({}, props, { children: children.length > 1 ? children : children[0] }),
    };
  },
  useState(initial) {
    return [typeof initial === "function" ? initial() : initial, () => {}];
  },
  useEffect() {},
  useRef(value) {
    return { current: value };
  },
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
};

/**
 * Load the client bundle in a stubbed browser and return the registered seats.
 * @param options - `titlebar` marks the document as the Windows desktop shell.
 * @returns Registered slot entries and the plugin exports.
 */
function load(options) {
  const registered = [];
  let entry = null;
  const win = {
    __ModuleLoader__: {
      load(value) {
        entry = value;
      },
    },
    location: { reload() {} },
    setTimeout() {
      return 0;
    },
  };
  const doc = {
    documentElement: {
      hasAttribute: (name) => options.titlebar === true && name === "data-windows-titlebar",
    },
  };
  const noFetch = () => Promise.reject(new Error("network is not available in this test"));
  const requireStub = (id) => {
    assert.equal(id, "react", "the bundle must only require react");
    return fakeReact;
  };
  new Function("window", "document", "fetch", "require", source)(win, doc, noFetch, requireStub);
  assert.equal(entry.id, "dsh-restart", "ModuleLoader id must equal the package name");

  const plugin = entry.factory(requireStub);
  const ctx = {
    effect(callback) {
      return callback();
    },
    slots: {
      inject(name, callback) {
        return callback();
      },
      register(descriptor, component) {
        registered.push({ descriptor, component });
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  return { registered, plugin };
}

/**
 * Render a React element tree through the stub React, calling function components.
 * @param element - Element, component function or child array.
 * @returns Plain tree with rendered children, or null.
 */
function render(element) {
  if (element === null || element === undefined || element === false) return null;
  if (Array.isArray(element)) return element.map(render).filter((child) => child !== null);
  if (typeof element === "function") return render(element({}));
  if (typeof element !== "object") return element;
  if (typeof element.type === "function") return render(element.type(element.props || {}));
  if (element.type === undefined) return element;
  const raw = element.props ? element.props.children : undefined;
  const children = raw === undefined ? [] : [].concat(render(raw)).filter((child) => child !== null);
  return { type: element.type, props: element.props, children };
}

/**
 * Depth-first search for the first node of a tag.
 * @param tree - Rendered tree.
 * @param tag - Element tag to find.
 * @returns The node, or null.
 */
function find(tree, tag) {
  if (tree === null || typeof tree !== "object") return null;
  if (Array.isArray(tree)) {
    for (const node of tree) {
      const hit = find(node, tag);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (tree.type === tag) return tree;
  for (const child of tree.children || []) {
    const hit = find(child, tag);
    if (hit !== null) return hit;
  }
  return null;
}

const desktop = load({ titlebar: true });
const web = load({ titlebar: false });

test("the client declares the slots service and both seats", () => {
  assert.deepEqual(desktop.plugin.inject, ["slots"]);
  assert.equal(desktop.registered.length, 2);
  assert.deepEqual(
    desktop.registered.map((seat) => seat.descriptor.name),
    ["shell.overlay", "conversation.session.header.utilities"],
  );
  assert.deepEqual(
    desktop.registered.map((seat) => seat.descriptor.id),
    ["dsh-restart:titlebar", "dsh-restart:header"],
  );
});

test("desktop: the button is anchored left of the native window controls", () => {
  const [titlebar, header] = desktop.registered;
  const tree = render(titlebar.component({}));
  assert.notEqual(tree, null, "the title bar button must render inside the desktop shell");
  const button = find(tree, "button");
  assert.notEqual(button, null, "the title bar seat must render a button");
  assert.equal(button.props.style.position, "absolute");
  assert.equal(button.props.style.right, 46 * 3 + 6);
  assert.equal(button.props.style.height, "var(--dsh-windows-titlebar-height, 40px)");
  assert.equal(button.props.style.WebkitAppRegion, "no-drag");
  assert.equal(button.props.style.pointerEvents, "auto");
  assert.equal(button.props["aria-label"], "重启 DSH");
  assert.equal(header.component({}), null, "the header seat must stay empty on the desktop");
});

test("web: the fallback button renders in the conversation header only", () => {
  const [titlebar, header] = web.registered;
  assert.equal(titlebar.component({}), null, "no title bar exists outside the desktop shell");
  const tree = render(header.component({}));
  assert.notEqual(tree, null);
  const button = find(tree, "button");
  assert.notEqual(button, null);
  assert.equal(button.props.style.width, 30);
  assert.equal(button.props.style.position, undefined);
  assert.equal(button.props.style.WebkitAppRegion, "no-drag");
});

test("the bundle keeps React external and has no build-time imports", () => {
  assert.match(source, /require\("react"\)/);
  assert.doesNotMatch(source, /require\("react-dom/);
  assert.doesNotMatch(source, /@deepseek-ai\//);
  assert.match(source, /window\.__ModuleLoader__\.load\(/);
});

process.stdout.write(`\n${checks} client tests passed\n`);
