import Desk from "../ui/Desk";

export const metadata = {
  // The root layout already appends the site name; repeating it here gets it twice.
  title: "Swap",
  description: "Swap against a pool that holds nothing, filled from 1inch Aqua maker wallets.",
};

export default function AppPage() {
  return <Desk />;
}
