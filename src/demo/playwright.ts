import { runDeterministicDemo } from "../runtime/demo.js";

await Promise.all([
  runDeterministicDemo(["--port", "4244"], { openBrowser: false }),
  runDeterministicDemo(["--port", "4245"], { openBrowser: false }),
]);
