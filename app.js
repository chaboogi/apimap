const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving";
const SEARCH_DELAY_MS = 850;
const MIN_REQUEST_GAP_MS = 1100;

const form = document.querySelector("#route-form");
const originInput = document.querySelector("#origin");
const destinationInput = document.querySelector("#destination");
const calculateButton = document.querySelector("#calculate-button");
const message = document.querySelector("#form-message");
const result = document.querySelector("#result");
const distance = document.querySelector("#distance");
const routeLabel = document.querySelector("#result-route");
const mapLink = document.querySelector("#map-link");

const fields = [originInput, destinationInput].map((input) => ({
  input,
  list: document.querySelector(`#${input.id}-results`),
  timer: null,
  controller: null,
  selected: null,
  queryVersion: 0,
}));

const geocodeCache = new Map();
let lastGeocodeRequestAt = 0;
let routeRequestVersion = 0;

function setMessage(text = "", isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function hideSuggestions(field) {
  field.list.hidden = true;
  field.input.setAttribute("aria-expanded", "false");
}

function renderSuggestions(field, places) {
  field.list.replaceChildren();

  if (!places.length) {
    const empty = document.createElement("li");
    empty.className = "suggestion-detail";
    empty.textContent = "검색 결과가 없습니다. 다른 이름으로 검색해 주세요.";
    empty.style.padding = "11px";
    field.list.append(empty);
    field.list.hidden = false;
    field.input.setAttribute("aria-expanded", "true");
    return;
  }

  for (const [index, place] of places.entries()) {
    const item = document.createElement("li");
    const option = document.createElement("button");
    const name = document.createElement("span");
    const detail = document.createElement("span");

    option.type = "button";
    option.className = "suggestion-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.id = `${field.input.id}-option-${index}`;
    name.className = "suggestion-name";
    name.textContent = place.name || place.display_name.split(",")[0];
    detail.className = "suggestion-detail";
    detail.textContent = place.display_name;
    option.append(name, detail);
    option.addEventListener("click", () => {
      field.selected = {
        name: place.name || place.display_name.split(",")[0],
        displayName: place.display_name,
        lat: Number(place.lat),
        lon: Number(place.lon),
      };
      field.input.value = field.selected.name;
      hideSuggestions(field);
      setMessage();
    });
    item.append(option);
    field.list.append(item);
  }

  field.list.hidden = false;
  field.input.setAttribute("aria-expanded", "true");
}

function cachedPlaces(query) {
  const cached = geocodeCache.get(query);
  if (cached) return cached;

  try {
    const stored = JSON.parse(localStorage.getItem(`geocode:${query}`) || "null");
    if (Array.isArray(stored)) {
      geocodeCache.set(query, stored);
      return stored;
    }
  } catch {
    // Ignore unavailable or malformed browser storage and continue with a network search.
  }

  return null;
}

function storePlaces(query, places) {
  geocodeCache.set(query, places);
  try {
    localStorage.setItem(`geocode:${query}`, JSON.stringify(places));
  } catch {
    // Geocoding still works when browser storage is disabled or full.
  }
}

async function waitForGeocodeSlot(signal) {
  const wait = Math.max(0, MIN_REQUEST_GAP_MS - (Date.now() - lastGeocodeRequestAt));
  if (!wait) return;

  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, wait);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException("Search cancelled", "AbortError"));
      },
      { once: true },
    );
  });
}

async function searchPlaces(field, query, version) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const cached = cachedPlaces(normalizedQuery);
  if (cached) {
    if (version === field.queryVersion) renderSuggestions(field, cached);
    return;
  }

  const controller = new AbortController();
  field.controller = controller;

  try {
    await waitForGeocodeSlot(controller.signal);
    if (version !== field.queryVersion) return;
    lastGeocodeRequestAt = Date.now();

    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "5");
    url.searchParams.set("accept-language", "ko,en");

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("장소 검색 서비스에 연결할 수 없습니다.");

    const places = await response.json();
    if (version !== field.queryVersion) return;
    storePlaces(normalizedQuery, places);
    renderSuggestions(field, places);
  } catch (error) {
    if (error.name === "AbortError") return;
    if (version === field.queryVersion) {
      hideSuggestions(field);
      setMessage("장소를 검색하지 못했어요. 잠시 후 다시 시도해 주세요.", true);
    }
  } finally {
    if (field.controller === controller) field.controller = null;
  }
}

function scheduleSearch(field) {
  window.clearTimeout(field.timer);
  field.controller?.abort();
  routeRequestVersion += 1;
  if (calculateButton.disabled) {
    calculateButton.disabled = false;
    calculateButton.querySelector("span").textContent = "거리 확인하기";
  }
  field.queryVersion += 1;
  field.selected = null;
  result.hidden = true;
  setMessage();

  const query = field.input.value.trim();
  if (query.length < 2) {
    hideSuggestions(field);
    return;
  }

  const version = field.queryVersion;
  field.timer = window.setTimeout(() => searchPlaces(field, query, version), SEARCH_DELAY_MS);
}

for (const field of fields) {
  field.input.addEventListener("input", () => scheduleSearch(field));
  field.input.addEventListener("focus", () => {
    if (field.input.value.trim().length >= 2 && !field.selected) scheduleSearch(field);
  });
  field.input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideSuggestions(field);
  });
  field.input.addEventListener("blur", () => {
    window.setTimeout(() => hideSuggestions(field), 120);
  });
}

document.addEventListener("click", (event) => {
  for (const field of fields) {
    if (!field.list.contains(event.target) && event.target !== field.input) {
      hideSuggestions(field);
    }
  }
});

function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters).toLocaleString("ko-KR")} m`;
  }
  const kilometers = meters / 1000;
  return `${kilometers.toLocaleString("ko-KR", {
    minimumFractionDigits: kilometers < 10 ? 1 : 0,
    maximumFractionDigits: 1,
  })} km`;
}

async function calculateRoute(start, end, requestVersion) {
  const coordinates = `${start.lon},${start.lat};${end.lon},${end.lat}`;
  const url = `${OSRM_URL}/${coordinates}?overview=false&steps=false`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("경로 검색 서비스에 연결할 수 없습니다.");

  const data = await response.json();
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error("두 장소 사이의 자동차 경로를 찾지 못했어요.");
  }
  if (requestVersion !== routeRequestVersion) return;

  distance.textContent = formatDistance(data.routes[0].distance);
  routeLabel.textContent = `${start.name} → ${end.name}`;

  const mapUrl = new URL("https://www.openstreetmap.org/directions");
  mapUrl.searchParams.set("engine", "fossgis_osrm_car");
  mapUrl.searchParams.set("route", `${start.lat},${start.lon};${end.lat},${end.lon}`);
  mapLink.href = mapUrl.toString();
  result.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const start = fields[0].selected;
  const end = fields[1].selected;

  if (!start || !end) {
    setMessage("검색 결과에서 출발지와 도착지를 각각 선택해 주세요.", true);
    if (!start) originInput.focus();
    else destinationInput.focus();
    return;
  }

  const requestVersion = ++routeRequestVersion;
  calculateButton.disabled = true;
  calculateButton.querySelector("span").textContent = "경로를 찾고 있어요";
  result.hidden = true;
  setMessage("자동차 경로를 계산하고 있어요.");

  try {
    await calculateRoute(start, end, requestVersion);
    if (requestVersion === routeRequestVersion) setMessage();
  } catch (error) {
    if (requestVersion === routeRequestVersion) {
      setMessage(`${error.message} 잠시 후 다시 시도해 주세요.`, true);
    }
  } finally {
    if (requestVersion === routeRequestVersion) {
      calculateButton.disabled = false;
      calculateButton.querySelector("span").textContent = "거리 확인하기";
    }
  }
});
