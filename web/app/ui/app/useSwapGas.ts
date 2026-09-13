"use client";

import { useEffect, useState } from "react";
import { NETWORKS, publicClientFor, type NetworkId } from "@/lib/networks";

/** Gas a Bone Dry swap uses, measured: 488,439 on Base (tx 0xe29c843d, two fills and a
 *  refusal) and 681,970-722,030 on Ethereum fork runs through the live hooks. The upper
 *  figure is used so the estimate errs high. */
export const SWAP_GAS = 700_000n;

/** A swap's gas cost on a chain, from that chain's current gas price. Replaces
 *  hardcoded "$1.80" / "<$0.01" labels that were never measured. */
export function useSwapGas(chainId: NetworkId) {
  const [label, setLabel] = useState<string>("gas: reading…");
  useEffect(() => {
    let live = true;
    const n = NETWORKS[chainId];
    if (!n) return;
    publicClientFor(n)
      .getGasPrice()
      .then((wei) => {
        if (!live) return;
        const costWei = wei * SWAP_GAS;
        const eth = Number(costWei) / 1e18;
        const gwei = Number(wei) / 1e9;
        setLabel(`swap gas ≈ ${eth < 0.000001 ? "<0.000001" : eth.toFixed(6)} ETH at ${gwei < 0.01 ? gwei.toFixed(4) : gwei.toFixed(3)} gwei`);
      })
      .catch(() => live && setLabel("gas: unavailable"));
    return () => {
      live = false;
    };
  }, [chainId]);
  return label;
}
