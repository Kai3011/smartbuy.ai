export class UnconfiguredPriceProvider {
  async quoteBasket(items, stores) {
    return stores.map((store) => ({
      ...store,
      prices: items.map((requested) => ({
        requested,
        amountCents: null,
        status: "unavailable",
        reason: "No authorized retailer price feed is configured."
      }))
    }));
  }
}
