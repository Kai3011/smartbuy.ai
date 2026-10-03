# SmartBuy.ai Bielefeld pilot

SmartBuy.ai currently has a Node.js backend foundation for searching nearby supermarket branches in the Bielefeld pilot area. It uses OpenStreetMap's Nominatim service to geocode typed locations and the Overpass API to find mapped supermarkets. Browser GPS coordinates can be used directly, so they skip geocoding.

## Run locally

Requirements: Node.js 20 or newer.

```sh
npm start
```

Open <http://127.0.0.1:3000>. Do not open `index.html` directly or use GitHub Pages for the live nearby-store search; those static origins do not host this backend. A Node-capable host is required for deployment.

## API

- `GET /api/health` reports server status and whether product pricing is configured.
- `POST /api/compare` accepts a shopping list and location:

```json
{
  "items": ["5 Bananas", "1 Coffee"],
  "location": "Bielefeld, Germany",
  "coordinates": null,
  "radiusMeters": 5000
}
```

`coordinates` can instead be `{ "latitude": 52.03, "longitude": 8.53 }`; `radiusMeters` is optional and limited to 500–20,000 metres. The API returns nearby supermarket branches and explicitly marks each price as unavailable.

The shopping-list items are processed by this backend and are not included in requests to OpenStreetMap. Typed location queries are sent to Nominatim; coordinates are sent to Overpass to search around that point. Map data is cached in memory temporarily, and geocoding results are cached for 24 hours. The UI includes OpenStreetMap attribution.

## Prices are not live yet

No retailer price API/feed is configured. `price-provider.mjs` is the integration seam for a future authorized provider. Until one is connected, the app must not show demo prices as if they were current; it shows nearby branches while clearly labelling prices unavailable. Product matching, live offers, stock, and branch-specific prices still need a data source and implementation.

Before deploying publicly, add appropriate request throttling, monitoring, and hosting configuration, and confirm the chosen OpenStreetMap services' usage policies. GitHub Pages can continue to host a static mockup, but it cannot run this Node backend.
