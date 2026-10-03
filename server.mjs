import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { UnconfiguredPriceProvider } from "./price-provider.mjs";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_RADIUS_METERS = 5000;
const MAX_RADIUS_METERS = 20000;
const MAX_BODY_BYTES = 16 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();
const priceProvider = new UnconfiguredPriceProvider();
let nominatimQueue = Promise.resolve();
let lastNominatimRequestAt = 0;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "Provide a JSON object with items and a location.");
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
    throw new ApiError(400, "Provide between 1 and 100 shopping-list items.");
  }
  if (body.items.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
    throw new ApiError(400, "Each shopping-list item must be a non-empty string up to 200 characters.");
  }
  const location = body.location;
  if (typeof location !== "string" || !location.trim() || location.length > 200) {
    throw new ApiError(400, "Provide a location as a non-empty string up to 200 characters.");
  }
  const coordinates = body.coordinates;
  if (coordinates !== undefined && coordinates !== null) {
    const { latitude, longitude } = coordinates;
    if (
      !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    ) {
      throw new ApiError(400, "Coordinates must include a valid latitude and longitude.");
    }
  }
  const radiusMeters = body.radiusMeters ?? DEFAULT_RADIUS_METERS;
  if (!Number.isInteger(radiusMeters) || radiusMeters < 500 || radiusMeters > MAX_RADIUS_METERS) {
    throw new ApiError(400, `radiusMeters must be between 500 and ${MAX_RADIUS_METERS}.`);
  }
  return {
    items: body.items.map((item) => item.trim()),
    location: location.trim(),
    coordinates,
    radiusMeters
  };
}

async function fetchJson(fetchImpl, url, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(15000),
      headers: {
        "user-agent": "SmartBuy.ai Bielefeld pilot/0.1 (OpenStreetMap location lookup)",
        ...options.headers
      }
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new ApiError(504, "The map data service took too long to respond. Please try again.");
    }
    throw new ApiError(502, "The map data service could not be reached. Please try again later.");
  }
  if (!response.ok) {
    throw new ApiError(502, "The map data service returned an error. Please try again later.");
  }
  try {
    return await response.json();
  } catch {
    throw new ApiError(502, "The map data service returned an invalid response.");
  }
}

async function geocode(fetchImpl, location, coordinates) {
  if (coordinates) {
    return { latitude: coordinates.latitude, longitude: coordinates.longitude };
  }
  const key = `geocode:${location.toLocaleLowerCase("de-DE")}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({
    format: "jsonv2",
    limit: "1",
    countrycodes: "de",
    q: location
  }).toString();
  const request = nominatimQueue.then(async () => {
    const delay = Math.max(0, 1000 - (Date.now() - lastNominatimRequestAt));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastNominatimRequestAt = Date.now();
    return fetchJson(fetchImpl, url);
  });
  nominatimQueue = request.then(() => undefined, () => undefined);
  const results = await request;
  if (!Array.isArray(results) || !results.length) {
    throw new ApiError(404, "We could not find that location in Germany. Try a city or postal code.");
  }
  const latitude = Number(results[0].lat);
  const longitude = Number(results[0].lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new ApiError(502, "The map data service returned invalid coordinates.");
  }
  const value = { latitude, longitude };
  cache.set(key, { value, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  return value;
}

function distanceMeters(from, to) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function addressFromTags(tags) {
  const street = [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" ");
  const city = tags["addr:city"] || tags["addr:town"] || tags["addr:village"];
  return [
    street,
    [tags["addr:postcode"], city].filter(Boolean).join(" ")
  ].filter(Boolean).join(", ");
}

function normalizeStore(element, origin) {
  const tags = element.tags || {};
  const latitude = Number(element.lat ?? element.center?.lat);
  const longitude = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const name = tags.name || tags.brand || tags.operator;
  if (!name) return null;
  const distance = Math.round(distanceMeters(origin, { latitude, longitude }));
  return {
    id: `osm-${element.type}-${element.id}`,
    name,
    brand: tags.brand || tags.name || name,
    address: addressFromTags(tags),
    latitude,
    longitude,
    distanceMeters: distance,
    mapsUrl: `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=18/${latitude}/${longitude}`,
    source: "OpenStreetMap",
    priceStatus: "unavailable"
  };
}

async function findNearbyStores(fetchImpl, origin, radiusMeters) {
  const key = `stores:${origin.latitude.toFixed(5)}:${origin.longitude.toFixed(5)}:${radiusMeters}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const query = `[out:json][timeout:20];(node["shop"="supermarket"](around:${radiusMeters},${origin.latitude},${origin.longitude});way["shop"="supermarket"](around:${radiusMeters},${origin.latitude},${origin.longitude});relation["shop"="supermarket"](around:${radiusMeters},${origin.latitude},${origin.longitude}););out center tags;`;
  const url = process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
  const response = await fetchJson(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }).toString()
  });
  if (!Array.isArray(response.elements)) {
    throw new ApiError(502, "The map data service returned invalid supermarket data.");
  }
  const stores = response.elements
    .map((element) => normalizeStore(element, origin))
    .filter((store) => store && store.distanceMeters <= radiusMeters)
    .sort((left, right) => left.distanceMeters - right.distanceMeters)
    .slice(0, 50);
  cache.set(key, { value: stores, expiresAt: Date.now() + CACHE_TTL_MS });
  return stores;
}

async function compare(fetchImpl, body) {
  const request = validateRequest(body);
  const origin = await geocode(fetchImpl, request.location, request.coordinates);
  const nearbyStores = await findNearbyStores(fetchImpl, origin, request.radiusMeters);
  const stores = await priceProvider.quoteBasket(request.items, nearbyStores);
  return {
    location: request.location,
    center: origin,
    radiusMeters: request.radiusMeters,
    items: request.items.map((item) => ({ requested: item, priceStatus: "unavailable" })),
    stores,
    pricing: {
      status: "unavailable",
      message: "Nearby branches are sourced from OpenStreetMap. Current retailer prices are not connected yet."
    },
    attribution: "Map data © OpenStreetMap contributors"
  };
}

export function createServer({ fetchImpl = fetch } = {}) {
  return createHttpServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(response, 200, { status: "ok", pricing: "unavailable", pilotArea: "Bielefeld, Germany" });
      }
      if (request.method === "POST" && url.pathname === "/api/compare") {
        const result = await compare(fetchImpl, await readJson(request));
        return json(response, 200, result);
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = await readFile(resolve(projectRoot, "index.html"));
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff"
        });
        return response.end(html);
      }
      return json(response, 404, { error: "Not found." });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const message = error instanceof ApiError ? error.message : "The server could not complete the request.";
      if (!(error instanceof ApiError)) console.error("Unhandled API request error:", error);
      return json(response, status, { error: message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createServer();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`SmartBuy pilot listening at http://${host}:${port}`);
  });
}
