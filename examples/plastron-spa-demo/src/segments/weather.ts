import type { Fn, LambdaKey, State } from "../../../../plastron/src/types/index.js";
import { el, type VNode } from "../../../../segments/plastron-dom/src/index.js";
import type { SegmentBundle } from "./counter.js";

// ========================================================================
// Weather segment.
//
// Two primitive cels (weatherCity, weatherData) and one render lambda.
// All actions live in dispatch handlers:
//
//   weather:setCity — onInput. Reads event.target.value (3rd arg from
//                     the painter), writes weatherCity.
//   weather:fetch   — onClick. Reads weatherCity, fires the async
//                     Open-Meteo lookup, writes intermediate
//                     "loading" state and final result back into
//                     weatherData via setFn.
//
// No side-effecting lambda. No closure-tracked event refs. The render
// lambda is pure (data → VNode).
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

const renderWeather: Fn = ({ city, data }: { city: string; data: WeatherData }): VNode => {
  let resultNode: VNode;
  if (data.state === "idle") {
    resultNode = el("p", { class: "result idle" }, "Type a city and click Fetch.");
  } else if (data.state === "loading") {
    resultNode = el("p", { class: "result loading" }, `Loading ${data.city}…`);
  } else if (data.state === "error") {
    resultNode = el("p", { class: "result error" }, `Error: ${data.message}`);
  } else {
    resultNode = el("p", { class: "result ok" },
      el("strong", null, `${data.city}, ${data.country}`),
      ` — ${data.temperatureC.toFixed(1)} °C, ${codeToText(data.weatherCode)}`,
    );
  }

  return el("section", { class: "weather" },
    el("h2", null, "Weather"),
    el("div", { class: "row" },
      el("input", {
        type: "text",
        placeholder: "City",
        value: city,
        onInput: { dispatch: "weather:setCity" },
      }),
      el("button", { onClick: { dispatch: "weather:fetch" } }, "Fetch"),
    ),
    resultNode,
  );
};

const setCity: Fn = async (...args: unknown[]) => {
  const [state, , event] = args as [State, unknown, Event];
  const target = event?.target as { value?: string } | null;
  const value = target?.value ?? "";
  await (state.fns.get("set") as Fn)(state, "weatherCity", value);
};

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
      { key: "weatherCity", v: DEFAULT_CITY, segment: "weather" },
      { key: "weatherData", v: { state: "idle" } as WeatherData, segment: "weather" },
      {
        key: "weatherTree",
        l: "weather:render",
        inputMap: { city: "weatherCity", data: "weatherData" },
        segment: "weather",
      },
    ],
  },
  fns: new Map<LambdaKey, Fn>([
    ["weather:render",  renderWeather],
    ["weather:setCity", setCity],
    ["weather:fetch",   fetchAction],
  ]),
};
