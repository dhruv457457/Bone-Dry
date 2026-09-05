import Desk from "./ui/Desk";
import { HOOK, USDC, WETH, TOKENS } from "@/lib/chain";

export default function Home() {
  const usdc = TOKENS[USDC.toLowerCase()];
  const weth = TOKENS[WETH.toLowerCase()];
  return <Desk tokens={{ usdc, weth }} hook={HOOK} />;
}
