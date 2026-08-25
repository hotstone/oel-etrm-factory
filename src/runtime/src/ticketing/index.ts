import type { TargetRepo } from "../targets.js";
import { LinearProvider } from "./linear-provider.js";
import type { TicketProvider } from "./provider.js";

export type { TicketProvider } from "./provider.js";
export { LinearProvider } from "./linear-provider.js";

export function providerFor(_target: TargetRepo): TicketProvider {
  return new LinearProvider();
}
