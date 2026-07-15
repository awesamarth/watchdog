import React from "react";
import { render } from "ink";
import { WatchdogTui } from "./app.js";

export async function runTui(): Promise<void> {
  const instance = render(<WatchdogTui />, { alternateScreen: true });
  await instance.waitUntilExit();
}
