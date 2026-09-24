import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerUnlimiter } from "./src/extension.ts";

export default function (pi: ExtensionAPI) {
  registerUnlimiter(pi, join(getAgentDir(), "output-unlimiter.json"));
}
