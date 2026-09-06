"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createWalletClient,
  custom,
  type Address,
  type Hex,
  type EIP1193Provider,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import type { NetworkId } from "@/lib/networks";

/**
 * Wallet plumbing, deliberately small.
 *
 * viem is already a dependency and EIP-1193 is a five-method interface, so there
 * is no reason to pull in a connector framework to talk to `window.ethereum`.
 * What this does need to get right is the things that actually break in a demo:
 * a wallet on the wrong chain, an account switched under the app, and a rejected
 * signature reading as an error rather than a shrug.
 */

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export type WalletState = {
  available: boolean;
  address: Address | null;
  chainId: number | null;
  wrongChain: boolean;
  connecting: boolean;
  error: string | null;
};

/**
 * @param expected the chain the app is currently pointed at.
 *
 * This used to compare against a module constant, which was true while the app
 * only ever spoke to one network. Once the network became a thing the visitor
 * picks, that constant made a wallet correctly on Base Sepolia read as "wrong
 * chain" — and the button offered to move it to mainnet, where the router this
 * app calls does not exist.
 */
export function useWallet(expected: NetworkId) {
  const [state, setState] = useState<WalletState>({
    available: false,
    address: null,
    chainId: null,
    wrongChain: false,
    connecting: false,
    error: null,
  });

  // Only mark a provider available after mount: `window` does not exist during
  // the server render, and guessing produces a hydration mismatch.
  useEffect(() => {
    if (typeof window === "undefined" || !window.ethereum) return;
    const eth = window.ethereum;
    setState((s) => ({ ...s, available: true }));

    // Reconnect silently if this site is already authorised, but never prompt.
    void (async () => {
      try {
        const accounts = (await eth.request({ method: "eth_accounts" })) as Address[];
        const chainHex = (await eth.request({ method: "eth_chainId" })) as Hex;
        const chainId = Number(BigInt(chainHex));
        if (accounts.length > 0) {
          setState((s) => ({
            ...s,
            address: accounts[0],
            chainId,
            wrongChain: chainId !== expected,
          }));
        } else {
          setState((s) => ({ ...s, chainId, wrongChain: chainId !== expected }));
        }
      } catch {
        /* a provider that refuses to answer is the same as no provider */
      }
    })();

    const onAccounts = (accounts: unknown) => {
      const list = accounts as Address[];
      setState((s) => ({ ...s, address: list[0] ?? null, error: null }));
    };
    const onChain = (chainHex: unknown) => {
      const chainId = Number(BigInt(chainHex as Hex));
      setState((s) => ({ ...s, chainId, wrongChain: chainId !== expected }));
    };

    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [expected]);

  const connect = useCallback(async () => {
    if (typeof window === "undefined" || !window.ethereum) return;
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as Address[];
      const chainHex = (await window.ethereum.request({ method: "eth_chainId" })) as Hex;
      const chainId = Number(BigInt(chainHex));
      setState((s) => ({
        ...s,
        address: accounts[0] ?? null,
        chainId,
        wrongChain: chainId !== expected,
        connecting: false,
      }));
    } catch (e) {
      setState((s) => ({ ...s, connecting: false, error: describe(e) }));
    }
  }, [expected]);

  const switchChain = useCallback(async () => {
    if (typeof window === "undefined" || !window.ethereum) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${expected.toString(16)}` }],
      });
    } catch (e) {
      setState((s) => ({ ...s, error: describe(e) }));
    }
  }, [expected]);

  /**
   * Disconnect, as far as a page is allowed to.
   *
   * EIP-1193 has no disconnect: a site cannot make a wallet forget it, only stop
   * using what it was given. MetaMask and others implement wallet_revokePermissions
   * (EIP-2255), which genuinely drops the account permission so the next connect
   * prompts again — so ask for that first, and clear local state either way. A
   * wallet that does not support it still ends up disconnected from this app's
   * point of view, which is what the button appears to promise.
   */
  const disconnect = useCallback(async () => {
    try {
      await window.ethereum?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // unsupported, or the user dismissed it — local state is still ours to drop
    }
    setState((s) => ({ ...s, address: null, error: null }));
  }, []);

  return { ...state, connect, switchChain, disconnect };
}

/**
 * A wallet client for the chain the app is pointed at.
 *
 * This hardcoded Base, which was fine when Base was the only option and wrong
 * the moment the network became selectable: viem checks the client's chain
 * against the wallet's before it sends, so every Sepolia transaction — the whole
 * free-to-try path — would have been rejected as a mismatch.
 */
export function walletClient(chainId: NetworkId) {
  if (typeof window === "undefined" || !window.ethereum) throw new Error("no wallet");
  return createWalletClient({
    chain: chainId === 8453 ? base : baseSepolia,
    transport: custom(window.ethereum),
  });
}

/** A user closing the wallet popup is not an error worth shouting about. */
export function describe(e: unknown): string {
  const err = e as { code?: number; shortMessage?: string; message?: string };
  if (err?.code === 4001) return "cancelled in wallet";
  return err?.shortMessage ?? err?.message ?? "transaction failed";
}
