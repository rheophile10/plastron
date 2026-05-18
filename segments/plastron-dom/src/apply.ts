import type { Fn, State } from "../../../plastron/src/index.js";
import type { Patch, PatchEl } from "./diff.js";
import type {
  AttrValue, EventBinding, EventInfo, VElement, VNode, VText,
} from "./vnode.js";

// ========================================================================
// applyPatch — consume a Patch and mutate the DOM. The only DOM-touching
// code in the segment.
//
// `mounted` is the current root child node (the previous `init`/`replace`
// produced node). `target` is the host element we render into (root.element
// or document.querySelector(root.selector)).
//
// Returns the new mounted child node — caller persists it for next call.
// (Many patch kinds reuse the existing node and return it; "init",
// "replace", and "text-on-text-node" cases may produce a new Node.)
//
// Listener bookkeeping lives in `listenerReg`, a WeakMap<Element,
// Map<eventType, AttachedListener>>. The painter passes its registry
// through; we mutate it as we attach/detach listeners.
// ========================================================================

interface AttachedListener {
  binding: EventBinding;
  fn: EventListener;
}

export type ListenerRegistry = WeakMap<Element, Map<string, AttachedListener>>;

export const applyPatch = (
  target: Element,
  mounted: Node | null,
  patch: Patch,
  reg: ListenerRegistry,
  state: State,
  setFn: Fn | undefined,
  replaceTarget = false,
): Node | null => {
  switch (patch.kind) {
    case "noop":
      return mounted;
    case "init":
    case "replace": {
      if (mounted) detachAllListeners(mounted, reg);
      const fresh = createNode(patch.node, reg, state, setFn);
      if (replaceTarget) {
        // Replace-target mode: the rendered root replaces the target
        // element entirely (or replaces the previously-mounted node on
        // subsequent replace patches). Target's `id` / `class` / `data-*`
        // get merged into the rendered root for any attrs the rendered
        // root doesn't already specify.
        if (fresh.nodeType === 1) {
          mergeTargetAttrs(target, fresh as Element);
        }
        const swapTarget =
          mounted && (mounted as ChildNode).parentNode ? (mounted as ChildNode) : target;
        swapTarget.replaceWith(fresh);
        return fresh;
      }
      target.replaceChildren(fresh);
      return fresh;
    }
    case "text": {
      if (mounted && mounted.nodeType === 3) {
        (mounted as Text).data = patch.text;
        return mounted;
      }
      // Mounted node was an element but the patch is a text update —
      // shouldn't happen if the diff is correct, but be defensive.
      return mounted;
    }
    case "el": {
      if (!mounted || mounted.nodeType !== 1) return mounted;
      applyElPatch(mounted as Element, patch, reg, state, setFn);
      return mounted;
    }
  }
};

// Merge target's identifying attributes (id, class, data-*) into the
// rendered root element for any that aren't already explicitly set.
// Used by replace-target mode so the rendered root inherits the
// placeholder's identity (e.g. id="tbody" for krausest's harness
// selectors).
const mergeTargetAttrs = (target: Element, rendered: Element): void => {
  if (!rendered.hasAttribute("id") && target.hasAttribute("id")) {
    rendered.setAttribute("id", target.getAttribute("id")!);
  }
  if (target.hasAttribute("class")) {
    const renderedClasses = rendered.getAttribute("class") ?? "";
    const targetClasses = target.getAttribute("class")!;
    const set = new Set(renderedClasses.split(/\s+/).filter(Boolean));
    for (const c of targetClasses.split(/\s+/).filter(Boolean)) set.add(c);
    if (set.size > 0) rendered.setAttribute("class", Array.from(set).join(" "));
  }
  const attrs = target.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i]!;
    if (a.name.startsWith("data-") && !rendered.hasAttribute(a.name)) {
      rendered.setAttribute(a.name, a.value);
    }
  }
};

const applyElPatch = (
  el: Element,
  patch: PatchEl,
  reg: ListenerRegistry,
  state: State,
  setFn: Fn | undefined,
): void => {
  if (patch.attrs) applyAttrDelta(el, patch.attrs);
  if (patch.style) applyStyleDelta(el, patch.style);
  if (patch.events) applyEventDelta(el, patch.events, reg, state, setFn);
  if (patch.children) {
    for (const op of patch.children) {
      switch (op.op) {
        case "patch": {
          const child = el.childNodes[op.index];
          if (!child) continue;
          const next = applyPatchToChild(child, op.patch, reg, state, setFn);
          if (next && next !== child) el.replaceChild(next, child);
          break;
        }
        case "appendMany":
          for (const v of op.nodes) {
            el.appendChild(createNode(v, reg, state, setFn));
          }
          break;
        case "trim":
          for (let i = 0; i < op.count; i++) {
            const last = el.lastChild;
            if (!last) break;
            detachAllListeners(last, reg);
            el.removeChild(last);
          }
          break;
        case "reconcile": {
          // Snapshot children BEFORE we touch the DOM so "keep"
          // entries can still find their nodes by fromIndex even
          // after we (logically) detach the whole list.
          const snapshot: Node[] = [];
          for (let i = 0; i < el.childNodes.length; i++) {
            snapshot.push(el.childNodes[i]!);
          }
          const keptIndices = new Set<number>();
          for (const entry of op.entries) {
            if (entry.kind === "keep") keptIndices.add(entry.fromIndex);
          }
          // Children not kept are about to fall out of the tree —
          // detach their listeners so the registry doesn't hold dead
          // bindings.
          for (let i = 0; i < snapshot.length; i++) {
            if (!keptIndices.has(i)) detachAllListeners(snapshot[i]!, reg);
          }
          const next: Node[] = [];
          for (const entry of op.entries) {
            if (entry.kind === "keep") {
              const child = snapshot[entry.fromIndex];
              if (!child) continue;
              const patched = applyPatchToChild(child, entry.patch, reg, state, setFn);
              next.push(patched ?? child);
            } else {
              next.push(createNode(entry.node, reg, state, setFn));
            }
          }
          el.replaceChildren(...next);
          break;
        }
      }
    }
  }
};

// Recurse for child patches. Same shape as applyPatch but doesn't take
// `target` (the parent context); the child IS the node being patched.
const applyPatchToChild = (
  node: Node,
  patch: Patch,
  reg: ListenerRegistry,
  state: State,
  setFn: Fn | undefined,
): Node | null => {
  switch (patch.kind) {
    case "noop":
      return node;
    case "init":
    case "replace": {
      detachAllListeners(node, reg);
      return createNode(patch.node, reg, state, setFn);
    }
    case "text": {
      if (node.nodeType === 3) {
        (node as Text).data = patch.text;
        return node;
      }
      return node;
    }
    case "el": {
      if (node.nodeType !== 1) return node;
      applyElPatch(node as Element, patch, reg, state, setFn);
      return node;
    }
  }
};

// ------------------------------------------------------------------------
// Node creation (init / replace / appendMany).
// ------------------------------------------------------------------------

const createNode = (
  v: VNode,
  reg: ListenerRegistry,
  state: State,
  setFn: Fn | undefined,
): Node => {
  if (v.type === "text") return document.createTextNode((v as VText).text);
  const ve = v as VElement;
  const el = document.createElement(ve.tag);
  if (ve.attrs) {
    for (const [k, val] of Object.entries(ve.attrs)) writeAttr(el, k, val);
  }
  if (ve.style) {
    for (const [k, val] of Object.entries(ve.style)) writeStyle(el, k, val);
  }
  if (ve.events) {
    attachEvents(el, ve.events, reg, state, setFn);
  }
  if (ve.children) {
    for (const child of ve.children) el.appendChild(createNode(child, reg, state, setFn));
  }
  return el;
};

// ------------------------------------------------------------------------
// Attr / style writers.
// ------------------------------------------------------------------------

const writeAttr = (el: Element, name: string, value: AttrValue): void => {
  // Form-element value: the `value` attribute is the *default* value;
  // the displayed value is the IDL property, and setAttribute alone
  // won't update it once the user has interacted. Write both so a
  // controlled form element reflects programmatic changes (e.g., a
  // formula bar tracking the selected cell).
  if (
    name === "value" &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA")
  ) {
    const next =
      value === null || value === undefined || value === false ? "" : String(value);
    if ((el as HTMLInputElement).value !== next) {
      (el as HTMLInputElement).value = next;
    }
  }

  if (value === null || value === undefined || value === false) {
    el.removeAttribute(name);
  } else if (value === true) {
    el.setAttribute(name, "");
  } else {
    el.setAttribute(name, String(value));
  }
};

const applyAttrDelta = (
  el: Element,
  delta: { set?: Record<string, AttrValue>; remove?: string[] },
): void => {
  if (delta.remove) {
    for (const name of delta.remove) el.removeAttribute(name);
  }
  if (delta.set) {
    for (const [name, value] of Object.entries(delta.set)) writeAttr(el, name, value);
  }
};

const writeStyle = (el: Element, prop: string, value: AttrValue): void => {
  const style = (el as HTMLElement).style;
  if (!style) return;
  if (value === null || value === undefined || value === false) {
    style.removeProperty(prop);
  } else {
    style.setProperty(prop, String(value));
  }
};

const applyStyleDelta = (
  el: Element,
  delta: { set?: Record<string, AttrValue>; remove?: string[] },
): void => {
  const style = (el as HTMLElement).style;
  if (!style) return;
  if (delta.remove) {
    for (const prop of delta.remove) style.removeProperty(prop);
  }
  if (delta.set) {
    for (const [prop, value] of Object.entries(delta.set)) writeStyle(el, prop, value);
  }
};

// ------------------------------------------------------------------------
// Event listeners — per-Element registry, diffed in place.
// ------------------------------------------------------------------------

const attachEvents = (
  el: Element,
  events: Record<string, EventBinding>,
  reg: ListenerRegistry,
  state: State,
  setFn: Fn | undefined,
): void => {
  const map = reg.get(el) ?? new Map<string, AttachedListener>();
  for (const [type, binding] of Object.entries(events)) {
    const fn = makeListener(binding, state, setFn);
    el.addEventListener(type, fn);
    map.set(type, { binding: { ...binding }, fn });
  }
  if (map.size > 0) reg.set(el, map);
};

const applyEventDelta = (
  el: Element,
  delta: { upsert?: Record<string, EventBinding>; remove?: string[] },
  reg: ListenerRegistry,
  state: State,
  setFn: Fn | undefined,
): void => {
  const map = reg.get(el) ?? new Map<string, AttachedListener>();

  if (delta.remove) {
    for (const type of delta.remove) {
      const attached = map.get(type);
      if (attached) {
        el.removeEventListener(type, attached.fn);
        map.delete(type);
      }
    }
  }
  if (delta.upsert) {
    for (const [type, binding] of Object.entries(delta.upsert)) {
      const attached = map.get(type);
      if (attached) el.removeEventListener(type, attached.fn);
      const fn = makeListener(binding, state, setFn);
      el.addEventListener(type, fn);
      map.set(type, { binding: { ...binding }, fn });
    }
  }

  if (map.size > 0) reg.set(el, map);
  else reg.delete(el);
};

export const makeListener = (
  binding: EventBinding,
  state: State,
  setFn: Fn | undefined,
): EventListener =>
  (event: Event) => {
    if (binding.set !== undefined && setFn) {
      let value: unknown;
      if (binding.value !== undefined) {
        // Static-value binding (clicks, etc.)
        value = binding.value;
      } else if (binding.extract !== undefined) {
        // Pull a named property off event.target (text input value,
        // checkbox checked, numeric value, file list, …).
        const target = event.target as Record<string, unknown> | null;
        value = target ? target[binding.extract] : undefined;
      } else {
        // Fall-back: write the EventInfo record. Useful for generic
        // dispatchers; rarely what controlled inputs want.
        value = eventInfo(event);
      }
      Promise.resolve(setFn(state, binding.set, value)).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[plastron-dom] set "${binding.set}" failed:`, err);
      });
    }
    if (binding.dispatch !== undefined) {
      const fn = state.fns.get(binding.dispatch);
      if (!fn) {
        // eslint-disable-next-line no-console
        console.error(`[plastron-dom] dispatch "${binding.dispatch}" is not registered in state.fns`);
        return;
      }
      // Third arg is the raw DOM event so handlers can extract
      // event.target.value, event.key, etc. without going through an
      // EventInfo round-trip.
      Promise.resolve(fn(state, binding.payload, event)).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[plastron-dom] dispatch "${binding.dispatch}" failed:`, err);
      });
    }
  };

const eventInfo = (event: Event): EventInfo => {
  const info: EventInfo = { type: event.type };
  const target = event.target as
    | (HTMLInputElement & { checked?: boolean })
    | null;
  if (target && "value" in target) info.value = target.value;
  if (target && typeof target.checked === "boolean") info.checked = target.checked;
  return info;
};

export const detachAllListeners = (
  node: Node,
  reg: ListenerRegistry,
): void => {
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const map = reg.get(el);
  if (map) {
    for (const [type, attached] of map) el.removeEventListener(type, attached.fn);
    reg.delete(el);
  }
  for (const child of Array.from(el.childNodes)) detachAllListeners(child, reg);
};
