import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { networkFrom } from "@/lib/networks";
import { oraclePriceUsd, oraclePriceHistory } from "@/lib/oracle";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const chainParam = searchParams.get("chain");
  const tokenParam = searchParams.get("token");

  if (!tokenParam || !isAddress(tokenParam)) {
    return NextResponse.json({ error: "missing or invalid token address" }, { status: 400 });
  }

  let net;
  try {
    net = networkFrom(chainParam);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const token = getAddress(tokenParam);
  const [quote, history] = await Promise.all([
    oraclePriceUsd(net, token).catch(() => null),
    oraclePriceHistory(net, token, 20).catch(() => null),
  ]);

  if (!quote) {
    return NextResponse.json({
      token,
      spotUsd: null,
      history: [],
      hasOracle: false,
      source: "none",
      message: "No Chainlink oracle feed configured for this token on this network",
    });
  }

  const spotUsd = Number(quote.priceUsdE18) / 1e18;
  const historyPoints = history && history.length > 0 ? history : [{ time: Number(quote.updatedAt), value: spotUsd }];

  return NextResponse.json({
    token,
    spotUsd,
    updatedAt: Number(quote.updatedAt),
    stale: quote.stale,
    history: historyPoints,
    hasOracle: true,
    source: "chainlink",
  });
}
