# Aquifer: Standard Indexing Schema for 1inch Aqua

Aqua stores maker balances and strategy claims in an internal mapping (`_balances`) that is non-enumerable on-chain. As 1inch notes in their documentation, no on-chain query can enumerate active makers or total what a maker has committed across multiple strategies.

Aquifer provides a standard reference index for 1inch Aqua. Rather than filtering to a specific router or frontend, it indexes protocol-wide contract events emitted by Aqua and SwapVM, establishing a shared, reusable schema that any Aqua application can adopt.

---

## 1. Schema Entities & Fields

The schema defines six core entities capturing the full lifecycle of Aqua strategies, maker commitments, and order fills:

### `Protocol`
Global singleton tracking protocol-wide metrics across all indexed Aqua applications:
- `id`: Static ID (`"1"`).
- `strategiesShipped`: Total count of strategies registered via Aqua's `Shipped` event.
- `strategiesActive`: Currently active strategies that have not been docked via `Docked`.
- `makers`: Count of unique maker addresses that have ever shipped a strategy.
- `fills`: Total number of `Swapped` events emitted by SwapVM routers.
- `fillsAgainstAqua`: Subset of fills that joined directly to an indexed Aqua strategy.

### `Maker`
Represents an individual maker address:
- `id`: Maker wallet address (`0x...`).
- `firstSeen`: Unix timestamp of the maker's first strategy registration.
- `activeStrategies`: Count of active strategies currently live for this maker.
- `totalStrategies`: Cumulative count of all strategies ever shipped by this maker.
- `fillsAsMaker`: Total number of fills executed against this maker's strategies.
- `strategies`: Derived array of all `Strategy` entities owned by this maker.
- `positions`: Derived array of aggregate `MakerTokenPosition` entities for this maker.

### `Strategy`
A single maker strategy deployed through an Aqua router:
- `id`: Composite identifier (`${app}-${strategyHash}`).
- `maker`: Foreign key to the owning `Maker`.
- `app`: Address of the application/router contract through which the strategy was shipped.
- `strategyHash`: Unique strategy hash computed and emitted by Aqua.
- `strategy`: Raw `abi.encode(Order)` calldata. Replayable and identical to the bytes passed to SwapVM.
- `active`: Boolean flag indicating if the strategy is currently fillable.
- `shippedAt`: Unix timestamp when the strategy was shipped.
- `shippedTx`: Transaction hash of the `ship()` call.
- `dockedAt`: Unix timestamp when the strategy was docked (null if still active).
- `tokens`: Array of token addresses referenced by this strategy.
- `commitments`: Derived array of per-token `Commitment` entities.
- `fills`: Derived array of `Fill` records executed against this strategy.

### `Commitment`
Virtual balance tracking for an individual token within a specific strategy:
- `id`: Composite identifier (`${app}-${strategyHash}-${token}`).
- `strategy`: Foreign key to the parent `Strategy`.
- `maker`: Foreign key to the owning `Maker`.
- `token`: Token contract address.
- `remaining`: Current virtual balance credited to this strategy in Aqua.
- `totalPushed`: Cumulative token amount pushed into this strategy (initial push + top-ups).
- `totalPulled`: Cumulative token amount pulled from this strategy by fills.

### `MakerTokenPosition`
**The aggregate metric that only an indexer can compute.** Totals one maker's commitment of a specific token across all of their live strategies:
- `id`: Composite identifier (`${maker}-${token}`).
- `maker`: Foreign key to the owning `Maker`.
- `token`: Token contract address.
- `totalCommitted`: Sum of `remaining` virtual balances across all active strategies for this maker and token.
- `activeStrategies`: Number of active strategies contributing to this aggregate commitment.
- `updatedAt`: Block timestamp of the most recent push, pull, or dock affecting this position.

Comparing `totalCommitted` against the maker's actual wallet balance and allowance yields the maker's true whole-book coverage ratio.

### `Fill`
Individual swap execution joined between SwapVM and Aqua:
- `id`: Unique event identifier (`${txHash}-${logIndex}`).
- `strategy`: Foreign key to the matched `Strategy` (null if fill was outside indexed strategies).
- `orderHash`: Order hash emitted by SwapVM's `Swapped` event.
- `maker`: Maker address receiving/delivering tokens.
- `taker`: Swapper/router executing the trade.
- `tokenIn`: Input token address.
- `tokenOut`: Output token address.
- `amountIn`: Raw input token amount.
- `amountOut`: Raw output token amount.
- `againstAqua`: Boolean flag indicating if `orderHash` matched an indexed Aqua strategy.
- `blockNumber`: Block number of the execution.
- `timestamp`: Unix timestamp of the transaction.
- `txHash`: Transaction hash.

---

## 2. The Join Key

Per 1inch's official documentation:

$$\text{Swapped}.\text{orderHash} == \text{Shipped}.\text{strategyHash}$$

When an order executes via SwapVM, the router emits `Swapped(bytes32 orderHash, ...)`. Aqua emits `Shipped(address indexed app, bytes32 indexed strategyHash, address indexed maker, bytes strategy)`. The subgraph matches `orderHash` to `strategyHash` to connect fills back to their parent strategies, updating remaining commitments and fill history.

---

## 3. Evidence of Generalization Across Independent Apps

Aquifer indexes Aqua's core protocol events rather than filtering by router or app address. As a result, a single deployment of this schema indexes every Aqua application on the chain simultaneously.

### Live Proof on Base Mainnet

Querying the live endpoint `/api/apps?chain=8453` queries the deployed Aquifer subgraph (`v0.0.3`) and breaks down strategies by router contract:

```bash
curl -s "http://localhost:3000/api/apps?chain=8453"
```

Live output:
```json
{
  "available": true,
  "apps": [
    {
      "app": "0x111111338c5091e8440b67b168bae16a668ac0de",
      "isOurs": true,
      "activeStrategies": 131,
      "distinctMakers": 57
    },
    {
      "app": "0x1111113db0e0ef9d0e3a50d5f094a3a57a26c0de",
      "isOurs": false,
      "activeStrategies": 1,
      "distinctMakers": 1
    }
  ]
}
```

The schema indexes:
1. `0x111111338c5091e8440b67b168bae16a668ac0de`: 1inch's canonical router deployment (131 active strategies across 57 makers).
2. `0x1111113db0e0ef9d0e3a50d5f094a3a57a26c0de`: An independent application router (1 active strategy, 1 maker).

Both are captured by the identical indexer logic without configuration changes or custom handlers.

### How to Re-run the Underlying GraphQL Query

Run against `https://api.studio.thegraph.com/query/1758723/aquifer/v0.0.3`:

```graphql
query ActiveApps {
  strategies(where: { active: true }, first: 1000) {
    app
    maker {
      id
    }
  }
}
```

---

## 4. How Another Aqua App Adopts This Schema

Adopting Aquifer requires zero schema modifications:
1. **Reuse `schema.graphql` directly**: The entity model is complete and agnostic to specific router implementations.
2. **Update network configuration in `subgraph.yaml`**: Set the target network (`base`, `mainnet`, `arbitrum-one`, etc.) and the starting block of Aqua's deployment on that chain.
3. **Deploy**: Deploy to Subgraph Studio or The Graph Network.

Because commitments and wallet balances are decoupled in the schema, applications can compose Aquifer with Token API (for off-chain wallet balance lookups) and RPC multicalls (for token allowances) without altering the indexer.
