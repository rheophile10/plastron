import { useEffect, useState, type CSSProperties } from "react";
import type { Cel, Fn, State } from "../../../../plastron/src/index.js";

// Minimal cel editor — lists every cel in the article's "article"
// segment with an editable input for value cels and read-only display
// for computed cels (those with l + inputMap).
//
// This is a simplified stand-in for full plastron-sheet integration.
// plastron-sheet's grid model (A1-style addresses, formula bar) would
// need adapter code to display arbitrary keyed cels meaningfully;
// promoting from this minimal view to the real sheet is a v2 task.
//
// Subscribes to state changes by hooking into runCycle's downstream
// updates: each cel renders its current value via input.get; the row
// re-renders on save or any explicit edit. Polling-free; we just bump
// a tick whenever the user writes through the input.

export const CelEditor = ({ state }: { state: State }): React.ReactElement => {
  const [tick, setTick] = useState(0);
  const cels: Cel[] = [];
  for (const cel of state.cels.values()) {
    if (cel.segment !== "article") continue;
    cels.push(cel);
  }
  // Stable order: variable cels first, then computed.
  cels.sort((a, b) => {
    if (!!a.l === !!b.l) return a.key.localeCompare(b.key);
    return a.l ? 1 : -1;
  });

  // After any external change to state.cels (rare in this demo —
  // saves don't mutate the in-memory state), the keys list could be
  // stale. tick increments on every edit; the listing above runs
  // every render, so we don't need to track cels in React state.
  useEffect(() => { /* tick used to force re-render */ void tick; }, [tick]);

  const onEditValue = async (key: string, raw: string) => {
    const setFn = state.fns.get("set") as Fn;
    await setFn(state, key, raw);
    setTick((t) => t + 1);
  };

  return (
    <div className="cel-editor">
      {cels.map((cel) => (
        <CelRow key={cel.key} state={state} cel={cel} onEdit={onEditValue} tick={tick} />
      ))}
    </div>
  );
};

const rowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "8em 1fr",
  gap: "0.5em",
  alignItems: "baseline",
  padding: "0.25em 0",
};

const CelRow = ({ state, cel, onEdit, tick }: {
  state: State;
  cel: Cel;
  onEdit: (key: string, raw: string) => void;
  tick: number;
}): React.ReactElement => {
  // Read live via input.get so each render reflects the cascade's
  // current value (including computed cels updated by upstream edits).
  void tick;
  const getFn = state.fns.get("get") as Fn;
  const value = getFn(state, cel.key);
  const isComputed = !!cel.l && !cel.f && !cel.ref;
  const isFormula = !!cel.f;

  return (
    <div style={rowStyle} className="cel-row">
      <code className="cel-key">{cel.key}</code>
      {isFormula ? (
        <div>
          <code className="cel-formula">{cel.f}</code>
          <span className="cel-value-readout">→ {String(value)}</span>
        </div>
      ) : isComputed ? (
        <span className="cel-readout">
          {String(value)}
          <span className="cel-meta"> (computed by {cel.l})</span>
        </span>
      ) : (
        <input
          type="text"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onEdit(cel.key, e.currentTarget.value)}
        />
      )}
    </div>
  );
};
