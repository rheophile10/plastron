import type { Fn, LambdaKey, State } from "../../../../plastron/src/types/index.js";
import type { SegmentBundle } from "./counter.js";

// ========================================================================
// Weather segment — formula-driven render, action lambdas in JS.
//
// Render tree composed entirely from formulas referencing dom-builders
// (el, h2, p, div, input, button, strong, obj, onSet, onDispatch,
// concat, ifx, eq).
//
// Async actions (setCity, fetchAction) stay as JS lambdas — formulas
// aren't the right shape for fetch + await + multi-step state mutation.
// They're referenced by name in the render formulas via onDispatch.
//
// State branching uses (ifx (eq state "ok") okNode (ifx (eq state
// "loading") loadingNode …)). Both branches evaluate (no short-
// circuiting) but the cost is just building two vnode subtrees, which
// is fine.
// ========================================================================

const DEFAULT_CITY = "Berlin";

interface WeatherIdle    { state: "idle" }
interface WeatherLoading { state: "loading"; city: string }
interface WeatherOk      { state: "ok"; city: string; country: string; temperatureC: number; weatherCode: number }
interface WeatherError   { state: "error"; message: string }
type WeatherData = WeatherIdle | WeatherLoading | WeatherOk | WeatherError;

const fetchWeather = async (city: string): Promise<WeatherData> => {
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
  );
  if (!geo.ok) return { state: "error", message: `geocode HTTP ${geo.status}` };
  const geoData = await geo.json() as {
    results?: Array<{ name: string; country: string; latitude: number; longitude: number }>;
  };
  const place = geoData.results?.[0];
  if (!place) return { state: "error", message: `Unknown city: ${city}` };

  const fc = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}` +
    `&longitude=${place.longitude}&current=temperature_2m,weather_code`,
  );
  if (!fc.ok) return { state: "error", message: `forecast HTTP ${fc.status}` };
  const fcData = await fc.json() as {
    current?: { temperature_2m?: number; weather_code?: number };
  };
  const c = fcData.current;
  if (!c || typeof c.temperature_2m !== "number") {
    return { state: "error", message: "Forecast response missing fields" };
  }
  return {
    state: "ok",
    city: place.name,
    country: place.country,
    temperatureC: c.temperature_2m,
    weatherCode: c.weather_code ?? 0,
  };
};

const codeToText = (code: number): string => {
  if (code === 0) return "clear";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 67) return "rainy";
  if (code <= 77) return "snowy";
  if (code <= 82) return "showers";
  if (code <= 99) return "thunderstorms";
  return "unknown";
};

// Helpers exposed as cel values so the render formulas can pluck
// fields from the WeatherData record. The formula language has no
// property access; these stand in.
const weatherStateOf = (d: WeatherData): string => d.state;
const weatherCityOf  = (d: WeatherData): string =>
  d.state === "ok" ? d.city : d.state === "loading" ? d.city : "";
const weatherCountryOf = (d: WeatherData): string => d.state === "ok" ? d.country : "";
const weatherTempOf  = (d: WeatherData): string =>
  d.state === "ok" ? d.temperatureC.toFixed(1) : "";
const weatherCondOf  = (d: WeatherData): string =>
  d.state === "ok" ? codeToText(d.weatherCode) : "";
const weatherErrorOf = (d: WeatherData): string => d.state === "error" ? d.message : "";

// Async action lambdas — referenced by name from formulas.
const fetchAction: Fn = async (...args: unknown[]) => {
  const [state] = args as [State];
  const setFn = state.fns.get("set") as Fn;
  const city = ((state.cels.get("weatherCity")?.v as string | undefined) ?? "").trim();
  if (!city) {
    await setFn(state, "weatherData", { state: "idle" } satisfies WeatherIdle);
    return;
  }
  await setFn(state, "weatherData", { state: "loading", city } satisfies WeatherLoading);
  try {
    const result = await fetchWeather(city);
    await setFn(state, "weatherData", result);
  } catch (err) {
    await setFn(state, "weatherData", {
      state: "error",
      message: err instanceof Error ? err.message : String(err),
    } satisfies WeatherError);
  }
};

export const weatherSegment: SegmentBundle = {
  segment: {
    key: "weather",
    cels: [
      // Data
      { key: "weatherCity", v: DEFAULT_CITY, segment: "weather" },
      { key: "weatherData", v: { state: "idle" } as WeatherData, segment: "weather" },
      // Selectors over WeatherData (function values for formula access)
      { key: "weatherStateOf",   v: weatherStateOf,   segment: "weather" },
      { key: "weatherCityOf",    v: weatherCityOf,    segment: "weather" },
      { key: "weatherCountryOf", v: weatherCountryOf, segment: "weather" },
      { key: "weatherTempOf",    v: weatherTempOf,    segment: "weather" },
      { key: "weatherCondOf",    v: weatherCondOf,    segment: "weather" },
      { key: "weatherErrorOf",   v: weatherErrorOf,   segment: "weather" },
      // Derived state
      { key: "weatherState",   l: "f", f: "(weatherStateOf weatherData)",          segment: "weather" },
      { key: "weatherCityNow", l: "f", f: "(weatherCityOf  weatherData)",          segment: "weather" },
      { key: "weatherTemp",    l: "f", f: "(weatherTempOf  weatherData)",          segment: "weather" },
      { key: "weatherCond",    l: "f", f: "(weatherCondOf  weatherData)",          segment: "weather" },
      { key: "weatherCountry", l: "f", f: "(weatherCountryOf weatherData)",        segment: "weather" },
      { key: "weatherErr",     l: "f", f: "(weatherErrorOf  weatherData)",         segment: "weather" },
      // Per-state result-paragraph subtrees
      {
        key: "resultIdle",
        l: "f",
        f: '(dom "p" (obj "class" "result idle") "Type a city and click Fetch.")',
        segment: "weather",
      },
      {
        key: "resultLoadingText",
        l: "f",
        f: '(concat "Loading " weatherCityNow "…")',
        segment: "weather",
      },
      {
        key: "resultLoading",
        l: "f",
        f: '(dom "p" (obj "class" "result loading") resultLoadingText)',
        segment: "weather",
      },
      {
        key: "resultErrorText",
        l: "f",
        f: '(concat "Error: " weatherErr)',
        segment: "weather",
      },
      {
        key: "resultError",
        l: "f",
        f: '(dom "p" (obj "class" "result error") resultErrorText)',
        segment: "weather",
      },
      {
        key: "resultOkLocation",
        l: "f",
        f: '(dom "strong" null (concat weatherCityNow ", " weatherCountry))',
        segment: "weather",
      },
      {
        key: "resultOkSuffix",
        l: "f",
        f: '(concat " — " weatherTemp " °C, " weatherCond)',
        segment: "weather",
      },
      {
        key: "resultOk",
        l: "f",
        f: '(dom "p" (obj "class" "result ok") resultOkLocation resultOkSuffix)',
        segment: "weather",
      },
      // Branch on weatherState. Both branches evaluate; only the
      // selected one ends up in the rendered tree.
      {
        key: "resultNode",
        l: "f",
        f: '(ifx (eq weatherState "ok") resultOk ' +
              '(ifx (eq weatherState "loading") resultLoading ' +
                '(ifx (eq weatherState "error") resultError resultIdle)))',
        segment: "weather",
      },
      // Input row
      {
        key: "weatherInput",
        l: "f",
        // bindValue ⇒ `{ set: "weatherCity", extract: "value" }`. Writes the
        // input's actual text to the cel on each `input` event. Replaces an
        // earlier `(onSet "weatherCity")` that silently wrote the EventInfo
        // record (the kernel's no-value-no-extract fallback) instead of the
        // typed text — latent bug the helper closes by construction.
        f: '(dom "input" (obj "type" "text" "placeholder" "City" "value" weatherCity ' +
                            '"onInput" (bindValue "weatherCity")))',
        segment: "weather",
      },
      {
        key: "weatherButton",
        l: "f",
        f: '(dom "button" (obj "onClick" (onDispatch "weather:fetch")) "Fetch")',
        segment: "weather",
      },
      {
        key: "weatherRow",
        l: "f",
        f: '(dom "div" (obj "class" "row") weatherInput weatherButton)',
        segment: "weather",
      },
      {
        key: "weatherTitle",
        l: "f",
        f: '(dom "h2" null "Weather")',
        segment: "weather",
      },
      // Composed tree — section title + input row + result.
      {
        key: "weatherTree",
        l: "f",
        f: '(dom "section" (obj "class" "weather") weatherTitle weatherRow resultNode)',
        segment: "weather",
      },
    ],
  },
  fns: new Map<LambdaKey, Fn>([
    ["weather:fetch", fetchAction],
  ]),
};
