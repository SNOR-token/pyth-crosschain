# Pyth Network API Reference

This package contains the Next.js application that powers https://api-reference.pyth.network. It ships two main surfaces:

- An interactive explorer for all publicly supported on-chain price-feed APIs.
- A reusable React component/hook library that other apps in this monorepo can rely on for consistent UI, wallet connectivity, markdown, syntax highlighting, and chain metadata.

Use this document to understand every public API, function, and component that the app exposes, along with ready-to-run examples.

## Table of contents

1. [Local development quickstart](#local-development-quickstart)
2. [EVM price feed API catalogue](#evm-price-feed-api-catalogue)
3. [React component library](#react-component-library)
4. [Hooks and utility modules](#hooks-and-utility-modules)
5. [Network configuration helpers](#network-configuration-helpers)
6. [Extending the documentation site](#extending-the-documentation-site)

---

## Local development quickstart

```bash
pnpm install
pnpm --filter @pythnetwork/api-reference start:dev
```

Environment variables (loaded through `src/server-config.ts`) are optional for local work, but the WalletConnect Project ID, Amplitude key, and Google Analytics ID will be required in production deployments.

---

## EVM price feed API catalogue

All price-feed methods live under `src/apis/evm`. Each file exports a spec object that the `EvmApi` component can render. The `readApi` and `writeApi` helpers wrap shared metadata such as code samples and parameter definitions.

### Common usage pattern

```tsx
import { getPriceNoOlderThan } from "@/src/apis/evm";
import { EvmApi } from "@/src/components/EvmApi";

export default function Page() {
  return <EvmApi {...getPriceNoOlderThan} />;
}
```

- Read methods return `PythStructs.Price` tuples: `[price, conf, expo, publishTime]`.
- Write methods require both ABI arguments and a `value` (fee) in wei; use `getUpdateFee` to determine the minimum ETH to send.
- `updateData` payloads are fetched from Hermes (`https://hermes.pyth.network/docs/#/rest/latest_price_updates`).
- Use `parsePriceFeedUpdates*` methods when you need to verify historic updates instead of mutating on-chain price state.

### Overview table

| Method | Type | Best for |
| --- | --- | --- |
| `getPrice` *(deprecated)* | Read | Fetch the latest price if you are OK with the contract-wide freshness threshold. |
| `getPriceNoOlderThan` | Read | Fetch latest price with per-call freshness guarantee. |
| `getPriceUnsafe` | Read | Fetch last on-chain value even if stale. |
| `getEmaPrice` *(deprecated)* | Read | Historical compatibility for EMA prices. |
| `getEmaPriceNoOlderThan` | Read | EMA price with caller-supplied freshness window. |
| `getEmaPriceUnsafe` | Read | EMA price without freshness guarantee. |
| `getUpdateFee` | Read | Compute ETH fee required to submit `updateData`. |
| `getValidTimePeriod` *(deprecated)* | Read | Inspect global freshness window enforced by legacy getters. |
| `updatePriceFeeds` | Write | Push the latest price updates unconditionally (pays fee). |
| `updatePriceFeedsIfNecessary` | Write | Push updates only when local on-chain data is stale. |
| `parsePriceFeedUpdates` | Write | Parse updates within a time window without mutating contract state. |
| `parsePriceFeedUpdatesUnique` | Write | Parse the first update after a timestamp window, guaranteeing uniqueness. |

### Per-method details and examples

#### `getPriceNoOlderThan` (read)

Fetch the latest price for a feed provided the update is no older than `age` seconds.

| Param | Type | Description |
| --- | --- | --- |
| `id` | `bytes32` | Price feed ID. |
| `age` | `uint256` | Maximum acceptable staleness in seconds. |

**Errors:** `StalePrice`, `PriceFeedNotFound`

**Solidity**

```solidity
bytes32 priceId = 0xff6149...0ace;
uint256 maxAge = 60;
PythStructs.Price memory latest = pyth.getPriceNoOlderThan(priceId, maxAge);
```

**ethers.js v6**

```ts
const priceId = "0xff6149...0ace";
const maxAge = 60n;
const [price, conf, expo, publishTime] =
  await contract.getPriceNoOlderThan(priceId, maxAge);
```

#### `getPrice` (read, deprecated)

Same signature as `getPriceNoOlderThan` but relies on the contract’s default freshness window (`getValidTimePeriod`). Prefer `getPriceNoOlderThan` for explicit safety.

#### `getPriceUnsafe` (read)

Returns the last stored price regardless of staleness. Always inspect the returned `publishTime` before using it.

| Param | Type | Description |
| --- | --- | --- |
| `id` | `bytes32` | Price feed ID. |

**Solidity**

```solidity
bytes32 priceId = 0xe62df6...5b43;
PythStructs.Price memory cached = pyth.getPriceUnsafe(priceId);
require(block.timestamp - cached.publishTime < 5 minutes, "stale");
```

#### `getEmaPriceNoOlderThan` (read)

Identical to `getPriceNoOlderThan` but returns the exponentially-weighted moving average (EMA).

| Param | Type | Description |
| --- | --- | --- |
| `id` | `bytes32` | Price feed ID. |
| `age` | `uint256` | Maximum staleness. |

#### `getEmaPrice` / `getEmaPriceUnsafe` (read)

Deprecated/default-freshness and unsafe variants for EMA prices; usage mirrors the non-EMA methods above.

#### `getUpdateFee` (read)

Computes the wei fee required to submit the provided `updateData`.

| Param | Type | Description |
| --- | --- | --- |
| `updateData` | `bytes[]` | Signed price updates from Hermes. |

**JavaScript**

```ts
const updateData = [latestHermesBinary];
const feeWei = (await contract.getUpdateFee(updateData))[0];
```

Use this value as the transaction `value` when calling any write method.

#### `getValidTimePeriod` (read, deprecated)

Returns the contract-wide freshness window that legacy getters enforce. Modern integrations should set their own SLA via the `age` argument.

#### `updatePriceFeeds` (write)

Push new updates unconditionally. Fails if `updateData` is invalid or the fee is insufficient.

| Param | Type | Description |
| --- | --- | --- |
| `updateData` | `bytes[]` | Hermes price updates. |
| `fee` | `uint256` | Fee in wei (passed as `value`). |

**Solidity**

```solidity
bytes[] memory updateData = new bytes[](1);
updateData[0] = hermesPayload;
uint fee = pyth.getUpdateFee(updateData);
pyth.updatePriceFeeds{value: fee}(updateData);
```

**ethers.js**

```ts
const fee = await contract.getUpdateFee(updateData);
const tx = await contract.updatePriceFeeds(updateData, { value: fee });
await tx.wait();
```

#### `updatePriceFeedsIfNecessary` (write)

Gas-optimized variant that only applies updates if the provided `publishTimes` are newer than on-chain state.

| Param | Type | Description |
| --- | --- | --- |
| `updateData` | `bytes[]` | Hermes updates. |
| `priceId` | `bytes32[]` | IDs aligned with `publishTime`. |
| `publishTime` | `uint64[]` | Expected publish timestamps for each ID. |
| `fee` | `uint256` | Transaction value in wei. |

Errors include `NoFreshUpdate`, `InvalidUpdateData`, `InsufficientFee`.

**Solidity**

```solidity
bytes[] memory updateData = new bytes[](1);
updateData[0] = hermesPayload;

bytes32[] memory priceIds = new bytes32[](1);
priceIds[0] = feedId;

uint64[] memory publishTimes = new uint64[](1);
publishTimes[0] = latestPublishTime;

uint fee = pyth.getUpdateFee(updateData);
pyth.updatePriceFeedsIfNecessary{value: fee}(
  updateData,
  priceIds,
  publishTimes
);
```

#### `parsePriceFeedUpdates` (write)

Parses updates for a set of IDs inside a `[minPublishTime, maxPublishTime]` window. The contract does **not** store the parsed prices; instead it returns in-memory structs so you can use historic prices inside a single transaction.

| Param | Type | Description |
| --- | --- | --- |
| `updateData` | `bytes[]` | Hermes payloads. |
| `priceId` | `bytes32[]` | IDs to parse. |
| `minPublishTime` | `uint64` | Inclusive minimum. |
| `maxPublishTime` | `uint64` | Inclusive maximum. |
| `fee` | `uint256` | ETH value attached to calldata verification. |

Use when you need to enforce “price at time T” semantics without mutating storage.

**Solidity**

```solidity
bytes[] memory updateData = new bytes[](1);
updateData[0] = hermesPayload;

bytes32[] memory priceIds = new bytes32[](1);
priceIds[0] = feedId;

uint64 minPublishTime = targetTimestamp - 5;
uint64 maxPublishTime = targetTimestamp + 5;

uint fee = pyth.getUpdateFee(updateData);
PythStructs.PriceFeed[] memory prices =
  pyth.parsePriceFeedUpdates{value: fee}(
    updateData,
    priceIds,
    minPublishTime,
    maxPublishTime
  );
```

#### `parsePriceFeedUpdatesUnique` (write)

Same signature as `parsePriceFeedUpdates`, but guarantees that each returned update is the first one published after `minPublishTime`. Use when you require unique canonical prices per time window.

#### `getUpdateFee` + write-method workflow example

```ts
import { ethers } from "ethers";
import PythAbi from "@pythnetwork/pyth-sdk-solidity/abis/IPyth.json";

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(PYTH_ADDRESS, PythAbi, signer);

const updateData = [await fetchHermesPayload(feedId)];
const fee = (await contract.getUpdateFee(updateData))[0];
const tx = await contract.updatePriceFeeds(updateData, { value: fee });
await tx.wait();
```

---

## React component library

All components live under `src/components`. They are plain React components that can be imported piecemeal. Categories below summarize their purpose, props, and usage snippets.

### Layout & shell

- `Root`: Top-level layout that wires fonts, theming, syntax highlighting, wallet providers, header/footer, analytics, and accessibility helpers.

  ```tsx
  export default function RootLayout({ children }) {
    return <Root>{children}</Root>;
  }
  ```

- `Header` / `Footer`: Sticky navigation and social footer wrappers; accept standard `HTMLAttributes` for extra classes. Header embeds `ColorThemeSelector`.
- `PriceFeeds`: Two-column layout with persistent `Sidebar` and main content.
- `Home`, `ComingSoon`, `Entropy`, `NotFound`: Prebuilt marketing/placeholder screens linking to product sections.
- `MaxWidth`: Utility wrapper that constrains content width (`className="mx-auto px-8"`).

### Navigation & selection

- `Sidebar`: Chain/method navigator driven by `src/apis`. Exposes a dropdown to switch chain (defaults to `"evm"`).
- `Select`: Generic listbox component supporting grouped options, custom renderers, search, and accordion sections.
- `Accordion`, `AccordionButton`, `AccordionPanel`: Animated disclosure primitives built on Headless UI + Framer Motion.
- `NavLink`: Header-specific link that highlights the current route via `useSelectedLayoutSegment`.

### Inputs & forms

- `Button`: Polymorphic button with gradient hover effects, loading/disabled states, and optional gradient sizing.
- `Input`: Headless UI `<Field>` wrapper that renders label, helper text, and inline validation via `ErrorTooltip`.
- `ParameterInput`: Smart input used by `EvmApi` that switches between raw text entry and searchable price-feed pickers depending on `ParameterType`.
- `InlineLink`: Styled anchor (`<a>`) with brand colors.

### Feedback & overlays

- `Code`: Syntax-highlighted code block with copy-to-clipboard button and optional dimmed line ranges. Relies on `HighlighterProvider`.
- `Tooltip`: Composable headless tooltip system with trigger/content/arrow subcomponents and shared delay groups.
- `ErrorTooltip`: Opinionated tooltip preset for inline error icons.
- `Modal`: Accessible dialog with transition and `CloseButton` integration.
- `ReportAccessibility`: Conditionally loads `@axe-core/react` in non-production builds to flag accessibility issues in dev.

### Domain-specific building blocks

- `EvmProvider`: Wraps children with Wagmi, ConnectKit, TanStack Query, and theme-aware wallet UI. Accepts an optional `walletConnectProjectId`.
- `EvmApi`: Renders the entire API reference experience (markdown description, parameter form, example quick-fill links, network selector, run button, code tabs). Provide a spec from `src/apis/*`.
- `RunButton`: Handles wallet gating, wagmi `readContract`/`writeContract` invocations, result rendering, and explorer linking for each API.
- `Amplitude`: Thin component that initializes browser analytics if an API key is supplied.
- `ColorThemeSelector`: Dropdown that toggles light/dark/system themes via `next-themes`.
- `Markdown`: Wrapper around `react-markdown` wired up with custom components for headings, inline code, and fenced blocks.

Each component exports TypeScript props, so IDEs will surface the full API surface automatically.

---

## Hooks and utility modules

| Module | Description & usage |
| --- | --- |
| `src/use-price-feed-list.tsx` | Provides `PriceFeedListProvider` and `usePriceFeedList()`, which fetch the authoritative list of feeds from Pythnet, normalize IDs to hex, and expose a discriminated-union state (`Loading`, `Loaded`, `Error`). Wrap `Root` (already done) or your own tree with the provider. |
| `src/use-is-mounted.ts` | Simple hook that flips to `true` after the first client render; used to avoid SSR markup mismatches when rendering wallet data or theme controls. |
| `src/components/Code/use-highlighted-code.tsx` | Offers `HighlighterProvider` and `useHighlightedCode(language, code, dimRange)` to lazily load Shiki and memoize highlighted HTML, including dimming/decoration ranges. |
| `src/browser-logger.ts` | `getLogger()` returns a singleton Pino logger that disables output in production builds. |
| `src/zod-utils.ts` | `singletonArray(schema)` enforces Hermes responses that must return exactly one element; `safeFetch(schema, ...fetchArgs)` wraps `fetch` + `schema.parseAsync`. |
| `src/markdown-components.tsx` | Shared markdown renderers for headings, inline code, ordered/unordered lists, and code fences that delegate to the `Code` component. |
| `src/components/EvmApi/parameter.ts` | Defines `ParameterType`, placeholders, validators, and transformation helpers used across API definitions. |
| `src/components/EvmApi/run-button.tsx` | Exposes the `EvmApiType` enum plus logic to orchestrate wagmi read/write flows, error surfaces, and JSON formatting. |

---

## Network configuration helpers

- `src/evm-networks.ts` exports `getContractAddress(chainId)` and `getRpcUrl(chainId)` along with the `NETWORK_INFO` catalog covering every supported mainnet/testnet. `EvmProvider` consumes `NETWORK_IDS` to hydrate Wagmi.
- `src/server-config.ts` centralizes all runtime environment variables and enforces them in production via `demandInProduction`.
- `src/isomorphic-config.ts` exposes `IS_PRODUCTION_BUILD` for logger toggles and other shared configs.
- `src/metadata.ts` sets Open Graph, Twitter, icon, and viewport metadata for the entire site.

Whenever you add a new chain:

1. Append its entry to `NETWORK_INFO` (contract address + RPC).
2. Re-run the app so Wagmi/ConnectKit pick up the new ID.
3. Provide chain-friendly names in UI if needed.

---

## Extending the documentation site

1. **Add a new API spec**  
   - Create `src/apis/<chain>/<method>.ts[x]`.  
   - Use `readApi`/`writeApi`, define `parameters`, `summary`, `description`, and `code` samples.  
   - Export it from `src/apis/<chain>/index.ts`.

2. **Expose the route**  
   - The dynamic route `app/price-feeds/[chain]/[method]/page.tsx` uses the filename as the slug automatically; no extra wiring is needed once the spec is exported.

3. **Document supporting UI**  
   - Reuse components from `src/components`.  
   - If you create a new component or hook, add a short entry to this README so other teams know how to consume it.

4. **Ship examples**  
   - Favor dual Solidity + ethers.js snippets for parity with the existing catalogue.  
   - Use `examples` inside the spec to prefill parameters using live Hermes data where possible.

With these patterns you can keep the API explorer, reusable React primitives, and supporting utilities in sync as Pyth rolls out new products.
