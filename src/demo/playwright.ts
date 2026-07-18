import { runDeterministicDemo } from "../runtime/demo.js";

await Promise.all([
  runDeterministicDemo(["--port", "4244"]),
  runDeterministicDemo(["--port", "4245"]),
]);
