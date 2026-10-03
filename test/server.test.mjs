import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server.mjs";

async function withServer(fetchImpl, run) {
  const server = createServer({ fetchImpl });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("health endpoint identifies pilot and unconfigured pricing", async () => {
  await withServer(fetch, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      pricing: "unavailable",
      pilotArea: "Bielefeld, Germany"
    });
  });
});

test("compare returns nearby supermarket data and never invents prices", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("nominatim.openstreetmap.org")) {
      return Response.json([{ lat: "52.0302", lon: "8.5325" }]);
    }
    return Response.json({
      elements: [
        {
          type: "node",
          id: 10,
          lat: 52.031,
          lon: 8.533,
          tags: { shop: "supermarket", name: "Pilot Markt", brand: "Example", "addr:street": "Testweg", "addr:housenumber": "2" }
        },
        { type: "node", id: 11, lat: 52.1, lon: 8.6, tags: { shop: "supermarket", name: "Too far away" } },
        { type: "node", id: 12, lat: 52.03, lon: 8.53, tags: { shop: "supermarket" } }
      ]
    });
  };

  await withServer(fetchImpl, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/compare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: ["2 Bananas"], location: "Bielefeld" })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.stores.length, 1);
    assert.equal(payload.stores[0].name, "Pilot Markt");
    assert.equal(payload.stores[0].address, "Testweg 2");
    assert.equal(payload.stores[0].prices[0].requested, "2 Bananas");
    assert.equal(payload.stores[0].prices[0].amountCents, null);
    assert.equal(payload.stores[0].prices[0].status, "unavailable");
    assert.equal(payload.pricing.status, "unavailable");
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /countrycodes=de/);
    assert.doesNotMatch(calls[0].url, /Bananas/);
    assert.match(calls[1].options.body, /shop/);
  });
});

test("compare accepts GPS coordinates without geocoding", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ elements: [] });
  };
  await withServer(fetchImpl, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/compare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: ["Coffee"],
        location: "52.03, 8.53",
        coordinates: { latitude: 52.03, longitude: 8.53, accuracy: 10 }
      })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.center, { latitude: 52.03, longitude: 8.53 });
    assert.equal(calls, 1);
  });
});

test("invalid shopping lists and coordinates are rejected", async () => {
  await withServer(fetch, async (baseUrl) => {
    for (const body of [
      { items: [], location: "Bielefeld" },
      { items: ["Coffee"], location: "Bielefeld", coordinates: { latitude: 92, longitude: 8 } }
    ]) {
      const response = await fetch(`${baseUrl}/api/compare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, "string");
    }
  });
});
