import Desk from "../ui/Desk";

export const metadata = {
  // The root layout already appends the site name; repeating it here gets it twice.
  title: "Swap",
  description: "Swap against a pool that holds nothing, filled from 1inch Aqua maker wallets.",
};

export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string; tab?: string; address?: string }>;
}) {
  const params = await searchParams;
  return <Desk initialTab={params.tab} initialChain={params.chain} initialAddress={params.address} />;
}
