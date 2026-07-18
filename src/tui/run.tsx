import React from "react";
import { render } from "ink";
import { WatchdogTui } from "./app.js";

export async function runTui(runId?: string): Promise<void> {
  const instance = render(<WatchdogTui runId={runId} />, { alternateScreen: true });
  await instance.waitUntilExit();
}
