"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { useState } from "react";
import { WagmiProvider, createConfig, http, fallback } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, lightTheme, connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  metaMaskWallet,
  coinbaseWallet,
  rainbowWallet,
  injectedWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { NETWORKS } from "@/lib/networks";

/**
 * Wallet plumbing, done properly.
 *
 * The hand-rolled EIP-1193 hook this replaces could connect and could clear its
 * own state, but "disconnect" only ever meant "stop looking at the account" —
 * there was no wallet picker, no mobile path, and no way back to a genuinely
 * disconnected state that survived a reload. wagmi owns the connection and
 * RainbowKit owns the modal, so all of that is somebody else's solved problem.
 *
 * The wallet list has to come from RainbowKit's own definitions, not raw wagmi
 * connectors: given plain connectors the modal opens with nothing in it, which
 * is a worse first impression than the button it replaced.
 *
 * WalletConnect is included only when a project id is configured — without one
 * it throws at startup, and a missing environment variable should cost mobile
 * wallets, not the whole page.
 */
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_ID ?? "";

const transportFor = (id: 8453 | 84532) => {
  const n = NETWORKS[id];
  return fallback(
    [n.rpc, ...n.rpcFallbacks].map((url) => http(url, { retryCount: 2, retryDelay: 220 }))
  );
};

const connectors = connectorsForWallets(
  [
    {
      groupName: "Popular",
      wallets: [
        metaMaskWallet,
        rainbowWallet,
        coinbaseWallet,
        ...(projectId ? [walletConnectWallet] : []),
      ],
    },
    { groupName: "Other", wallets: [injectedWallet] },
  ],
  { appName: "Bone Dry", projectId: projectId || "bone-dry-local" }
);

const config = createConfig({
  chains: [baseSepolia, base],
  connectors,
  transports: {
    [baseSepolia.id]: transportFor(84532),
    [base.id]: transportFor(8453),
  },
  ssr: true,
});

export default function Web3({ children }: { children: React.ReactNode }) {
  // One client per mount, not per render — a new QueryClient every render throws
  // away every cache it just built.
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          modalSize="compact"
          initialChain={baseSepolia}
          theme={lightTheme({
            accentColor: "#1b1b1a",
            accentColorForeground: "#fbfaf6",
            borderRadius: "none",
            fontStack: "system",
            overlayBlur: "small",
          })}
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
